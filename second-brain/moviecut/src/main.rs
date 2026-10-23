//! Reads one movie order as JSON on stdin and prints one JSON reply.
//!
//! The voice app (second-brain/movies.js) is the only caller. Example:
//! `moviecut apply --root ~/.brain/movies` with `{"op":"status"}` on stdin.

use std::env;
use std::io::{self, Read};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_default();
    if command != "apply" {
        eprintln!("Usage: moviecut apply --root <folder>");
        return ExitCode::from(2);
    }
    let mut root: Option<String> = None;
    while let Some(arg) = args.next() {
        if arg == "--root" {
            root = args.next();
        }
    }
    let Some(root) = root else {
        eprintln!("moviecut needs --root, the folder where movies are saved.");
        return ExitCode::from(2);
    };

    let mut stdin = String::new();
    if io::stdin().read_to_string(&mut stdin).is_err() {
        println!(r#"{{"ok":false,"error":"The movie order could not be read."}}"#);
        return ExitCode::from(1);
    }

    // apply() already explains a bad order in plain words. A crash is the only other failure.
    match moviecut::apply(&PathBuf::from(root), &stdin) {
        Ok(reply) => {
            println!("{reply}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", serde_json::json!({ "ok": false, "error": error }));
            ExitCode::from(1)
        }
    }
}
