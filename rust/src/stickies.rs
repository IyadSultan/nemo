//! Sticky-note tools.
//!
//! The page talks to the Node server, which keeps stickies.json in memory
//! (same reason the desk stays in Node: one writer). This module is the same
//! set of tools, so a Rust caller can create, search, and arrange notes
//! against a copy of that file. Names match the Node tools in stickies.js.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const TOOL_NAMES: [&str; 16] = [
    "sticky_note_create",
    "sticky_note_update",
    "sticky_note_delete",
    "sticky_note_archive",
    "sticky_note_restore",
    "sticky_note_search",
    "sticky_note_list",
    "sticky_note_classify",
    "sticky_note_set_color",
    "sticky_note_set_priority",
    "sticky_note_convert_to_task",
    "sticky_note_convert_to_note",
    "sticky_note_set_reminder",
    "sticky_note_link",
    "sticky_note_move",
    "sticky_note_sort",
];

pub struct Stickies {
    path: PathBuf,
    state: Value,
}

impl Stickies {
    /// A file without notes or links still opens, so a lookup never panics.
    pub fn open(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let mut state: Value = fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(empty);
        if !state.is_object() {
            state = empty();
        }
        for key in ["notes", "links"] {
            if !state[key].is_array() {
                state[key] = json!([]);
            }
        }
        Self { path, state }
    }

    pub fn dispatch(&mut self, name: &str, args: &Value) -> Value {
        let out = match name {
            "sticky_note_create" => self.create(args),
            "sticky_note_update" => self.update(args),
            "sticky_note_delete" => self.delete(args),
            "sticky_note_archive" => self.archive(args),
            "sticky_note_restore" => self.restore(args),
            "sticky_note_search" | "sticky_note_list" => self.search(args),
            "sticky_note_set_color" => self.set_field(args, "color"),
            "sticky_note_set_priority" => self.set_priority(args),
            "sticky_note_convert_to_task" => self.convert(args, true),
            "sticky_note_convert_to_note" => self.convert(args, false),
            "sticky_note_set_reminder" => self.set_field(args, "reminderAt"),
            "sticky_note_link" => self.link(args),
            "sticky_note_move" => self.move_note(args),
            "sticky_note_sort" => self.sort_board(args),
            "sticky_note_classify" => self.classify(args),
            _ => json!({"ok": false, "status": "error", "error": "unknown_tool"}),
        };
        let _ = self.save();
        out
    }

