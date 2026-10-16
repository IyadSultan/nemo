//! The iPhone shutter.
//!
//! Pressing Photo asks macOS to open the Camera app on the nearby iPhone
//! (Continuity Camera). The person presses the shutter on the phone, then
//! Use Photo. macOS hands the picture back through the menu responder chain.

use std::cell::{Cell, RefCell};
use std::ffi::c_float;
use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;

use dispatch2::{DispatchQueue, DispatchTime};
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventModifierFlags, NSEventType, NSImage,
    NSImageCompressionFactor, NSMenu, NSMenuDelegate, NSMenuItem, NSMenuItemImportFromDeviceIdentifier, NSPasteboard,
    NSResponder, NSUserInterfaceItemIdentification, NSView, NSWindow,
};
use objc2_foundation::{
    ns_string, NSArray, NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString,
};

/// Called on the main thread with JPEG bytes when the phone sends a picture.
static SINK: Mutex<Option<Box<dyn Fn(Vec<u8>) + Send>>> = Mutex::new(None);

/// Addresses only. The objects live for the whole run of the app, on the main thread.
struct Live {
    catcher: usize,
    window: usize,
    view: usize,
    menu: usize,
}
static LIVE: Mutex<Option<Live>> = Mutex::new(None);

thread_local! {
    /// True only while Photo is opening the phone camera, so a normal File menu click is left alone.
    static ARMED: Cell<bool> = const { Cell::new(false) };
    /// The shutter command was sent while the menu was open.
    static FIRED: Cell<bool> = const { Cell::new(false) };
    /// Ignore a second open of the same menu.
    static SCHEDULED: Cell<bool> = const { Cell::new(false) };
    /// Stops the iPhone command from bouncing between this object and the app forever.
    static FORWARDING: Cell<bool> = const { Cell::new(false) };
    /// Who had the keyboard before Photo, given back when the picture arrives.
    static BEFORE: RefCell<Option<(Retained<NSWindow>, Option<Retained<NSResponder>>)>> = const { RefCell::new(None) };
    /// The menu already closed, so a late command must not run.
    static CLOSED: Cell<bool> = const { Cell::new(false) };
}

