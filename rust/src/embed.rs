//! Rust port of `second-brain/embed.js`.
//!
//! Meaning search for the notes, next to the keyword search.
//!
//! Keyword search misses a note that says the same thing in other words
//! ("ASCO talk" vs "oncology presentation"). This file turns each note into
//! a few number lists (embeddings) with a small local Ollama model, and finds
//! the notes whose meaning is closest to the question.
//!
//! - Runs on this Mac (Ollama). Note text never leaves the machine.
//! - Embeddings are cached in second-brain/tmp (git-ignored), keyed by a hash
//!   of each piece of text, so only new or changed notes are embedded again.
//!   The cache file has the same format as the Node version, so both share it.
//! - If Ollama is down or the index is still building, search() returns
//!   nothing and the keyword search works alone.
//!
//! Lengths and cuts count UTF-16 units, like JS strings, so pieces and their
//! hashes match the Node version exactly.

use crate::js;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use regex::Regex;
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, Instant};

const CHUNK_CHARS: usize = 1000;
const MAX_CHUNKS_PER_NOTE: usize = 8;
const BATCH: usize = 32;

/// Each embedding model was trained with its own query/document wording.
struct Prefix {
    min_score: f64,
    query: fn(&str) -> String,
    doc: fn(&str, &str) -> String,
}

fn prefix_for(model: &str) -> Prefix {
    match model {
        "embeddinggemma" => Prefix {
            min_score: 0.25,
            query: |q| format!("task: search result | query: {q}"),
            doc: |t, x| format!("title: {t} | text: {x}"),
        },
        "qwen3-embedding:0.6b" => Prefix {
            min_score: 0.5,
            query: |q| format!("Instruct: Given a question, find the personal notes that answer it\nQuery: {q}"),
            doc: |t, x| format!("{t}\n{x}"),
        },
        // "nomic-embed-text" and anything unknown.
        _ => Prefix {
            min_score: 0.6,
            query: |q| format!("search_query: {q}"),
            doc: |t, x| format!("search_document: {t}\n{x}"),
        },
    }
}

/// What the index needs from a note. The server's note type implements this.
pub trait NoteText {
    fn title(&self) -> &str;
    fn text(&self) -> &str;
}

/// JS whitespace, per UTF-16 unit (every JS space is a single unit).
fn is_js_space(u: u16) -> bool {
    char::from_u32(u as u32).is_some_and(js::is_js_space)
}

/// JS `/\n\s*\n/`.
static PARA_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"\n[{}]*\n", js::JS_SPACE)).unwrap());

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Split a note into pieces of about CHUNK_CHARS, cutting at blank lines where possible.
/// Returns (piece text, embedding input) pairs.
fn chunk_note(title: &str, text: &str, doc: fn(&str, &str) -> String) -> Vec<(String, String)> {
    let text16 = utf16(text);
    let body = &text16[utf16(title).len().min(text16.len())..];
    let start = body.iter().position(|&u| !is_js_space(u)).unwrap_or(body.len());
    let end = body.iter().rposition(|&u| !is_js_space(u)).map_or(start, |i| i + 1);
    // A lone surrogate becomes U+FFFD: still one UTF-16 unit, and the same
    // bytes Node hashes, so lengths and hashes stay identical.
    let body = String::from_utf16_lossy(&body[start..end]);

    let mut pieces: Vec<Vec<u16>> = Vec::new();
    let mut current: Vec<u16> = Vec::new();
    for para in PARA_BREAK.split(&body) {
        let para = utf16(para);
        if !current.is_empty() && current.len() + para.len() > CHUNK_CHARS {
            pieces.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.extend_from_slice(&[0x0A, 0x0A]);
        }
        current.extend_from_slice(&para);
        while current.len() as f64 > CHUNK_CHARS as f64 * 1.5 {
            pieces.push(current[..CHUNK_CHARS].to_vec());
            current.drain(..CHUNK_CHARS);
        }
        if pieces.len() >= MAX_CHUNKS_PER_NOTE {
            break;
        }
    }
    if !current.is_empty() && pieces.len() < MAX_CHUNKS_PER_NOTE {
        pieces.push(current);
    }
    if pieces.is_empty() {
        pieces.push(Vec::new());
    }
    pieces
        .into_iter()
        .map(|p| {
            let piece = String::from_utf16_lossy(&p);
            let input = doc(title, &piece);
            (piece, input)
        })
        .collect()
}

fn hash_of(text: &str) -> String {
    hex::encode(Sha1::digest(text.as_bytes()))
}

