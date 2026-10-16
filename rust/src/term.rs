//! A real terminal for the page: a login shell in a pseudo-terminal,
//! carried over a WebSocket to xterm.js.
//!
//! Only the brain's own page may connect. The server listens on 127.0.0.1,
//! and the Host and Origin headers must both name this server, so another
//! website open in the browser (or a DNS-rebinding trick) cannot start a shell.
//!
//! From the page: binary frames are keystrokes, a text frame
//! `{"cols":80,"rows":24}` is a resize. To the page: binary frames of output.

use axum::extract::ws::{Message, WebSocket};
use axum::http::{header, HeaderMap};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use tokio::sync::mpsc;

/// The page is ours when Host and Origin both name this server on this port.
pub fn allowed(headers: &HeaderMap, port: u16) -> bool {
    let get = |h: header::HeaderName| headers.get(h).and_then(|v| v.to_str().ok()).unwrap_or("");
    let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let host = get(header::HOST);
    let origin = get(header::ORIGIN);
    hosts.iter().any(|h| h == host) && hosts.iter().any(|h| origin == format!("http://{h}"))
}

#[derive(serde::Deserialize)]
struct Resize {
    cols: u16,
    rows: u16,
}

/// Run one shell for one WebSocket. The shell is killed when the page closes.
pub async fn serve(mut socket: WebSocket) {
    let pty = match native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("Could not open a terminal: {err}");
            let _ = socket.send(Message::Binary(format!("Could not open a terminal: {err}\r\n").into())).await;
            return;
        }
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // An API key here would make `claude` bill the API instead of the subscription.
    cmd.env_remove("ANTHROPIC_API_KEY");
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    let mut child = match pty.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Could not start the shell: {err}");
            let _ = socket.send(Message::Binary(format!("Could not start the shell: {err}\r\n").into())).await;
            return;
        }
    };
    drop(pty.slave);
    let (Ok(mut reader), Ok(mut writer)) = (pty.master.try_clone_reader(), pty.master.take_writer()) else {
        let _ = child.kill();
        return;
    };

    // The pty is blocking, so it is read and written on its own threads.
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for bytes in in_rx {
            if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(bytes) => {
                    if socket.send(Message::Binary(bytes.into())).await.is_err() { break; }
                }
                // The shell ended (exit, or it was closed).
                None => {
                    let _ = socket.send(Message::Binary("\r\n[The shell ended.]\r\n".as_bytes().to_vec().into())).await;
                    break;
                }
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Binary(bytes))) => { let _ = in_tx.send(bytes.to_vec()); }
                Some(Ok(Message::Text(text))) => {
                    if let Ok(r) = serde_json::from_str::<Resize>(&text) {
                        let size = PtySize { rows: r.rows.max(2), cols: r.cols.max(2), pixel_width: 0, pixel_height: 0 };
                        let _ = pty.master.resize(size);
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    let _ = child.kill();
    let _ = socket.send(Message::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(o) = origin {
            h.insert(header::ORIGIN, HeaderValue::from_str(o).unwrap());
        }
        h
    }

    #[test]
    fn only_our_own_page_may_open_a_shell() {
        assert!(allowed(&headers("127.0.0.1:3001", Some("http://127.0.0.1:3001")), 3001));
        assert!(allowed(&headers("localhost:3001", Some("http://localhost:3001")), 3001));
        // Another website, no Origin, a rebound host name, another port.
        assert!(!allowed(&headers("127.0.0.1:3001", Some("https://evil.example")), 3001));
        assert!(!allowed(&headers("127.0.0.1:3001", None), 3001));
        assert!(!allowed(&headers("evil.example:3001", Some("http://evil.example:3001")), 3001));
        assert!(!allowed(&headers("127.0.0.1:3001", Some("http://127.0.0.1:3009")), 3001));
    }
}