define_class!(
    #[unsafe(super(NSResponder))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    #[name = "SecondBrainPhotoCatcher"]
    struct PhotoCatcher;

    unsafe impl NSObjectProtocol for PhotoCatcher {}

    impl PhotoCatcher {
        #[unsafe(method_id(init))]
        fn init(this: Allocated<Self>) -> Retained<Self> {
            let this = this.set_ivars(());
            unsafe { msg_send![super(this), init] }
        }

        /// The window can only focus this object if we say yes.
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> Bool {
            true.into()
        }

        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> Bool {
            true.into()
        }

        /// macOS sends the iPhone command straight to this object and crashes if it is missing.
        /// The real work is done by the app object, so pass it on once.
        #[unsafe(method(importFromDevice:))]
        fn import_from_device(&self, sender: Option<&AnyObject>) {
            if FORWARDING.with(|flag| flag.replace(true)) {
                log_line("iPhone command came back again, stopping here");
                return;
            }
            log_line("iPhone command received, passing it to the app");
            let mtm = MainThreadMarker::from(self);
            let app = NSApplication::sharedApplication(mtm);
            let _: () = unsafe { msg_send![&*app, importFromDevice: sender] };
            FORWARDING.with(|flag| flag.set(false));
        }

        /// macOS asks every responder what it can receive. We accept pictures.
        #[unsafe(method(validRequestorForSendType:returnType:))]
        fn valid_requestor(&self, send_type: Option<&NSString>, return_type: Option<&NSString>) -> *mut AnyObject {
            if let Some(kind) = return_type {
                if NSImage::imageTypes().containsObject(kind) {
                    let kept = unsafe { Retained::retain(self as *const Self as *mut Self) }.expect("catcher");
                    return Retained::autorelease_return(unsafe { Retained::cast_unchecked::<AnyObject>(kept) });
                }
            }
            unsafe { msg_send![super(self), validRequestorForSendType: send_type, returnType: return_type] }
        }

        /// The picture from the iPhone arrives here, on the pasteboard.
        #[unsafe(method(readSelectionFromPasteboard:))]
        fn read_selection(&self, pasteboard: &NSPasteboard) -> Bool {
            log_line("picture arrived from the iPhone");
            // Give the keyboard back to the page now that the picture is here.
            if let Some((win, previous)) = BEFORE.with(|slot| slot.borrow_mut().take()) {
                win.makeFirstResponder(previous.as_deref());
            }
            let Some(image) = NSImage::initWithPasteboard(NSImage::alloc(), pasteboard) else {
                return false.into();
            };
            let Some(bytes) = jpeg_small(&image) else {
                return false.into();
            };
            if let Ok(guard) = SINK.lock() {
                if let Some(sink) = guard.as_ref() {
                    sink(bytes);
                }
            }
            true.into()
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    #[name = "SecondBrainPhotoMenu"]
    struct PhotoMenu;

    unsafe impl NSObjectProtocol for PhotoMenu {}

    unsafe impl NSMenuDelegate for PhotoMenu {
        #[unsafe(method(menuWillOpen:))]
        #[allow(non_snake_case)]
        fn menuWillOpen(&self, menu: &NSMenu) {
            // A normal click on File should just show the menu.
            if !ARMED.with(Cell::get) || SCHEDULED.with(Cell::get) {
                return;
            }
            SCHEDULED.with(|flag| flag.set(true));
            log_line(&format!("menu opened:\n{}", menu_tree(menu)));
            let Some(item) = find_shutter(menu) else {
                log_line("Take Photo was not in the menu");
                menu.cancelTrackingWithoutAnimation();
                return;
            };
            // Send the command on the next turn, while this menu is still open.
            // Sending it after the menu closes does not reach the iPhone.
            let item_ptr = hold(&*item);
            let menu_ptr = hold(menu);
            let safety_ptr = hold(menu);
            DispatchQueue::main().exec_async(move || {
                let item = take_hold::<NSMenuItem>(item_ptr);
                let menu = take_hold::<NSMenu>(menu_ptr);
                if CLOSED.with(Cell::get) {
                    log_line("shutter command arrived after the menu closed");
                    return;
                }
                let ok = invoke(&item);
                FIRED.with(|flag| flag.set(ok));
                menu.cancelTrackingWithoutAnimation();
            });
            let when = DispatchTime::try_from(Duration::from_millis(800)).unwrap_or(DispatchTime::NOW);
            let _ = DispatchQueue::main().after(when, move || {
                let menu = take_hold::<NSMenu>(safety_ptr);
                if FIRED.with(Cell::get) {
                    return;
                }
                CLOSED.with(|flag| flag.set(true));
                log_line("iPhone menu did not answer, closing it");
                menu.cancelTrackingWithoutAnimation();
            });
        }
    }

    impl PhotoMenu {
        #[unsafe(method_id(init))]
        fn init(this: Allocated<Self>) -> Retained<Self> {
            let this = this.set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }
);

/// Remember how to deliver a picture. Call this once, from the main thread.
pub fn on_photo(sink: impl Fn(Vec<u8>) + Send + 'static) {
    *SINK.lock().expect("photo sink") = Some(Box::new(sink));
}

/// `ns_window` is the native window from tao. Call once, after the menu bar exists.
pub fn install(ns_window: *mut std::ffi::c_void) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let window = unsafe { Retained::retain(ns_window as *mut NSWindow) };
    let Some(window) = window else {
        return;
    };
    let Some(content) = window.contentView() else {
        return;
    };

    let catcher: Retained<PhotoCatcher> = unsafe { msg_send![PhotoCatcher::alloc(mtm), init] };
    let next = unsafe { content.nextResponder() };
    unsafe { catcher.setNextResponder(next.as_deref()) };
    unsafe { content.setNextResponder(Some(&*catcher)) };

    let watch: Retained<PhotoMenu> = unsafe { msg_send![PhotoMenu::alloc(mtm), init] };
    let file_menu = add_file_menu(mtm, &watch);

    let catcher_addr = Retained::as_ptr(&catcher) as usize;
    let view_addr = Retained::as_ptr(&content) as usize;
    let window_addr = Retained::as_ptr(&window) as usize;
    let menu_addr = Retained::as_ptr(&file_menu) as usize;
    // The menu holds the watch weakly, and the view holds the catcher without retaining it.
    std::mem::forget(catcher);
    std::mem::forget(watch);
    std::mem::forget(window);

    *LIVE.lock().expect("photo install") = Some(Live {
        catcher: catcher_addr,
        window: window_addr,
        view: view_addr,
        menu: menu_addr,
    });
}

/// Open the Camera app on the iPhone. Returns false when the phone is not available.
pub fn take() -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let live = LIVE.lock().expect("photo take").as_ref().map(|live| Live {
        catcher: live.catcher,
        window: live.window,
        view: live.view,
        menu: live.menu,
    });
    let Some(live) = live else {
        return false;
    };
    let window = unsafe { &*(live.window as *const NSWindow) };
    let catcher = unsafe { &*(live.catcher as *const PhotoCatcher) };
    let view = unsafe { &*(live.view as *const NSView) };
    let menu = unsafe { &*(live.menu as *const NSMenu) };

    let previous = window.firstResponder();
    let focused = window.makeFirstResponder(Some(catcher));
    log_line(&format!("photo handler focused={focused}"));
    ARMED.with(|flag| flag.set(true));
    FIRED.with(|flag| flag.set(false));
    SCHEDULED.with(|flag| flag.set(false));
    CLOSED.with(|flag| flag.set(false));
    let _ = std::fs::write(LOG, "");
    log_line("opening the iPhone camera");

    // The phone is offered only while this menu is open, and only if we can receive a picture.
    menu.update();
    if let Some(event) = mouse_down(window) {
        NSMenu::popUpContextMenu_withEvent_forView(menu, &event, view);
    } else {
        log_line("could not open the menu");
    }
    CLOSED.with(|flag| flag.set(true));
    ARMED.with(|flag| flag.set(false));

    let started = FIRED.with(Cell::get);
    if !started {
        log_line(&format!("iPhone shutter was not started. Menu was:\n{}", menu_tree(menu)));
    }
    if started {
        let kept = unsafe { Retained::retain(window as *const NSWindow as *mut NSWindow) }.expect("window");
        BEFORE.with(|slot| *slot.borrow_mut() = Some((kept, previous)));
    } else {
        window.makeFirstResponder(previous.as_deref());
    }
    // When started, this object stays focused: the picture arrives seconds later
    // and only goes to whatever is focused then. A click on the page takes focus back.
    let _ = mtm;
    started
}

/// A data URL the page can show. The bytes are a JPEG we made.
pub fn data_url(jpeg: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", base64(jpeg))
}

fn add_file_menu(mtm: MainThreadMarker, watch: &PhotoMenu) -> Retained<NSMenu> {
    let app = NSApplication::sharedApplication(mtm);
    let main = app.mainMenu().expect("menu bar");
    let file_item = NSMenuItem::new(mtm);
    file_item.setTitle(ns_string!("File"));
    let file_menu = NSMenu::new(mtm);
    file_menu.setTitle(ns_string!("File"));
    let camera = NSMenuItem::new(mtm);
    // AppKit replaces this title with "Import from iPhone" once a phone is nearby.
    camera.setTitle(ns_string!("Take Picture"));
    camera.setIdentifier(Some(unsafe { &*NSMenuItemImportFromDeviceIdentifier }));
    file_menu.addItem(&camera);
    file_item.setSubmenu(Some(&file_menu));
    file_menu.setDelegate(Some(ProtocolObject::from_ref(watch)));
    // After the app menu, so File sits where people expect it.
    let at = if main.numberOfItems() > 0 { 1 } else { 0 };
    main.insertItem_atIndex(&file_item, at);
    file_menu
}

fn mouse_down(window: &NSWindow) -> Option<Retained<NSEvent>> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDown,
        NSPoint::new(8.0, 8.0),
        NSEventModifierFlags::empty(),
        0.0,
        window.windowNumber(),
        None,
        1,
        1,
        1.0 as c_float,
    )
}