fn normalize(vec: &[f64]) -> Vec<f32> {
    let sum: f64 = vec.iter().map(|x| x * x).sum();
    let len = match sum.sqrt() {
        l if l == 0.0 || l.is_nan() => 1.0,
        l => l,
    };
    vec.iter().map(|x| (x / len) as f32).collect()
}

type Vector = Arc<Vec<f32>>;

struct Chunk<N> {
    note: Arc<N>,
    text: String,
    vec: Vector,
}

pub struct Hit<N> {
    pub note: Arc<N>,
    pub score: f64,
    pub text: String,
}

pub struct SemanticIndex<N> {
    ollama_url: String,
    model: String,
    cache_file: PathBuf,
    prefix: Prefix,
    http: reqwest::Client,
    chunks: RwLock<Arc<Vec<Chunk<N>>>>,
    ready: std::sync::atomic::AtomicBool,
    build_id: AtomicU64,
}

impl<N: NoteText> SemanticIndex<N> {
    pub fn new(ollama_url: &str, model: &str, cache_file: PathBuf) -> Self {
        Self {
            ollama_url: ollama_url.to_string(),
            model: model.to_string(),
            cache_file,
            prefix: prefix_for(model),
            http: reqwest::Client::new(),
            chunks: RwLock::new(Arc::new(Vec::new())),
            ready: false.into(),
            build_id: AtomicU64::new(0),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    async fn embed(&self, inputs: &[&str], timeout: Duration) -> Result<Vec<Vec<f32>>, String> {
        let res = self
            .http
            .post(format!("{}/api/embed", self.ollama_url))
            .json(&json!({ "model": self.model, "input": inputs, "keep_alive": "1h" }))
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Ollama embed {}: {body}", status.as_u16()));
        }
        #[derive(serde::Deserialize)]
        struct EmbedResponse {
            embeddings: Vec<Vec<f64>>,
        }
        let data: EmbedResponse = res.json().await.map_err(|e| e.to_string())?;
        Ok(data.embeddings.iter().map(|v| normalize(v)).collect())
    }

    async fn load_cache(&self) -> HashMap<String, Vector> {
        let Ok(raw) = tokio::fs::read_to_string(&self.cache_file).await else {
            return HashMap::new();
        };
        let Ok(raw) = serde_json::from_str::<Value>(&raw) else {
            return HashMap::new();
        };
        if raw["model"] != self.model.as_str() {
            return HashMap::new();
        }
        let Some(vectors) = raw["vectors"].as_object() else {
            return HashMap::new();
        };
        let mut cache = HashMap::new();
        for (hash, b64) in vectors {
            let Some(bytes) = b64.as_str().and_then(|s| B64.decode(s).ok()) else {
                return HashMap::new();
            };
            let vec = bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
            cache.insert(hash.clone(), Arc::new(vec));
        }
        cache
    }

    async fn save_cache(&self, cache: &HashMap<String, Vector>) -> std::io::Result<()> {
        let vectors: Map<String, Value> = cache
            .iter()
            .map(|(hash, vec)| {
                let bytes: Vec<u8> = vec.iter().flat_map(|x| x.to_le_bytes()).collect();
                (hash.clone(), Value::String(B64.encode(bytes)))
            })
            .collect();
        if let Some(dir) = self.cache_file.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let mut tmp = self.cache_file.clone().into_os_string();
        tmp.push(".tmp");
        tokio::fs::write(&tmp, json!({ "model": self.model, "vectors": vectors }).to_string()).await?;
        tokio::fs::rename(&tmp, &self.cache_file).await
    }

    /// Embed every note (reusing the cache). Safe to call again after a reload.
    pub async fn build(&self, notes: &[Arc<N>]) -> Result<(), String> {
        let id = self.build_id.fetch_add(1, Ordering::SeqCst) + 1;
        self.ready.store(false, Ordering::SeqCst);
        let started = Instant::now();
        let mut cache = self.load_cache().await;

        struct Wanted<N> {
            note: Arc<N>,
            text: String,
            input: String,
            hash: String,
        }
        let mut wanted = Vec::new();
        for note in notes {
            for (text, input) in chunk_note(note.title(), note.text(), self.prefix.doc) {
                let hash = hash_of(&input);
                wanted.push(Wanted { note: note.clone(), text, input, hash });
            }
        }
        let mut seen = HashSet::new();
        let missing: Vec<&Wanted<N>> =
            wanted.iter().filter(|c| !cache.contains_key(&c.hash) && seen.insert(c.hash.as_str())).collect();

        for (i, batch) in missing.chunks(BATCH).enumerate().map(|(n, b)| (n * BATCH, b)) {
            if id != self.build_id.load(Ordering::SeqCst) {
                return Ok(()); // A newer reload started; let it finish instead.
            }
            let inputs: Vec<&str> = batch.iter().map(|c| c.input.as_str()).collect();
            let vecs = self.embed(&inputs, Duration::from_secs(120)).await?;
            for (c, v) in batch.iter().zip(vecs) {
                cache.insert(c.hash.clone(), Arc::new(v));
            }
            if i > 0 && i % (BATCH * 20) == 0 {
                println!("Meaning index: {i}/{} new pieces embedded", missing.len());
            }
        }
        if id != self.build_id.load(Ordering::SeqCst) {
            return Ok(());
        }
        // Keep vectors for folders that are not selected now, so switching back is instant.
        if !missing.is_empty() {
            self.save_cache(&cache).await.map_err(|e| e.to_string())?;
        }
        let new_missing = missing.len();
        let chunks: Vec<Chunk<N>> = wanted
            .into_iter()
            .map(|c| Chunk { vec: cache[&c.hash].clone(), note: c.note, text: c.text })
            .collect();
        let count = chunks.len();
        *self.chunks.write().unwrap() = Arc::new(chunks);
        self.ready.store(true, Ordering::SeqCst);
        println!(
            "Meaning index ready: {count} pieces from {} notes ({new_missing} newly embedded, {:.1}s)",
            notes.len(),
            started.elapsed().as_secs_f64()
        );
        Ok(())
    }

    /// Notes ranked by meaning. Each note scores as its closest piece.
    /// Pieces below the model's min_score are dropped, so an off-topic question finds nothing.
    pub async fn search(&self, question: &str, limit: usize) -> Vec<Hit<N>> {
        if !self.is_ready() || self.chunks.read().unwrap().is_empty() {
            return Vec::new();
        }
        let query = match self.embed(&[&(self.prefix.query)(question)], Duration::from_millis(1500)).await {
            Ok(mut v) if !v.is_empty() => v.swap_remove(0),
            Ok(_) => return Vec::new(),
            Err(err) => {
                eprintln!("Meaning search skipped: {err}");
                return Vec::new();
            }
        };
        let chunks = self.chunks.read().unwrap().clone();
        let mut best: Vec<Hit<N>> = Vec::new();
        let mut slot: HashMap<*const N, usize> = HashMap::new();
        for chunk in chunks.iter() {
            let score: f64 = query.iter().zip(chunk.vec.iter()).map(|(q, v)| *q as f64 * *v as f64).sum();
            if score < self.prefix.min_score {
                continue;
            }
            let hit = || Hit { note: chunk.note.clone(), score, text: chunk.text.clone() };
            match slot.get(&Arc::as_ptr(&chunk.note)) {
                Some(&i) if score > best[i].score => best[i] = hit(),
                Some(_) => {}
                None => {
                    slot.insert(Arc::as_ptr(&chunk.note), best.len());
                    best.push(hit());
                }
            }
        }
        best.sort_by(|a, b| b.score.total_cmp(&a.score));
        best.truncate(limit);
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pieces(title: &str, text: &str) -> Vec<String> {
        chunk_note(title, text, |_, x| x.to_string()).into_iter().map(|(p, _)| p).collect()
    }

    #[test]
    fn title_only_note_gives_one_empty_piece() {
        assert_eq!(pieces("Hi", "Hi"), vec![""]);
    }

    #[test]
    fn blank_lines_with_spaces_split_paragraphs_but_stay_joined_when_short() {
        assert_eq!(pieces("T", "T\n\na\n \t\nb"), vec!["a\n\nb"]);
    }

    #[test]
    fn cuts_count_utf16_units() {
        // 999 'x' + emoji (2 units) + 600 'y' = 1601 units > 1500 → cut at 1000,
        // which splits the emoji, as JS does.
        let text = format!("T\n{}😀{}", "x".repeat(999), "y".repeat(600));
        let p = pieces("T", &text);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].encode_utf16().count(), 1000);
        assert!(p[0].ends_with('\u{FFFD}'));
        assert!(p[1].starts_with('\u{FFFD}'));
    }

    #[test]
    fn normalize_handles_zero_vector() {
        assert_eq!(normalize(&[0.0, 0.0]), vec![0.0, 0.0]);
        assert_eq!(normalize(&[3.0, 4.0]), vec![0.6, 0.8]);
    }
}
