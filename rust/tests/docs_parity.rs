//! Golden test: Rust document reading must match `second-brain/docs.js`,
//! including the bytes of the shared cache file.
//! Fixture comes from `node rust/tests/fixtures/gen_docs.mjs`.

use nemo_realtime_voice::docs::{Config, Docs};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, UNIX_EPOCH};

fn set_mtime(file: &std::path::Path, ns: &str) {
    let ns: u64 = ns.parse().unwrap();
    let when = UNIX_EPOCH + Duration::from_nanos(ns);
    fs::File::options().write(true).open(file).unwrap().set_modified(when).unwrap();
}

#[tokio::test]
async fn loads_and_cache_match_node() {
    let f: Value = serde_json::from_str(include_str!("fixtures/docs.json")).unwrap();
    let base = std::env::temp_dir().join(format!("docs-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let (root, bin) = (base.join("root"), base.join("bin"));
    fs::create_dir_all(&bin).unwrap();
    for entry in f["tree"].as_array().unwrap() {
        let rel = entry[0].as_str().unwrap();
        let full = root.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, entry[1].as_str().unwrap()).unwrap();
        set_mtime(&full, f["mtimes"][rel].as_str().unwrap());
    }
    std::os::unix::fs::symlink(root.join("sub/deeper/notes.pdf"), root.join("link.pdf")).unwrap();

    let calls = bin.join("calls.log");
    let calls_s = calls.to_string_lossy();
    let script = |name: &str, body: String| {
        let p = bin.join(name);
        fs::write(&p, body).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().into_owned()
    };
    let cfg = Config {
        cache_file: base.join("tmp").join("doc-text.json"),
        pdftotext: script(
            "pdftotext",
            format!("#!/bin/sh\necho \"pdftotext $4\" >> \"{calls_s}\"\ngrep -q FAIL \"$4\" && {{ echo \"Syntax Error\" >&2; exit 1; }}\ncat \"$4\"\n"),
        ),
        textutil: script("textutil", format!("#!/bin/sh\necho \"textutil $4\" >> \"{calls_s}\"\ngrep -q FAIL \"$4\" && exit 1\ncat \"$4\"\n")),
    };
    let cache_file = cfg.cache_file.clone();
    let docs = Docs::new(cfg);
    let root_s = root.to_string_lossy().into_owned();
    let skip: HashSet<String> = ["node_modules".to_string()].into();
    let hide = |s: String| s.replace(&root_s, "<ROOT>");

    for (i, expected) in f["loads"].as_array().unwrap().iter().enumerate() {
        if i == 2 {
            let changed = root.join("sub/deeper/notes.pdf");
            fs::write(&changed, "Deep note, edited").unwrap();
            set_mtime(&changed, f["changedMtime"].as_str().unwrap());
        }
        fs::write(&calls, "").unwrap();
        let got = docs.load_docs(&root_s, &skip).await;
        let label = &expected["label"];
        assert_eq!(serde_json::from_str::<Value>(&hide(json!(got).to_string())).unwrap(), expected["docs"], "notes, {label}");
        let read: Vec<String> = fs::read_to_string(&calls).unwrap().lines().map(|l| hide(l.into())).collect();
        assert_eq!(json!(read), expected["calls"], "files read, {label}");
        assert_eq!(hide(fs::read_to_string(&cache_file).unwrap()), expected["cache"].as_str().unwrap(), "cache file, {label}");
    }
}

/// Manual check on the real cache (prints counts only): DOC_CACHE=.../tmp/doc-text.json cargo test -- --ignored real_cache
#[test]
#[ignore]
fn real_cache() {
    let text = fs::read_to_string(std::env::var("DOC_CACHE").unwrap()).unwrap();
    let cache: serde_json::Map<String, Value> = serde_json::from_str(&text).unwrap();
    let (mut same, mut differ, mut gone) = (0, 0, 0);
    for (file, entry) in &cache {
        match nemo_realtime_voice::docs::cache_key(file) {
            None => gone += 1,
            Some(k) if entry["key"] == k.as_str() => same += 1,
            Some(_) => differ += 1,
        }
    }
    println!("real cache: {same} keys match, {differ} differ (file changed since, or a mismatch), {gone} files gone");
    // Rewriting the cache unchanged must give Node's exact bytes.
    assert_eq!(Value::Object(cache).to_string(), text);
}
