//! The second brain in its own window: no Chrome, no browser tab.
//!
//! A native macOS window (tao) with the system web engine (WebKit, via wry)
//! showing the voice page from the Rust server on 127.0.0.1:3001.
//! The server keeps running in the background (launchd) when the window closes.
//!
//! Tiny mode: after 3 idle minutes the page (tinymode.js) sends "tiny", and the window
//! shrinks to Tiny alone (transparent, no frame or shadow) in the bottom-right corner, above other windows.
//! A click on Tiny sends "full", and the window comes back where it was.
//!
//! `second-brain --probe` opens the page hidden, checks which browser features
//! work inside this window, prints them as JSON, and exits. (It does not open
//! the microphone, so no permission prompt appears.)

use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use std::cell::RefCell;
use std::net::TcpStream;
use std::path::PathBuf;
use std::rc::Rc;
use std::process::Command;
use std::time::{Duration, Instant};
use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::macos::WindowExtMacOS,
    window::{Fullscreen, Window, WindowBuilder},
};
use wry::{NewWindowResponse, PermissionKind, PermissionResponse, WebViewBuilder};

mod iphone_photo;

const SERVER: &str = "127.0.0.1:3001";
const PAGE: &str = "http://127.0.0.1:3001/voice.html";
const SERVICE: &str = "com.iyad.talk-to-your-brain";
/// Tiny's window, and its gap from the screen's right and bottom edges (above the Dock).
const TINY: (f64, f64) = (200.0, 200.0);
const TINY_GAP: (f64, f64) = (24.0, 110.0);
const MIN_SIZE: (f64, f64) = (420.0, 480.0);

/// Checks run inside the page by --probe.
const PROBE: &str = r#"
window.addEventListener("load", async () => {
  const has = (f) => { try { return Boolean(f()); } catch { return false; } };
  const r = {
    webm_opus: has(() => MediaRecorder.isTypeSupported("audio/webm;codecs=opus")),
    webm: has(() => MediaRecorder.isTypeSupported("audio/webm")),
    mp4: has(() => MediaRecorder.isTypeSupported("audio/mp4")),
    speech_recognition: has(() => window.SpeechRecognition || window.webkitSpeechRecognition),
    speech_synthesis: has(() => window.speechSynthesis),
    webrtc: has(() => window.RTCPeerConnection),
    audio_worklet: has(() => new AudioContext().audioWorklet),
    get_user_media: has(() => navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    secure_context: window.isSecureContext,
  };
  window.ipc.postMessage(JSON.stringify(r));
});
"#;

fn server_up() -> bool {
    TcpStream::connect_timeout(&SERVER.parse().unwrap(), Duration::from_millis(500)).is_ok()
}

/// Start the background service if it is not answering; wait up to 30 seconds.
fn ensure_server() -> bool {
    if server_up() {
        return true;
    }
    let target = format!("gui/{}/{SERVICE}", unsafe { libc_getuid() });
    let _ = Command::new("/bin/launchctl").args(["kickstart", &target]).status();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if server_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

const NOT_RUNNING: &str = r#"<html><body style="font: 16px -apple-system; padding: 40px; color: #333">
<h2>The second brain is not running</h2>
<p>Run this in Terminal, then open the app again:</p>
<pre>launchctl kickstart -k gui/$(id -u)/com.iyad.talk-to-your-brain</pre>
</body></html>"#;

/// The macOS menu bar. The Edit menu makes copy and paste work in text boxes.
/// Returns the menu and the Reload item (Command-R loads page updates).
fn menu_bar() -> (Menu, MenuItem) {
    let app = Submenu::with_items(
        "Second Brain",
        true,
        &[
            &PredefinedMenuItem::about(None, None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::hide(None),
            &PredefinedMenuItem::hide_others(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::quit(None),
        ],
    )
    .unwrap();
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ],
    )
    .unwrap();
    let reload = MenuItem::new("Reload", true, Some("CmdOrCtrl+R".parse().unwrap()));
    let view = Submenu::with_items("View", true, &[&reload]).unwrap();
    let window = Submenu::with_items(
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(None), &PredefinedMenuItem::fullscreen(None), &PredefinedMenuItem::close_window(None)],
    )
    .unwrap();
    (Menu::with_items(&[&app, &edit, &view, &window]).unwrap(), reload)
}

enum UserEvent {
    ProbeDone(String),
    Menu(muda::MenuId),
    Tiny(bool),
    /// The page's presenter (deck.js) asks for full screen while a deck is showing.
    Fullscreen(bool),
    /// JPEG bytes from the iPhone shutter.
    PhonePhoto(Vec<u8>),
    /// The iPhone camera was not offered, so the page uses this Mac's camera instead.
    PhonePhotoMissing,
    /// JPEG bytes of the part of the screen the user dragged over. None when they pressed Esc.
    Snapshot(Option<Vec<u8>>),
}

/// Let the user drag over part of the screen; macOS draws the crosshair. Blocks until done.
fn snapshot() -> Option<Vec<u8>> {
    let file = std::env::temp_dir().join(format!("second-brain-snapshot-{}.jpg", std::process::id()));
    let ok = Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x", "-t", "jpg"])
        .arg(&file)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    let bytes = if ok { std::fs::read(&file).ok() } else { None };
    let _ = std::fs::remove_file(&file);
    bytes.filter(|jpeg| !jpeg.is_empty())
}

/// Shrink to Tiny in the bottom-right corner. Returns where the full window was.
fn go_tiny(window: &Window) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let was = (window.outer_position().ok()?, window.inner_size());
    let monitor = window.current_monitor()?;
    let scale = monitor.scale_factor();
    window.set_decorations(false);
    window.set_has_shadow(false);
    window.set_resizable(false);
    window.set_min_inner_size(None::<LogicalSize<f64>>);
    window.set_always_on_top(true);
    window.set_inner_size(LogicalSize::new(TINY.0, TINY.1));
    let (pos, size) = (monitor.position(), monitor.size());
    let x = pos.x + size.width as i32 - ((TINY.0 + TINY_GAP.0) * scale) as i32;
    let y = pos.y + size.height as i32 - ((TINY.1 + TINY_GAP.1) * scale) as i32;
    window.set_outer_position(PhysicalPosition::new(x, y));
    Some(was)
}