    fn create(&mut self, args: &Value) -> Value {
        let id = new_id();
        let note = json!({
            "id": id,
            "boardId": "board-main",
            "content": args["content"].as_str().unwrap_or(""),
            "title": args["title"].as_str().unwrap_or(""),
            "titleSource": if args["title"].as_str().unwrap_or("").is_empty() { "ai" } else { "user" },
            "titleLocked": args["title"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
            "hashtags": [],
            "color": args["color"].as_str().unwrap_or("yellow"),
            "priority": args["priority"].as_str().unwrap_or("none"),
            "prioritySource": "user",
            "priorityLocked": args["priority"].as_str().is_some(),
            "noteType": args["noteType"].as_str().unwrap_or("note"),
            "taskStatus": "open",
            "isPinned": false,
            "mark": if args["mark"].as_str() == Some("claude") { "claude" } else { "" },
            "archivedAt": null,
            "deletedAt": null,
            "positionX": args["x"].as_f64().unwrap_or(80.0),
            "positionY": args["y"].as_f64().unwrap_or(64.0),
            "width": 230.0,
            "height": 200.0,
            "rotation": 0.0,
            "contentVersion": 1,
            "metadataVersion": 0,
            "isTask": false,
        });
        self.notes_mut().push(note.clone());
        json!({"ok": true, "status": "created", "note": note})
    }

    fn update(&mut self, args: &Value) -> Value {
        let Some(index) = self.find_index(args) else {
            return self.ambiguous_or_missing(args, "sticky_note_update");
        };
        let note = &mut self.notes_mut()[index];
        if let Some(content) = args["content"].as_str() {
            if note["content"].as_str() != Some(content) {
                note["content"] = json!(content);
                let version = note["contentVersion"].as_i64().unwrap_or(1) + 1;
                note["contentVersion"] = json!(version);
            }
        }
        if let Some(extra) = args["append"].as_str() {
            let content = format!("{}<br>{}", note["content"].as_str().unwrap_or(""), extra);
            note["content"] = json!(content);
            let version = note["contentVersion"].as_i64().unwrap_or(1) + 1;
            note["contentVersion"] = json!(version);
        }
        if let Some(title) = args["title"].as_str() {
            note["title"] = json!(title);
            note["titleLocked"] = json!(true);
            note["titleSource"] = json!("user");
        }
        let note = self.notes()[index].clone();
        json!({"ok": true, "status": "updated", "note": note})
    }

    fn delete(&mut self, args: &Value) -> Value {
        if !args["confirm"].as_bool().unwrap_or(false) {
            return match self.hits(args) {
                Hits::One(_) => json!({"ok": false, "status": "confirm", "error": "Say yes to move it to the trash."}),
                Hits::Many(choices) => json!({"ok": false, "status": "choose", "choices": choices}),
                Hits::None => json!({"ok": false, "status": "not_found", "error": "not_found"}),
            };
        }
        let Some(index) = self.find_index(args) else {
            return self.ambiguous_or_missing(args, "sticky_note_delete");
        };
        self.notes_mut()[index]["deletedAt"] = json!(now());
        let note = self.notes()[index].clone();
        json!({"ok": true, "status": "deleted", "note": note})
    }

    fn archive(&mut self, args: &Value) -> Value {
        let Some(index) = self.find_index(args) else {
            return self.ambiguous_or_missing(args, "sticky_note_archive");
        };
        self.notes_mut()[index]["archivedAt"] = json!(now());
        let note = self.notes()[index].clone();
        json!({"ok": true, "status": "archived", "note": note})
    }

    fn restore(&mut self, args: &Value) -> Value {
        let Some(index) = self.find_index(args) else {
            return json!({"ok": false, "status": "not_found"});
        };
        self.notes_mut()[index]["archivedAt"] = Value::Null;
        self.notes_mut()[index]["deletedAt"] = Value::Null;
        let note = self.notes()[index].clone();
        json!({"ok": true, "status": "restored", "note": note})
    }

    fn search(&self, args: &Value) -> Value {
        let query = args["query"].as_str().or_else(|| args["q"].as_str()).unwrap_or("");
        let notes: Vec<Value> = self.hits_list(query).into_iter().map(|(_, note, _)| note).collect();
        json!({"ok": true, "status": "listed", "notes": notes})
    }

    fn set_field(&mut self, args: &Value, field: &str) -> Value {
        let Some(index) = self.find_index(args) else {
            return self.ambiguous_or_missing(args, "sticky_note_update");
        };
        let value = if field == "color" { args["color"].clone() } else { args["reminderAt"].clone() };
        self.notes_mut()[index][field] = value;
        let note = self.notes()[index].clone();
        json!({"ok": true, "status": "updated", "note": note})
    }

    fn set_priority(&mut self, args: &Value) -> Value {
        let Some(index) = self.find_index(args) else {
            return self.ambiguous_or_missing(args, "sticky_note_set_priority");
        };
        let note = &mut self.notes_mut()[index];
        note["priority"] = args["priority"].clone();
        note["priorityLocked"] = json!(true);
        note["prioritySource"] = json!("user");
        let note = note.clone();
        json!({"ok": true, "status": "updated", "note": note})
    }

    fn convert(&mut self, args: &Value, to_task: bool) -> Value {
        let Some(index) = self.find_index(args) else {
            return self.ambiguous_or_missing(args, "sticky_note_convert_to_task");
        };
        let note = &mut self.notes_mut()[index];
        let content = note["content"].clone();
        let id = note["id"].clone();
        note["noteType"] = json!(if to_task { "task" } else { "note" });
        if let Some(priority) = args["priority"].as_str() {
            note["priority"] = json!(priority);
            note["priorityLocked"] = json!(true);
        }
        let note = note.clone();
        if note["id"] != id || note["content"] != content {
            return json!({"ok": false, "status": "error"});
        }
        json!({"ok": true, "status": "converted", "note": note})
    }

    fn link(&mut self, args: &Value) -> Value {
        let link = json!({
            "id": new_id(),
            "fromId": args["fromId"].as_str().unwrap_or(""),
            "toId": args["toId"].as_str().unwrap_or(""),
            "href": format!("note:{}", args["toId"].as_str().unwrap_or("")),
            "kind": "note",
        });
        self.state["links"].as_array_mut().unwrap().push(link);
        json!({"ok": true, "status": "linked"})
    }

    fn move_note(&mut self, args: &Value) -> Value {
        let Some(index) = self.find_index(args) else {
            return self.ambiguous_or_missing(args, "sticky_note_move");
        };
        if let Some(x) = args["x"].as_f64() {
            self.notes_mut()[index]["positionX"] = json!(x);
        }
        if let Some(y) = args["y"].as_f64() {
            self.notes_mut()[index]["positionY"] = json!(y);
        }
        let note = self.notes()[index].clone();
        json!({"ok": true, "status": "updated", "note": note})
    }

    /// Organized order never overwrites the saved x and y.
    fn sort_board(&mut self, args: &Value) -> Value {
        let before: Vec<(String, f64, f64)> = self.notes().iter().filter_map(|note| {
            Some((note["id"].as_str()?.to_string(), note["positionX"].as_f64()?, note["positionY"].as_f64()?))
        }).collect();
        if let Some(sort) = args["sort"].as_str() {
            self.state["boards"][0]["sort"] = json!(sort);
        }
        if let Some(layout) = args["layout"].as_str() {
            self.state["boards"][0]["layout"] = json!(layout);
        }
        let after_ok = before.iter().all(|(id, x, y)| {
            self.notes().iter().any(|note| note["id"].as_str() == Some(id) && note["positionX"].as_f64() == Some(*x) && note["positionY"].as_f64() == Some(*y))
        });
        json!({"ok": after_ok, "status": "sorted", "layout": self.state["boards"][0]["layout"]})
    }

    fn classify(&mut self, args: &Value) -> Value {
        let Some(index) = self.find_index(args) else {
            return json!({"ok": false, "status": "not_found"});
        };
        let version = args["contentVersion"].as_i64().unwrap_or(self.notes()[index]["contentVersion"].as_i64().unwrap_or(1));
        let applied = apply_classification(&mut self.notes_mut()[index], args, version);
        let note = self.notes()[index].clone();
        json!({"ok": applied, "status": if applied { "classified" } else { "stale" }, "note": note})
    }

    fn find_index(&self, args: &Value) -> Option<usize> {
        if let Some(id) = args["id"].as_str() {
            return self.notes().iter().position(|note| note["id"].as_str() == Some(id));
        }
        match self.hits(args) {
            Hits::One(index) => Some(index),
            _ => None,
        }
    }

    fn ambiguous_or_missing(&self, args: &Value, _tool: &str) -> Value {
        match self.hits(args) {
            Hits::Many(choices) => json!({"ok": false, "status": "choose", "choices": choices}),
            _ => json!({"ok": false, "status": "not_found", "error": "not_found"}),
        }
    }

    fn hits(&self, args: &Value) -> Hits {
        let query = args["query"].as_str().unwrap_or("");
        if query.is_empty() {
            return Hits::None;
        }
        let found = self.hits_list(query);
        if found.is_empty() {
            Hits::None
        } else if found.len() == 1 || found[0].0 > found.get(1).map(|hit| hit.0).unwrap_or(0) {
            Hits::One(found[0].2)
        } else {
            Hits::Many(found.into_iter().take(6).map(|(_, note, _)| json!({"id": note["id"], "title": note["title"]})).collect())
        }
    }

    fn hits_list(&self, query: &str) -> Vec<(i64, Value, usize)> {
        let terms: Vec<&str> = query.split_whitespace().filter(|word| word.len() > 1 && !matches!(*word, "the" | "a" | "my" | "note")).collect();
        let mut hits = vec![];
        for (index, note) in self.notes().iter().enumerate() {
            if !note["deletedAt"].is_null() {
                continue;
            }
            let title = note["title"].as_str().unwrap_or("").to_lowercase();
            let body = note["content"].as_str().unwrap_or("").to_lowercase();
            let mut score = 0;
            for term in &terms {
                let term = term.to_lowercase();
                if title.contains(&term) {
                    score += 5;
                } else if body.contains(&term) {
                    score += 3;
                }
            }
            if score > 0 {
                hits.push((score, note.clone(), index));
            }
        }
        hits.sort_by(|a, b| b.0.cmp(&a.0));
        hits
    }

    fn notes(&self) -> &Vec<Value> {
        self.state["notes"].as_array().unwrap()
    }

    fn notes_mut(&mut self) -> &mut Vec<Value> {
        self.state["notes"].as_array_mut().unwrap()
    }

    fn save(&self) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&self.path, serde_json::to_string_pretty(&self.state).unwrap_or_else(|_| "{}".into()))
    }
}

