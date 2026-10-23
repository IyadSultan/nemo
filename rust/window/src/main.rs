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
//! The Browser tab: a second WebKit view (src/pane.rs) sits over the tab's empty area.
//! You can browse in it, and the browser agent drives it through the Rust server.
//!
//! `second-brain --probe` opens the page hidden, checks which browser features
//! work inside this window, prints them as JSON, and exits. (It does not open
//! the microphone, so no permission prompt appears.)

use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use std::cell::RefCell;
use std::net::TcpStream;
use std::path::PathBuf;
use std::rc::Rc;
use std::fs::File;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tao::{
    dpi::{LogicalPosition, LogicalSize, PhysicalPosition},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::macos::WindowExtMacOS,
    window::{Fullscreen, Window, WindowBuilder},
};
use serde_json::{json, Value};
use std::sync::Arc;
use wry::{NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse, Rect, WebViewBuilder};

mod captions;
mod iphone_photo;
mod pane;

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
/// Returns the menu, the Reload item (Command-R loads page updates)
/// and the Browser item (Shift-Command-B switches between the Browser tab and the chat).
fn menu_bar() -> (Menu, MenuItem, MenuItem) {
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
    let browser = MenuItem::new("Browser or Chat", true, Some("CmdOrCtrl+Shift+B".parse().unwrap()));
    let view = Submenu::with_items("View", true, &[&reload, &browser]).unwrap();
    let window = Submenu::with_items(
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(None), &PredefinedMenuItem::fullscreen(None), &PredefinedMenuItem::close_window(None)],
    )
    .unwrap();
    (Menu::with_items(&[&app, &edit, &view, &window]).unwrap(), reload, browser)
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
    /// A command from the browser agent for the Browser tab (src/pane.rs).
    PaneCmd(Value),
    /// The page's Browser tab: where its view goes, or an address, back, forward, reload.
    PanePage(Value),
    /// The Browser tab's page started (false) or finished (true) loading this address.
    PaneLoaded(String, bool),
    PaneTitle(String),
    /// A link in the Browser tab asked for a new window; it opens in the tab instead.
    PaneOpen(String),
    /// Captions on the screen while it records: a line to show, or {"hide": true}.
    Captions(Value),
    /// What the caption strip sends: "recap" (its ✦), "recap-close" (✕ on the panel), "faded".
    Strip(String),
}

/// Start the screen recorder. This window already has permission to record the
/// screen (the same permission Snapshot uses). The background server does not,
/// so the window is the one that starts the recorder.
fn start_screen(cmd: &Value) {
    let Some(bin) = cmd.get("bin").and_then(|v| v.as_str()) else { return };
    let Some(capture) = cmd.get("capture").and_then(|v| v.as_str()) else { return };
    let Some(out) = cmd.get("out").and_then(|v| v.as_str()) else { return };
    let Some(err) = cmd.get("err").and_then(|v| v.as_str()) else { return };
    let lang = match cmd.get("lang").and_then(|v| v.as_str()) {
        Some("ar") => "ar",
        _ => "en",
    };
    let bin_path = PathBuf::from(bin);
    let capture_path = PathBuf::from(capture);
    let out_path = PathBuf::from(out);
    let err_path = PathBuf::from(err);
    let ok_name = bin_path.file_name().and_then(|name| name.to_str()) == Some("screenrec");
    let ok_file = capture_path.file_name().and_then(|name| name.to_str()) == Some("capture.mp4");
    let in_recordings = capture.contains("/recordings/");
    let same_dir = capture_path.parent().is_some() && capture_path.parent() == out_path.parent() && capture_path.parent() == err_path.parent();
    if !ok_name || !ok_file || !in_recordings || !same_dir {
        let _ = std::fs::write(&err_path, "The recorder was not started.\n");
        return;
    }
    let Ok(stdout) = File::create(&out_path) else { return };
    let Ok(stderr) = File::create(&err_path) else { return };
    match Command::new(&bin_path)
        .arg(&capture_path)
        .arg(lang)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
    {
        Ok(mut child) => {
            let _ = child.wait();
        }
        Err(error) => {
            let _ = std::fs::write(&err_path, format!("The recorder could not be started. {error}\n"));
        }
    }
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
/// Kept in points, not pixels: restoring pixels while Tiny is showing used the wrong scale
/// and brought the app back at half size (the narrow phone layout).
fn go_tiny(window: &Window) -> Option<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let monitor = window.current_monitor()?;
    let scale = monitor.scale_factor();
    let was = (window.outer_position().ok()?.to_logical(scale), window.inner_size().to_logical(scale));
    // Resizable first: tao builds the frame from it, and applies the frame later.
    window.set_resizable(false);
    window.set_decorations(false);
    window.set_has_shadow(false);
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
fn go_full(window: &Window, was: (LogicalPosition<f64>, LogicalSize<f64>)) {
    window.set_always_on_top(false);
    // Resizable before the frame comes back, or the late frame drops it and the green button stops working.
    window.set_resizable(true);
    window.set_decorations(true);
    window.set_has_shadow(true);
    window.set_min_inner_size(Some(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1)));
    window.set_inner_size(was.1);
    window.set_outer_position(was.0);
    window.set_focus();
}

