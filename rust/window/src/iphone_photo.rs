//! The iPhone shutter.
//!
//! Pressing Photo asks macOS to open the Camera app on the nearby iPhone
//! (Continuity Camera). The person presses the shutter on the phone, then
//! Use Photo. macOS hands the picture back through the menu responder chain.

use std::cell::{Cell, RefCell};
use std::ffi::c_float;
use std::sync::Mutex;

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
    /// The Take Photo item found while the menu was opening.
    static CHOSEN: RefCell<Option<(Retained<NSMenu>, isize)>> = const { RefCell::new(None) };
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
            if !ARMED.with(Cell::get) {
                return;
            }
            if let Some(found) = find_shutter(menu) {
                CHOSEN.with(|slot| *slot.borrow_mut() = Some(found));
            }
            menu.cancelTracking();
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
    window.makeFirstResponder(Some(catcher));
    ARMED.with(|flag| flag.set(true));
    CHOSEN.with(|slot| *slot.borrow_mut() = None);

    menu.update();
    if CHOSEN.with(|slot| slot.borrow().is_none()) {
        if let Some(found) = find_shutter(menu) {
            CHOSEN.with(|slot| *slot.borrow_mut() = Some(found));
        }
    }
    if CHOSEN.with(|slot| slot.borrow().is_none()) {
        if let Some(event) = mouse_down(window) {
            NSMenu::popUpContextMenu_withEvent_forView(menu, &event, view);
        }
    }
    ARMED.with(|flag| flag.set(false));

    let chosen = CHOSEN.with(|slot| slot.borrow_mut().take());
    let started = if let Some((menu, index)) = chosen {
        menu.performActionForItemAtIndex(index);
        true
    } else {
        eprintln!("iPhone shutter was not offered. Menu was: {}", menu_titles(menu));
        false
    };
    window.makeFirstResponder(previous.as_deref());
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

/// The enabled "Take Photo" row, not "Scan Documents" and not our placeholder.
fn find_shutter(menu: &NSMenu) -> Option<(Retained<NSMenu>, isize)> {
    let items = menu.itemArray();
    for i in 0..items.count() {
        let item = items.objectAtIndex(i);
        let title = item.title().to_string().to_lowercase();
        if item.isEnabled() && is_shutter(&title) && item.action().is_some() {
            let kept = unsafe { Retained::retain(menu as *const NSMenu as *mut NSMenu) }?;
            return Some((kept, i as isize));
        }
        if let Some(sub) = item.submenu() {
            sub.update();
            if let Some(found) = find_shutter(&sub) {
                return Some(found);
            }
        }
    }
    None
}

fn is_shutter(title: &str) -> bool {
    !title.contains("scan") && (title.contains("take photo") || title.contains("take picture"))
}

fn menu_titles(menu: &NSMenu) -> String {
    let mut lines = Vec::new();
    collect_titles(menu, 0, &mut lines);
    lines.join(" | ")
}

fn collect_titles(menu: &NSMenu, depth: usize, out: &mut Vec<String>) {
    let items = menu.itemArray();
    for i in 0..items.count() {
        let item = items.objectAtIndex(i);
        out.push(format!("{}{}", " ".repeat(depth), item.title()));
        if let Some(sub) = item.submenu() {
            collect_titles(&sub, depth + 1, out);
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