enum Hits {
    None,
    One(usize),
    Many(Vec<Value>),
}

/// A random id like Node's crypto.randomUUID(), so a note made here never reuses an id already in the file.
fn new_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("random id");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// An ISO time, the same shape Node writes. Node empties the trash by this date, so a word here would lose the note.
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn empty() -> Value {
    json!({
        "version": 1,
        "boards": [{"id": "board-main", "background": "wood", "layout": "freeform", "sort": "manual", "zoom": 1, "panX": 40, "panY": 30}],
        "notes": [],
        "links": [],
    })
}

/// A locked title stays. A reply for an older edit is ignored.
pub fn apply_classification(note: &mut Value, raw: &Value, response_version: i64) -> bool {
    if note["contentVersion"].as_i64() != Some(response_version) {
        return false;
    }
    if !note["titleLocked"].as_bool().unwrap_or(false) {
        if let Some(title) = raw["title"].as_str() {
            note["title"] = json!(title);
            note["titleSource"] = json!("ai");
        }
    }
    if !note["priorityLocked"].as_bool().unwrap_or(false) {
        if let Some(priority) = raw["priority"].as_str() {
            note["priority"] = json!(priority);
            note["prioritySource"] = json!("ai");
        }
    }
    if let Some(task) = raw["isTask"].as_bool() {
        note["isTask"] = json!(task);
    }
    note["metadataVersion"] = json!(response_version);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Stickies, PathBuf) {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!("stickies-rust-{}-{}.json", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_file(&path);
        (Stickies::open(&path), path)
    }

    #[test]
    fn create_search_and_disambiguate_before_delete() {
        let (mut desk, path) = store();
        desk.dispatch("sticky_note_create", &json!({"content": "Canceled meeting", "title": "Canceled meeting", "x": 10, "y": 10}));
        desk.dispatch("sticky_note_create", &json!({"content": "Team meeting", "title": "Team meeting", "x": 30, "y": 40}));
        let found = desk.dispatch("sticky_note_search", &json!({"query": "meeting"}));
        assert_eq!(found["notes"].as_array().unwrap().len(), 2);
        let deleted = desk.dispatch("sticky_note_delete", &json!({"query": "meeting"}));
        assert_eq!(deleted["status"].as_str(), Some("choose"));
        assert!(desk.dispatch("sticky_note_search", &json!({"query": "meeting"}))["notes"].as_array().unwrap().len() == 2);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn archive_restore_keeps_position_and_task_keeps_id() {
        let (mut desk, path) = store();
        let made = desk.dispatch("sticky_note_create", &json!({"content": "Conference slides", "title": "Conference", "x": 12.0, "y": 18.0}));
        let id = made["note"]["id"].as_str().unwrap().to_string();
        desk.dispatch("sticky_note_archive", &json!({"id": id}));
        let back = desk.dispatch("sticky_note_restore", &json!({"id": id}));
        assert!(back["note"]["archivedAt"].is_null());
        assert_eq!(back["note"]["positionX"].as_f64(), Some(12.0));
        let task = desk.dispatch("sticky_note_convert_to_task", &json!({"id": id, "priority": "high"}));
        assert_eq!(task["note"]["id"].as_str(), Some(id.as_str()));
        assert_eq!(task["note"]["noteType"].as_str(), Some("task"));
        assert_eq!(task["note"]["content"].as_str(), Some("Conference slides"));
        let note = desk.dispatch("sticky_note_convert_to_note", &json!({"id": id}));
        assert_eq!(note["note"]["id"].as_str(), Some(id.as_str()));
        assert_eq!(note["note"]["content"].as_str(), Some("Conference slides"));
        let sorted = desk.dispatch("sticky_note_sort", &json!({"sort": "title-asc", "layout": "organized"}));
        assert_eq!(sorted["ok"].as_bool(), Some(true));
        assert_eq!(desk.state["notes"][0]["positionX"].as_f64(), Some(12.0));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reopened_file_gets_new_ids_and_real_times() {
        let (mut desk, path) = store();
        let first = desk.dispatch("sticky_note_create", &json!({"content": "One"}))["note"]["id"].clone();
        let mut again = Stickies::open(&path);
        let second = again.dispatch("sticky_note_create", &json!({"content": "Two"}))["note"]["id"].clone();
        assert_ne!(first, second);
        let gone = again.dispatch("sticky_note_delete", &json!({"id": second, "confirm": true}));
        assert!(chrono::DateTime::parse_from_rfc3339(gone["note"]["deletedAt"].as_str().unwrap()).is_ok());
        fs::write(&path, "{}").unwrap();
        let mut bare = Stickies::open(&path);
        assert_eq!(bare.dispatch("sticky_note_search", &json!({"query": "one"}))["notes"].as_array().unwrap().len(), 0);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn locked_title_and_stale_reply() {
        let (mut desk, path) = store();
        let made = desk.dispatch("sticky_note_create", &json!({"content": "Mobile application review", "title": "My title"}));
        let id = made["note"]["id"].as_str().unwrap();
        let labeled = desk.dispatch("sticky_note_classify", &json!({"id": id, "title": "Other title", "priority": "high", "isTask": true, "contentVersion": 1}));
        assert_eq!(labeled["note"]["title"].as_str(), Some("My title"));
        assert_eq!(labeled["note"]["priority"].as_str(), Some("high"));
        let stale = desk.dispatch("sticky_note_classify", &json!({"id": id, "title": "Old", "priority": "low", "contentVersion": 0}));
        assert_eq!(stale["status"].as_str(), Some("stale"));
        assert_eq!(stale["note"]["priority"].as_str(), Some("high"));
        let _ = fs::remove_file(path);
    }
}