fn main() -> wry::Result<()> {
    let probe = std::env::args().any(|a| a == "--probe");
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let (menu, reload, browser) = menu_bar();
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
            // Screen recording. The page sends the file paths. This window starts
            // the recorder so macOS allows it (same permission as Snapshot).
            if let Some(rest) = req.body().strip_prefix("screen-start ") {
                if let Ok(v) = serde_json::from_str::<Value>(rest) {
                    std::thread::spawn(move || start_screen(&v));
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
            // Captions on the screen: "captions {json}".
            if let Some(rest) = req.body().strip_prefix("captions ") {
                if let Ok(v) = serde_json::from_str(rest) {
                    let _ = proxy.send_event(UserEvent::Captions(v));
                }
                return;
            }
            // The Browser tab: "browser {json}".
            if let Some(rest) = req.body().strip_prefix("browser ") {
                if let Ok(v) = serde_json::from_str(rest) {
                    let _ = proxy.send_event(UserEvent::PanePage(v));
                }
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

    // The Browser tab's view, hidden until the tab says where it goes.
    let pane_proxy = event_loop.create_proxy();
    let (load_proxy, title_proxy) = (event_loop.create_proxy(), event_loop.create_proxy());
    let pane = WebViewBuilder::new()
        .with_url("about:blank")
        .with_visible(false)
        .with_bounds(Rect { position: LogicalPosition::new(0.0, 0.0).into(), size: LogicalSize::new(10.0, 10.0).into() })
        .with_accept_first_mouse(true)
        .with_initialization_script(pane::INIT)
        .with_on_page_load_handler(move |ev, url| {
            let _ = load_proxy.send_event(UserEvent::PaneLoaded(url, matches!(ev, PageLoadEvent::Finished)));
        })
        .with_document_title_changed_handler(move |title| {
            let _ = title_proxy.send_event(UserEvent::PaneTitle(title));
        })
        .with_new_window_req_handler(move |url, _| {
            let _ = pane_proxy.send_event(UserEvent::PaneOpen(url));
            NewWindowResponse::Deny
        })
        .build_as_child(&window)?;
    let replies: pane::Replies = Arc::default();
    if !probe {
        let cmd_proxy = event_loop.create_proxy();
        pane::connect(replies.clone(), move |cmd| {
            let _ = cmd_proxy.send_event(UserEvent::PaneCmd(cmd));
        });
    }
    // Where the Browser tab's area is (points, inside the window), while it shows.
    let mut pane_at: Option<(f64, f64, f64, f64)> = None;
    let mut covered = false;

    // The iPhone shutter hands its picture to the page.
    iphone_photo::install(window.ns_window());
    let photo_proxy = event_loop.create_proxy();
    iphone_photo::on_photo(move |bytes| {
        let _ = photo_proxy.send_event(UserEvent::PhonePhoto(bytes));
    });

    // Where the full window was, while Tiny is showing.
    let mut full_window = None;
    // The caption strip, made the first time a line is shown.
    let mut overlay: Option<captions::Overlay> = None;
    let strip_proxy = event_loop.create_proxy();
    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Tiny(true)) if full_window.is_none() => {
                full_window = go_tiny(&window);
                covered = true;
                let _ = pane.set_visible(false);
            }
            Event::UserEvent(UserEvent::Tiny(false)) => {
                if let Some(was) = full_window.take() {
                    go_full(&window, was);
                }
                covered = false;
                let _ = pane.set_visible(pane_at.is_some());
            }
            Event::UserEvent(UserEvent::Fullscreen(on)) => {
                window.set_fullscreen(on.then_some(Fullscreen::Borderless(None)));
                // A deck being presented covers everything, the Browser tab too.
                covered = on;
                let _ = pane.set_visible(!on && pane_at.is_some());
            }
            Event::UserEvent(UserEvent::PanePage(v)) => {
                if let Some(b) = v.get("bounds") {
                    let n = |k: &str| b[k].as_f64().unwrap_or(0.0);
                    let at = (n("x"), n("y"), n("w").max(1.0), n("h").max(1.0));
                    let _ = pane.set_bounds(Rect { position: LogicalPosition::new(at.0, at.1).into(), size: LogicalSize::new(at.2, at.3).into() });
                    pane_at = Some(at);
                    let _ = pane.set_visible(!covered);
                } else if v["hide"] == true {
                    pane_at = None;
                    let _ = pane.set_visible(false);
                } else if let Some(url) = v["go"].as_str() {
                    let _ = pane.load_url(url);
                } else if let Some(step) = v["history"].as_str() {
                    let _ = match step {
                        "back" => pane.evaluate_script("history.back()"),
                        "forward" => pane.evaluate_script("history.forward()"),
                        _ => pane.reload(),
                    };
                }
            }
            Event::UserEvent(UserEvent::PaneCmd(cmd)) => {
                let id = cmd["id"].clone();
                match cmd["op"].as_str().unwrap_or("") {
                    "eval" => {
                        let back = replies.clone();
                        let done = pane.evaluate_script_with_callback(cmd["js"].as_str().unwrap_or(""), move |res| {
                            pane::reply(&back, &id, Ok(json!(res)));
                        });
                        if let Err(e) = done {
                            pane::reply(&replies, &cmd["id"], Err(e.to_string()));
                        }
                    }
                    "navigate" => {
                        let res = pane.load_url(cmd["url"].as_str().unwrap_or("about:blank")).map(|_| Value::Null).map_err(|e| e.to_string());
                        pane::reply(&replies, &id, res);
                    }
                    "show" => {
                        let _ = webview.evaluate_script("window.brainBrowser&&window.brainBrowser.openPanel()");
                        pane::reply(&replies, &id, Ok(Value::Null));
                    }
                    "screenshot" => {
                        let scale = window.scale_factor();
                        let (Some(at), Ok(inner)) = (pane_at, window.inner_position()) else {
                            pane::reply(&replies, &id, Err("The Browser tab is not showing.".into()));
                            return;
                        };
                        let origin = inner.to_logical::<f64>(scale);
                        let replies = replies.clone();
                        std::thread::spawn(move || {
                            pane::reply(&replies, &id, pane::screenshot(origin.x + at.0, origin.y + at.1, at.2, at.3));
                        });
                    }
                    other => pane::reply(&replies, &id, Err(format!("Unknown command {other}."))),
                }
            }
            Event::UserEvent(UserEvent::PaneLoaded(url, done)) => {
                let _ = webview.evaluate_script(&format!("window.brainBrowser&&window.brainBrowser.loaded({},{done})", json!(url)));
            }
            Event::UserEvent(UserEvent::PaneTitle(title)) => {
                let _ = webview.evaluate_script(&format!("window.brainBrowser&&window.brainBrowser.titled({})", json!(title)));
            }
            Event::UserEvent(UserEvent::PaneOpen(url)) => {
                let _ = pane.load_url(&url);
            }
            Event::UserEvent(UserEvent::Menu(id)) if id == *reload.id() => {
                let _ = webview.reload();
            }
            Event::UserEvent(UserEvent::Menu(id)) if id == *browser.id() => {
                let _ = webview.evaluate_script("window.brainBrowser&&window.brainBrowser.toggle()");
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
            Event::UserEvent(UserEvent::Captions(v)) => {
                if v["hide"] == true {
                    if let Some(strip) = &overlay {
                        strip.hide();
                    }
                } else {
                    if overlay.is_none() {
                        let proxy = strip_proxy.clone();
                        overlay = captions::Overlay::new(target, move |msg| {
                            let _ = proxy.send_event(UserEvent::Strip(msg));
                        });
                    }
                    if let Some(strip) = &overlay {
                        strip.show(&v);
                    }
                }
            }
            Event::UserEvent(UserEvent::Strip(msg)) => match msg.as_str() {
                // The page writes the recap and sends it back as {recap: text}.
                "recap" => {
                    let _ = webview.evaluate_script("window.screenStripRecap&&window.screenStripRecap()");
                }
                "recap-close" => {
                    if let Some(strip) = &overlay {
                        strip.close_recap();
                    }
                }
                "faded" => {
                    if let Some(strip) = &overlay {
                        strip.faded();
                    }
                }
                _ => {}
            },
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