const LOG: &str = "/tmp/second-brain-photo.log";

fn log_line(line: &str) {
    eprintln!("{line}");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(LOG) {
        let _ = writeln!(file, "{line}");
    }
}

/// Keep an extra hold so the object is still alive when the next turn runs.
fn hold<T: objc2::Message>(obj: &T) -> usize {
    let kept = unsafe { Retained::retain(obj as *const T as *mut T) }.expect("retain");
    let ptr = Retained::as_ptr(&kept) as usize;
    std::mem::forget(kept);
    ptr
}

fn take_hold<T: objc2::Message>(ptr: usize) -> Retained<T> {
    unsafe { Retained::from_raw(ptr as *mut T) }.expect("held object")
}

/// Tell the open menu to start the iPhone camera.
fn invoke(item: &NSMenuItem) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let action = item.action().map(|sel| sel.name().to_string_lossy().into_owned()).unwrap_or_else(|| "-".into());
    let target = item
        .target()
        .map(|obj| obj.class().name().to_string_lossy().into_owned())
        .unwrap_or_else(|| "nil".into());
    log_line(&format!("shutter item \"{}\" action={action} target={target} enabled={}", item.title(), item.isEnabled()));
    let Some(menu) = (unsafe { item.menu() }) else {
        log_line("shutter item has no menu");
        return false;
    };
    let index = menu.indexOfItem(item);
    if index < 0 {
        log_line("shutter item is not in its menu");
        return false;
    }
    if let Some(win) = NSApplication::sharedApplication(mtm).keyWindow() {
        if let Some(addr) = LIVE.lock().ok().and_then(|live| live.as_ref().map(|live| live.catcher)) {
            let catcher = unsafe { &*(addr as *const PhotoCatcher) };
            let focused = win.makeFirstResponder(Some(catcher));
            let who = win
                .firstResponder()
                .map(|obj| obj.class().name().to_string_lossy().into_owned())
                .unwrap_or_else(|| "nil".into());
            log_line(&format!("focused={focused} first={who}"));
        }
    }
    menu.performActionForItemAtIndex(index);
    true
}

