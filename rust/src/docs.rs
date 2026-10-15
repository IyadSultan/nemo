//! Rust port of `second-brain/docs.js`.
//!
//! PDF and Word files as notes, so keyword and meaning search can find them.
//!
//! Text comes from pdftotext (Poppler) for .pdf and macOS textutil for .docx.
//! Extracted text is cached in tmp/doc-text.json by path, size and date,
//! so each file is read once until it changes. Same file format as Node.
//! OneDrive files that are only in the cloud (not downloaded) are skipped:
//! reading them would download every PDF in the folder.

use crate::js::{self, path};
use crate::js_re;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};
use tokio::sync::Mutex;

const MAX_BYTES: u64 = 25 * 1024 * 1024;
const MAX_DOCS_PER_FOLDER: usize = 500;
// Search reads the whole text; long reports only need their first pages.
const MAX_TEXT: usize = 60_000;
// macOS marks cloud-only files with this st_flags bit (SF_DATALESS).
#[cfg(target_os = "macos")]
const DATALESS: u32 = 0x4000_0000;

/// A PDF or Word file, shaped like a note.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Doc {
    pub rel: String,
    pub title: String,
    /// Title, a newline, then the text.
    pub text: String,
    pub lower: String,
}

pub struct Config {
    pub cache_file: PathBuf,
    pub pdftotext: String,
    pub textutil: String,
}

impl Config {
    /// Real tools; the cache sits in `<brain dir>/tmp/doc-text.json`.
    pub fn new(brain_dir: &str) -> Self {
        Self {
            cache_file: PathBuf::from(brain_dir).join("tmp").join("doc-text.json"),
            pdftotext: "/opt/homebrew/bin/pdftotext".into(),
            textutil: "/usr/bin/textutil".into(),
        }
    }
}

pub struct Docs {
    cfg: Config,
    /// Loaded on first use. Async lock: held across extraction, like Node's single thread.
    cache: Mutex<Option<Map<String, Value>>>,
}

async fn run(bin: &str, args: &[&str]) -> Result<String, String> {
    let child = tokio::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(60), child)
        .await
        .map_err(|_| format!("Command failed: {bin} (timed out)"))?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("Command failed: {bin} {}\n{}", args.join(" "), String::from_utf8_lossy(&out.stderr)));
    }
    if out.stdout.len() > 64 * 1024 * 1024 {
        return Err("stdout maxBuffer length exceeded".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Cloud-only OneDrive file (not downloaded).
fn is_cloud_only(file: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        std::fs::symlink_metadata(file).is_ok_and(|m| m.st_flags() & DATALESS != 0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = file;
        false
    }
}

/// JS `stat.mtimeMs` (seconds * 1e3 + nanoseconds / 1e6).
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    let d = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).unwrap_or_default();
    d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6
}

/// Files ending .pdf/.docx under root, skipping hidden files, Office lock files, and `skip_dirs`.
fn list_docs(root: &str, skip_dirs: &HashSet<String>) -> Vec<String> {
    fn walk(dir: &str, skip: &HashSet<String>, found: &mut Vec<String>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(err) => {
                eprintln!("Failed while listing folder for documents: {dir} {err}");
                return;
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with("~$") {
                continue;
            }
            let full = path::join(dir, &name);
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if !skip.contains(&name) {
                    walk(&full, skip, found);
                }
            } else if kind.is_file() && js_re!(r"\.(pdf|docx)$", "i").test(&name) {
                found.push(full);
            }
        }
    }
    let mut found = Vec::new();
    walk(root, skip_dirs, &mut found);
    found
}

/// The cache key Node would write for this file, or None if it cannot be read.
/// (Exposed for the real-cache check in tests.)
pub fn cache_key(file: &str) -> Option<String> {
    let meta = std::fs::metadata(file).ok()?;
    Some(format!("{}:{}", meta.len(), (mtime_ms(&meta) + 0.5).floor() as i64))
}