/// Back to the full window, where it was before.
fn go_full(window: &Window, was: (PhysicalPosition<i32>, PhysicalSize<u32>)) {
    window.set_always_on_top(false);
    window.set_decorations(true);
    window.set_has_shadow(true);
    window.set_resizable(true);
    window.set_min_inner_size(Some(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1)));
    window.set_inner_size(was.1);
    window.set_outer_position(was.0);
    window.set_focus();
}

fn main() -> wry::Result<()> {
    let probe = std::env::args().any(|a| a == "--probe");
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let (menu, reload) = menu_bar();
    menu.init_for_nsapp();
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        let _ = menu_proxy.send_event(UserEvent::Menu(e.id));
    }));

    let window = WindowBuilder::new()
        .with_title("Second Brain")
        .with_inner_size(LogicalSize::new(1180.0, 860.0))
        .with_min_inner_size(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1))
        .with_visible(!probe)
        // See-through where the page has no background: only Tiny shows in tiny mode.
        .with_transparent(true)
        .build(&event_loop)
        .unwrap();

    // Where the last download went, for the Finder.
    let saved: Rc<RefCell<Option<PathBuf>>> = Rc::new(RefCell::new(None));
    let builder = WebViewBuilder::new()
        // The first click on Tiny (window not active) must reach the page, not only focus the window.
        .with_accept_first_mouse(true)
        .with_transparent(true)
        // Speaking and photos need these; the page asks only when you use them.
        .with_permission_handler(|kind| match kind {
            PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        // The arrow in the PDF viewer saves into Downloads (wry picks a free name there),
        // then the Finder shows the file. Without these handlers the arrow does nothing.
        .with_download_started_handler({
            let saved = saved.clone();
            move |_url, path: &mut PathBuf| {
                *saved.borrow_mut() = Some(path.clone());
                true
            }
        })
        .with_download_completed_handler({
            let saved = saved.clone();
            move |_url, _path, ok| {
                if let (true, Some(file)) = (ok, saved.borrow().as_ref()) {
                    let _ = Command::new("/usr/bin/open").arg("-R").arg(file).spawn();
                }
            }
        })
        // Links that open a new window (Outlook web, sources) go to the default browser.
        .with_new_window_req_handler(|url, _| {
            let _ = Command::new("/usr/bin/open").arg(&url).spawn();
            NewWindowResponse::Deny
        })
        .with_ipc_handler(move |req| {
            // The shutter on the iPhone. Handled here so the phone camera opens immediately.
            if req.body() == "iphone-photo" {
                if !iphone_photo::take() {
                    let _ = proxy.send_event(UserEvent::PhonePhotoMissing);
                }
                return;
            }
            // Snapshot waits for the drag, so it runs off the main thread.
            if req.body() == "snapshot" {
                let proxy = proxy.clone();
                std::thread::spawn(move || {
                    let _ = proxy.send_event(UserEvent::Snapshot(snapshot()));
                });
                return;
            }
            let event = match req.body().as_str() {
                "tiny" => UserEvent::Tiny(true),
                "full" => UserEvent::Tiny(false),
                "fullscreen-on" => UserEvent::Fullscreen(true),
                "fullscreen-off" => UserEvent::Fullscreen(false),
                other => UserEvent::ProbeDone(other.to_string()),
            };
            let _ = proxy.send_event(event);
        });
    let builder = if probe { builder.with_initialization_script(PROBE) } else { builder };
    let builder = if ensure_server() { builder.with_url(PAGE) } else { builder.with_html(NOT_RUNNING) };
    let webview = builder.build(&window)?;

    // The iPhone shutter hands its picture to the page.
    iphone_photo::install(window.ns_window());
    let photo_proxy = event_loop.create_proxy();
    iphone_photo::on_photo(move |bytes| {
        let _ = photo_proxy.send_event(UserEvent::PhonePhoto(bytes));
    });

    // Where the full window was, while Tiny is showing.
    let mut full_window = None;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Tiny(true)) if full_window.is_none() => full_window = go_tiny(&window),
            Event::UserEvent(UserEvent::Tiny(false)) => {
                if let Some(was) = full_window.take() {
                    go_full(&window, was);
                }
            }
            Event::UserEvent(UserEvent::Fullscreen(on)) => {
                window.set_fullscreen(on.then_some(Fullscreen::Borderless(None)));
            }
            Event::UserEvent(UserEvent::Menu(id)) if id == *reload.id() => {
                let _ = webview.reload();
            }
            Event::UserEvent(UserEvent::PhonePhoto(jpeg)) => {
                let js = format!(
                    "window.receivePhonePhoto&&window.receivePhonePhoto(\"{}\")",
                    iphone_photo::data_url(&jpeg)
                );
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::Snapshot(jpeg)) => {
                let data = jpeg.map(|jpeg| iphone_photo::data_url(&jpeg)).unwrap_or_default();
                let js = format!("window.receiveSnapshot&&window.receiveSnapshot(\"{data}\")");
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::PhonePhotoMissing) => {
                let _ = webview.evaluate_script("window.phonePhotoUnavailable&&window.phonePhotoUnavailable()");
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::ProbeDone(json)) if probe => {
                println!("{json}");
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}