/// The enabled "Take Photo" row. Skip anything that only opens another menu.
fn find_shutter(menu: &NSMenu) -> Option<Retained<NSMenuItem>> {
    let items = menu.itemArray();
    for i in 0..items.count() {
        let item = items.objectAtIndex(i);
        if let Some(sub) = item.submenu() {
            sub.update();
            if let Some(found) = find_shutter(&sub) {
                return Some(found);
            }
            continue;
        }
        if is_shutter(&item) {
            return Some(item);
        }
    }
    None
}

fn is_shutter(item: &NSMenuItem) -> bool {
    if item.submenu().is_some() || item.isHidden() || !item.isEnabled() || item.action().is_none() {
        return false;
    }
    let title = item.title().to_string().to_lowercase();
    !title.contains("scan") && (title.contains("take photo") || title.contains("take picture"))
}

fn menu_tree(menu: &NSMenu) -> String {
    let mut lines = Vec::new();
    collect_tree(menu, 0, &mut lines);
    if lines.is_empty() { "(empty)".to_string() } else { lines.join("\n") }
}

fn collect_tree(menu: &NSMenu, depth: usize, out: &mut Vec<String>) {
    let items = menu.itemArray();
    for i in 0..items.count() {
        let item = items.objectAtIndex(i);
        let action = item.action().map(|sel| sel.name().to_string_lossy().into_owned()).unwrap_or_else(|| "-".into());
        let target = item
            .target()
            .map(|obj| obj.class().name().to_string_lossy().into_owned())
            .unwrap_or_else(|| "nil".into());
        out.push(format!(
            "{}{} enabled={} action={action} target={target}",
            "  ".repeat(depth),
            item.title(),
            item.isEnabled()
        ));
        if let Some(sub) = item.submenu() {
            collect_tree(&sub, depth + 1, out);
        }
    }
}

/// A JPEG no wider or taller than 1280 pixels, so the chat can hold it.
#[allow(deprecated)]
fn jpeg_small(image: &NSImage) -> Option<Vec<u8>> {
    let size = image.size();
    if size.width < 1.0 || size.height < 1.0 {
        return None;
    }
    let longest = size.width.max(size.height);
    let scale = if longest > 1280.0 { 1280.0 / longest } else { 1.0 };
    let w = (size.width * scale).round().max(1.0);
    let h = (size.height * scale).round().max(1.0);
    let small = NSImage::initWithSize(NSImage::alloc(), NSSize::new(w, h));
    small.lockFocus();
    image.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, h)));
    let rep = NSBitmapImageRep::initWithFocusedViewRect(
        NSBitmapImageRep::alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, h)),
    );
    small.unlockFocus();
    let rep = rep?;
    let factor = NSNumber::numberWithDouble(0.72);
    let objects = NSArray::from_slice(&[factor.as_ref() as &AnyObject]);
    let key = ProtocolObject::from_ref(unsafe { &*NSImageCompressionFactor });
    let keys = NSArray::from_slice(&[key]);
    let props = unsafe { NSDictionary::dictionaryWithObjects_forKeys(&objects, &keys) };
    let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &props) }?;
    Some(data.to_vec())
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    if i < bytes.len() {
        let b0 = bytes[i] as u32;
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if i + 1 < bytes.len() {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        out.push('=');
    }
    out
}