impl Docs {
    pub fn new(cfg: Config) -> Self {
        Self { cfg, cache: Mutex::new(None) }
    }

    pub async fn extract_text(&self, file: &str) -> Result<String, String> {
        let out = if file.to_lowercase().ends_with(".pdf") {
            run(&self.cfg.pdftotext, &["-q", "-enc", "UTF-8", file, "-"]).await?
        } else {
            run(&self.cfg.textutil, &["-convert", "txt", "-stdout", file]).await?
        };
        let out = js_re!(r"\f", "g").replace(&out, "\n\n");
        let out = js_re!(r"[ \t]+\n", "g").replace(&out, "\n");
        let out = js_re!(r"\n{3,}", "g").replace(&out, "\n\n");
        Ok(js::slice16(js::trim(&out), 0, MAX_TEXT))
    }

    /// Read the PDFs and Word files under root and return them as notes.
    pub async fn load_docs(&self, root: &str, skip_dirs: &HashSet<String>) -> Vec<Doc> {
        let mut guard = self.cache.lock().await;
        let store = guard.get_or_insert_with(|| {
            std::fs::read_to_string(&self.cfg.cache_file)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default()
        });
        let files = list_docs(root, skip_dirs);
        if files.len() > MAX_DOCS_PER_FOLDER {
            eprintln!("{} documents in {root}; reading the newest {MAX_DOCS_PER_FOLDER}.", files.len());
        }
        let mut with_stats: Vec<(String, u64, f64)> = files
            .into_iter()
            .filter_map(|file| {
                let meta = std::fs::metadata(&file).ok()?;
                (meta.len() > 0 && meta.len() <= MAX_BYTES).then(|| {
                    let (size, mtime) = (meta.len(), mtime_ms(&meta));
                    (file, size, mtime)
                })
            })
            .collect();
        with_stats.sort_by(|a, b| b.2.total_cmp(&a.2));
        with_stats.truncate(MAX_DOCS_PER_FOLDER);

        let mut docs = Vec::new();
        let (mut cloud_only, mut failed, mut changed) = (0, 0, false);
        for (file, size, mtime) in with_stats {
            // Math.round: halves go up. Same formula as cache_key().
            let key = format!("{size}:{}", (mtime + 0.5).floor() as i64);
            let cached = store.get(&file).filter(|e| e["key"] == key.as_str()).map(|e| js::to_str(&e["text"]));
            let text = match cached {
                Some(t) => t,
                None => {
                    if is_cloud_only(&file) {
                        cloud_only += 1;
                        continue;
                    }
                    let text = match self.extract_text(&file).await {
                        Ok(t) => t,
                        Err(err) => {
                            failed += 1;
                            eprintln!("Failed while reading document: {} {err}", path::basename(&file));
                            String::new()
                        }
                    };
                    store.insert(file.clone(), json!({ "key": key, "text": text }));
                    changed = true;
                    text
                }
            };
            if text.is_empty() {
                continue;
            }
            let title = js_re!(r"\.(pdf|docx)$", "i").replace(&path::basename(&file), "");
            let title = js_re!(r"[-_]+", "g").replace(&title, " ");
            let full = format!("{title}\n{text}");
            docs.push(Doc { rel: path::relative(root, &file), title, lower: full.to_lowercase(), text: full });
        }
        if changed {
            let saved = std::fs::create_dir_all(self.cfg.cache_file.parent().unwrap())
                .and_then(|_| std::fs::write(&self.cfg.cache_file, Value::Object(store.clone()).to_string()));
            if let Err(err) = saved {
                eprintln!("Failed while saving the document cache: {err}");
            }
        }
        let mut note = format!("Read {} PDF/Word file(s) from {root}", docs.len());
        if cloud_only > 0 {
            note += &format!("; {cloud_only} skipped because they are only in OneDrive (not downloaded)");
        }
        if failed > 0 {
            note += &format!("; {failed} could not be read");
        }
        println!("{note}");
        docs
    }
}
