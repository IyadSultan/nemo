//! Golden test: Rust file opening must match `second-brain/openfile.js`.
//! Fixture comes from `node rust/tests/fixtures/gen_openfile.mjs`: the same home
//! tree, fake `mdfind`/`open` scripts, and steps are replayed here.

use nemo_realtime_voice::learnings::words;
use nemo_realtime_voice::openfile::*;
use serde_json::{json, Value};
use std::fs;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

struct Note {
    rel: String,
    title: String,
}

impl NoteFile for Note {
    fn rel(&self) -> &str {
        &self.rel
    }
    fn title(&self) -> &str {
        &self.title
    }
}

struct World {
    files: Arc<Files>,
    home: String,
    open_log: String,
    notes: Vec<Note>,
    roots: Vec<String>,
}

fn world(f: &Value, name: &str) -> World {
    let base = std::env::temp_dir().join(format!("openfile-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let (home, bin) = (base.join("home"), base.join("bin"));
    for entry in f["tree"].as_array().unwrap() {
        let full = home.join(entry[0].as_str().unwrap());
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, "x").unwrap();
        let mtime = UNIX_EPOCH + Duration::from_secs(entry[1].as_u64().unwrap());
        fs::File::options().write(true).open(&full).unwrap().set_modified(mtime).unwrap();
    }
    fs::create_dir_all(home.join("LibreOffice.app")).unwrap();
    fs::create_dir_all(&bin).unwrap();
    let open_log = bin.join("open.log").to_string_lossy().into_owned();
    let script = |name: &str, body: String| {
        use std::os::unix::fs::PermissionsExt;
        let p = bin.join(name);
        fs::write(&p, body).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().into_owned()
    };
    let home = home.to_string_lossy().into_owned();
    let cfg = Config {
        home: home.clone(),
        mdfind: script("mdfind", "#!/bin/sh\nfind \"$2\" -iname \"*$4*\" | sort\n".into()),
        open: script("open", format!("#!/bin/sh\nprintf '%s|' \"$@\" >> \"{open_log}\"\nprintf '\\n' >> \"{open_log}\"\n")),
        libreoffice: format!("{home}/LibreOffice.app"),
    };
    let notes = f["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| Note { rel: n["rel"].as_str().unwrap().into(), title: n["title"].as_str().unwrap().into() })
        .collect();
    let roots = vec![format!("{home}/notes"), format!("{home}/notes2")];
    World { files: Files::new(cfg), home, open_log, notes, roots }
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/openfile.json")).unwrap()
}

#[tokio::test]
async fn steps_match_node() {
    let f = fixture();
    let w = world(&f, "steps");
    let meaning = f["meaning"].clone();
    let find = move |q: String| -> BoxFut<'static, Result<Vec<(String, f64)>, String>> {
        let hits = meaning[q.as_str()].clone();
        Box::pin(async move {
            match hits {
                Value::String(_) => Err("meaning search is down".into()),
                Value::Array(a) => Ok(a.iter().map(|h| (h[0].as_str().unwrap().into(), h[1].as_f64().unwrap())).collect()),
                _ => Ok(vec![]),
            }
        })
    };

    for step in f["steps"].as_array().unwrap() {
        fs::write(&w.open_log, "").unwrap();
        let arg = &step["arg"];
        let s = || arg.as_str().unwrap();
        let out = match step["kind"].as_str().unwrap() {
            "openFileJob" => json!(open_file_job(s()).map(|j| json!({ "name": j.name, "explicit": j.explicit }))),
            "findOnMacJob" => json!(find_on_mac_job(s()).map(|name| json!({ "name": name }))),
            "compact" => json!(compact(s())),
            "words" => json!(words(s())),
            "findFile" => json!(find_file(s(), &w.notes, &w.roots)),
            "find" => json!(w.files.run_find_on_mac(arg["name"].as_str().unwrap()).await),
            _ => {
                let h = &step["help"];
                let help = Help {
                    asked: h["asked"].as_str().unwrap_or(""),
                    recent_text: h["recentText"].as_str().unwrap_or(""),
                    find_by_meaning: if h["meaning"] == true { Some(&find) } else { None },
                };
                let job = OpenJob { name: arg["name"].as_str().unwrap().into(), explicit: arg["explicit"] == true };
                json!(w.files.run_open_file(&job, &w.notes, &w.roots, &help).await)
            }
        };
        let hide = |v: Value| -> Value { serde_json::from_str(&v.to_string().replace(&w.home, "<HOME>")).unwrap() };
        let opened: Vec<String> = fs::read_to_string(&w.open_log).unwrap().lines().map(String::from).collect();
        assert_eq!(hide(out), step["out"], "step {step}");
        assert_eq!(hide(json!(opened)), step["opened"], "opened files, step {step}");
    }
}

/// Fixed on purpose: JS crashed here (ERR_INVALID_ARG_TYPE); Rust runs the email list's opener.
#[tokio::test]
async fn open_number_after_email_list_uses_its_opener() {
    let f = fixture();
    assert_eq!(f["emailPick"]["error"], "ERR_INVALID_ARG_TYPE");
    let w = world(&f, "email");
    w.files.remember_list(vec![Arc::new(|| -> BoxFut<'static, String> { Box::pin(async { "opened in Outlook".into() }) })]);
    let job = OpenJob { name: "number one".into(), explicit: false };
    let out = w.files.run_open_file(&job, &w.notes, &w.roots, &Help::default()).await;
    assert_eq!(out.as_deref(), Some("opened in Outlook"));
    let job = OpenJob { name: "number two".into(), explicit: false };
    let out = w.files.run_open_file(&job, &w.notes, &w.roots, &Help::default()).await;
    assert_eq!(out.as_deref(), Some("The last list has only 1."));
}
