//! Skills, from `second-brain/server.js` (parseSkill, skillFileId, listSkills,
//! and the GET/POST /skills handlers).
//!
//! Every markdown file in second-brain/skills is one skill the voice can use.
//! A skill file can start with a short name and description between --- lines.
//! Node reads this folder fresh on every question, so files Rust saves are seen at once.

use crate::{js, js_re};
use serde::Serialize;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip)]
    pub body: String,
}

pub fn parse_skill(text: &str, id: &str) -> Skill {
    let mut name = id.to_string();
    let mut description = String::new();
    let mut body = js::trim(text).to_string();
    if let Some(front) = js_re!(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?", "").exec(text) {
        let whole = front[0].as_deref().unwrap_or("");
        body = js::trim(&text[whole.len()..]).to_string();
        for line in js_re!(r"\r?\n", "").split(front[1].as_deref().unwrap_or("")) {
            let Some(m) = js_re!(r"^([A-Za-z]+):\s*(.*)$", "").exec(line) else { continue };
            let key = m[1].as_deref().unwrap_or("").to_lowercase();
            let value = js::trim(m[2].as_deref().unwrap_or(""));
            if key == "name" && !value.is_empty() {
                name = value.to_string();
            }
            if key == "description" {
                description = value.to_string();
            }
        }
    }
    Skill {
        id: id.to_string(),
        name: js::slice16(&name, 0, 80),
        description: js::slice16(&description, 0, 240),
        body: js::slice16(&body, 0, 20000),
    }
}

/// "PRD simple" becomes the file name prd-simple.
pub fn skill_file_id(name: &str) -> String {
    let s = js_re!(r"\.md$", "i").replace(&name.to_lowercase(), "");
    let s = js_re!(r"[^a-z0-9]+", "g").replace(&s, "-");
    let s = js_re!(r"^-+|-+$", "g").replace(&s, "");
    js::slice16(&s, 0, 60)
}

fn valid_id(id: &str) -> bool {
    js_re!(r"^[a-z0-9][a-z0-9-]{0,59}$", "").test(id)
}

/// Close to JS `a.localeCompare(b)` for skill names: case and accents matter
/// only to break ties; spaces sort before punctuation, then digits, then letters.
fn locale_compare(a: &str, b: &str) -> Ordering {
    fn class(c: char) -> u8 {
        if c.is_whitespace() {
            0
        } else if c.is_ascii_punctuation() && !"$+<=>^`|~".contains(c) {
            1
        } else if c.is_ascii_punctuation() {
            2
        } else if c.is_numeric() {
            3
        } else {
            4
        }
    }
    let key = |s: &str| s.chars().map(|c| (class(c), c.to_lowercase().collect::<String>())).collect::<Vec<_>>();
    // Ties: lowercase before uppercase, as ICU does.
    let tie = |s: &str| s.chars().map(|c| !c.is_lowercase()).collect::<Vec<_>>();
    key(a).cmp(&key(b)).then_with(|| tie(a).cmp(&tie(b)))
}

pub fn list_skills(dir: &Path) -> Vec<Skill> {
    let names = match std::fs::read_dir(dir) {
        Ok(entries) => entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>(),
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Failed while reading skills: {err}");
            }
            return Vec::new();
        }
    };
    let mut skills = Vec::new();
    for file in names {
        let Some(id) = file.strip_suffix(".md") else { continue };
        if !valid_id(id) {
            continue;
        }
        match std::fs::read_to_string(dir.join(&file)) {
            Ok(text) => skills.push(parse_skill(&text, id)),
            Err(err) => eprintln!("Failed while reading a skill: {err}"),
        }
    }
    skills.sort_by(|a, b| locale_compare(&a.name, &b.name));
    skills
}

/// Save a markdown skill the user uploaded from the voice page.
/// `name` is the name the page sent (may be empty). Err is (HTTP status, message).
pub fn save_skill(dir: &Path, text: &str, name: &str) -> Result<Skill, (u16, String)> {
    if js::len16(js::trim(text)) < 20 {
        return Err((400, "That file is too short to be a skill.".into()));
    }
    if js::len16(text) > 80000 {
        return Err((400, "That skill file is too long.".into()));
    }
    let hinted = parse_skill(text, "draft");
    let wanted = if name.is_empty() { hinted.name.as_str() } else { name };
    let id = skill_file_id(wanted);
    if id.is_empty() || !valid_id(&id) {
        return Err((400, "Give the skill a name made of letters and numbers.".into()));
    }
    let file: PathBuf = dir.join(format!("{id}.md"));
    if file.parent() != Some(dir) {
        return Err((400, "That name is not allowed.".into()));
    }
    let mut saved = js::trim(text).to_string();
    if !saved.starts_with("---") {
        let title = js_re!(r"[\r\n]", "g").replace(wanted, " ");
        saved = format!("---\nname: {}\ndescription: A skill you uploaded.\n---\n\n{saved}\n", js::slice16(&title, 0, 80));
    }
    let written = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&file, format!("{}\n", js::trim(&saved))));
    if let Err(err) = written {
        eprintln!("Failed while saving a skill: {err}");
        return Err((500, "Could not save the skill.".into()));
    }
    Ok(parse_skill(&saved, &id))
}
