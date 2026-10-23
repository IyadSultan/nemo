//! Captions on the screen while it records: a see-through strip at the bottom of
//! the main screen, above every window. The page (screentab.js) sends each line as
//! it is heard. The strip is not in the recording and not on a shared screen
//! (content protection).
//!
//! The dark box fills the window (a see-through part of a window still catches
//! clicks), and the window goes when the box fades, so clicks reach the windows below.
//! The dark box has a small recap button (✦). It sends "recap" to the app, the page
//! writes the recap, and it comes back here as {recap: text}: the same window grows
//! into a panel over most of the screen, which scrolls and closes with ✕.

use serde_json::Value;
use std::cell::Cell;
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event_loop::EventLoopWindowTarget;
use tao::window::{Window, WindowBuilder};
use wry::{WebView, WebViewBuilder};

const HEIGHT: f64 = 130.0;
const ABOVE_BOTTOM: f64 = 90.0;

const HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; background: transparent; overflow: hidden; }
body { height: 100vh; font: 600 26px/1.3 -apple-system, "Helvetica Neue", sans-serif; color: #fff; }
#box { height: 100%; box-sizing: border-box; padding: 10px 14px 10px 22px; border-radius: 16px; background: rgba(10, 12, 16, 0.78); display: flex; align-items: center; gap: 14px; opacity: 0; transition: opacity 0.25s; }
#box.on { opacity: 1; }
#lines { flex: 1; min-width: 0; text-align: center; }
#prev { font-size: 19px; font-weight: 500; color: rgba(255, 255, 255, 0.65); margin-bottom: 4px; }
#now, #prev { unicode-bidi: plaintext; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); }
button { flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%; background: rgba(255, 255, 255, 0.16); color: #fff; font: 15px/28px -apple-system, sans-serif; cursor: pointer; }
button:hover { background: rgba(255, 255, 255, 0.3); }
#panel { display: none; position: fixed; inset: 0; box-sizing: border-box; flex-direction: column; border-radius: 18px; background: rgba(10, 12, 16, 0.94); }
body.recap #box { display: none; }
body.recap #panel { display: flex; }
#head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px 10px 28px; font-size: 22px; }
#text { flex: 1; overflow-y: auto; padding: 4px 28px 28px; font: 500 20px/1.55 -apple-system, "Helvetica Neue", sans-serif; white-space: pre-wrap; unicode-bidi: plaintext; text-align: start; }
#text.busy { color: rgba(255, 255, 255, 0.6); }
</style></head><body><div id="box"><div id="lines"><div id="prev"></div><div id="now"></div></div><button id="ask" title="Recap so far">✦</button></div>
<div id="panel"><div id="head"><span>Recap</span><button id="close" title="Close">✕</button></div><div id="text"></div></div><script>
let timer;
const $ = (id) => document.getElementById(id);
// A long silence: the last words fade out, and the window goes so it does not catch clicks.
const fadeLater = () => {
  clearTimeout(timer);
  timer = setTimeout(() => { $("box").classList.remove("on"); window.ipc.postMessage("faded"); }, 12000);
};
window.show = (line) => {
  if (line.recap != null) {
    $("text").textContent = line.recap;
    $("text").classList.toggle("busy", Boolean(line.busy));
    $("text").scrollTop = 0;
    document.body.classList.add("recap");
    clearTimeout(timer);
    return;
  }
  $("prev").textContent = line.prev || "";
  $("now").textContent = line.text || "";
  $("box").classList.add("on");
  if (!document.body.classList.contains("recap")) fadeLater();
};
// Back to the strip, with the last line showing for a while.
window.closeRecap = () => {
  document.body.classList.remove("recap");
  $("box").classList.add("on");
  fadeLater();
};
window.clear = () => { clearTimeout(timer); document.body.classList.remove("recap"); $("box").classList.remove("on"); };
$("ask").onclick = () => window.ipc.postMessage("recap");
$("close").onclick = () => window.ipc.postMessage("recap-close");
</script></body></html>"#;

pub struct Overlay {
    window: Window,
    view: WebView,
    /// Where the strip goes, and where the recap panel goes (points).
    strip: (LogicalPosition<f64>, LogicalSize<f64>),
    panel: (LogicalPosition<f64>, LogicalSize<f64>),
    recap_open: Cell<bool>,
}

impl Overlay {
    /// Made the first time captions are shown. None if the window could not be made.
    /// `on_message` gets what the strip sends: "recap", "recap-close", "faded".
    pub fn new<T>(target: &EventLoopWindowTarget<T>, on_message: impl Fn(String) + 'static) -> Option<Overlay> {
        let (sw, sh, sx, sy) = target
            .primary_monitor()
            .map(|m| {
                let scale = m.scale_factor();
                let size = m.size().to_logical::<f64>(scale);
                let at = m.position().to_logical::<f64>(scale);
                (size.width, size.height, at.x, at.y)
            })
            .unwrap_or((1440.0, 900.0, 0.0, 0.0));
        let width = (sw - 80.0).min(960.0);
        let strip = (LogicalPosition::new(sx + (sw - width) / 2.0, sy + sh - HEIGHT - ABOVE_BOTTOM), LogicalSize::new(width, HEIGHT));
        let (pw, ph) = (sw * 0.8, sh * 0.75);
        let panel = (LogicalPosition::new(sx + (sw - pw) / 2.0, sy + (sh - ph) / 2.0), LogicalSize::new(pw, ph));
        let window = WindowBuilder::new()
            .with_title("Captions")
            .with_decorations(false)
            .with_transparent(true)
            .with_always_on_top(true)
            .with_resizable(false)
            .with_focusable(false)
            .with_focused(false)
            .with_visible_on_all_workspaces(true)
            .with_content_protection(true)
            .with_inner_size(strip.1)
            .with_position(strip.0)
            .build(target)
            .ok()?;
        let view = WebViewBuilder::new()
            .with_transparent(true)
            .with_accept_first_mouse(true)
            .with_html(HTML)
            .with_ipc_handler(move |req| on_message(req.body().clone()))
            .build(&window)
            .ok()?;
        Some(Overlay { window, view, strip, panel, recap_open: Cell::new(false) })
    }

    /// A caption line, or {recap: text} (with busy while it is being written).
    pub fn show(&self, line: &Value) {
        if line.get("recap").is_some() && !self.recap_open.replace(true) {
            self.window.set_outer_position(self.panel.0);
            self.window.set_inner_size(self.panel.1);
        }
        let _ = self.view.evaluate_script(&format!("show({line})"));
        self.window.set_visible(true);
    }

    /// ✕ on the recap panel: back to the strip.
    pub fn close_recap(&self) {
        if !self.recap_open.replace(false) {
            return;
        }
        self.window.set_inner_size(self.strip.1);
        self.window.set_outer_position(self.strip.0);
        let _ = self.view.evaluate_script("closeRecap()");
    }

    /// The strip faded out after a silence. A see-through window must not catch clicks.
    pub fn faded(&self) {
        if !self.recap_open.get() {
            self.window.set_visible(false);
        }
    }

    pub fn hide(&self) {
        let _ = self.view.evaluate_script("clear()");
        if self.recap_open.replace(false) {
            self.window.set_inner_size(self.strip.1);
            self.window.set_outer_position(self.strip.0);
        }
        self.window.set_visible(false);
    }
}
