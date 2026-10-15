//! The second brain in its own window: no Chrome, no browser tab.
//!
//! A native macOS window (tao) with the system web engine (WebKit, via wry)
//! showing the voice page from the Rust server on 127.0.0.1:3001.
//! The server keeps running in the background (launchd) when the window closes.
//!
//! `second-brain --probe` opens the page hidden, checks which browser features
//! work inside this window, prints them as JSON, and exits. (It does not open
//! the microphone, so no permission prompt appears.)

use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use std::net::TcpStream;
use std::process::Command;
use std::time::{Duration, Instant};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::{NewWindowResponse, PermissionKind, PermissionResponse, WebViewBuilder};

const SERVER: &str = "127.0.0.1:3001";
const PAGE: &str = "http://127.0.0.1:3001/voice.html";
const SERVICE: &str = "com.iyad.talk-to-your-brain";

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
        .with_min_inner_size(LogicalSize::new(420.0, 480.0))
        .with_visible(!probe)
        .build(&event_loop)
        .unwrap();

    let builder = WebViewBuilder::new()
        // Speaking and photos need these; the page asks only when you use them.
        .with_permission_handler(|kind| match kind {
            PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        // Links that open a new window (Outlook web, sources) go to the default browser.
        .with_new_window_req_handler(|url, _| {
            let _ = Command::new("/usr/bin/open").arg(&url).spawn();
            NewWindowResponse::Deny
        })
        .with_ipc_handler(move |req| {
            let _ = proxy.send_event(UserEvent::ProbeDone(req.body().to_string()));
        });
    let builder = if probe { builder.with_initialization_script(PROBE) } else { builder };
    let builder = if ensure_server() { builder.with_url(PAGE) } else { builder.with_html(NOT_RUNNING) };
    let webview = builder.build(&window)?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Menu(id)) if id == *reload.id() => {
                let _ = webview.reload();
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
