//! JavaScript string, regex, and path behavior that Rust does not share by default.
//! Ported modules use these so their output matches the Node version exactly.

use regex::{Captures, Regex};
use serde_json::Value;

/// JS `\s` and `trim()` whitespace. Rust's set differs: JS adds U+FEFF, drops U+0085.
/// Use inside a regex class: `[{JS_SPACE}]`.
pub const JS_SPACE: &str =
    r"\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// JS `\b`: ASCII word boundary (Rust's `\b` is Unicode-aware).
pub const JS_B: &str = r"(?-u:\b)";

pub fn is_js_space(c: char) -> bool {
    matches!(c as u32, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

/// JS `String.prototype.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// JS truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// JS `String(v || "")` for JSON values.
pub fn to_str(v: &Value) -> String {
    match v {
        _ if !truthy(v) => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { to_str(x) }).collect::<Vec<_>>().join(","),
        other => other.to_string(),
    }
}

/// JS `s.length` (UTF-16 units).
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(start, end)` on UTF-16 units. A split surrogate pair becomes U+FFFD.
pub fn slice16(s: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let end = end.min(units.len());
    String::from_utf16_lossy(&units[start.min(end)..end])
}

/// A JS regex literal, translated to the Rust `regex` crate.
///
/// Translated: `\d \w \s \b` (and negations) to JS's ASCII/JS-space meaning, `.` to
/// "not a line terminator", `\uXXXX`, literal `{`, `[` inside classes. Flags: `i`, `g`,
/// `s`, `m`, `u`. Lookaround and backreferences are not supported (panics at build).
/// Known gap: with `i`, Rust also folds ſ→s, K (Kelvin)→k, Å (Angstrom)→å; JS does not.
pub struct JsRe {
    re: Regex,
    global: bool,
}

/// `js_re!(r"^\s+", "g")`: a JS regex compiled once.
#[macro_export]
macro_rules! js_re {
    ($src:literal, $flags:literal) => {{
        static RE: std::sync::LazyLock<$crate::js::JsRe> =
            std::sync::LazyLock::new(|| $crate::js::JsRe::new($src, $flags));
        &*RE
    }};
}

const WORD: &str = "0-9A-Za-z_";

fn translate(src: &str, flags: &str) -> String {
    let dot_all = flags.contains('s');
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::new();
    if flags.contains('i') {
        out.push_str("(?i)");
    }
    if flags.contains('m') {
        out.push_str("(?m)");
    }
    let mut i = 0;
    let mut in_class = false;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                i += 1;
                let e = *chars.get(i).unwrap_or_else(|| panic!("JS regex ends with \\: {src}"));
                let class_or = |inside: &str, neg_outside: bool| -> String {
                    match (in_class, neg_outside) {
                        (true, false) => inside.to_string(),
                        (true, true) => format!("[^{inside}]"),
                        (false, false) => format!("[{inside}]"),
                        (false, true) => format!("[^{inside}]"),
                    }
                };
                match e {
                    'd' => out.push_str(&class_or("0-9", false)),
                    'D' => out.push_str(&class_or("0-9", true)),
                    'w' => out.push_str(&class_or(WORD, false)),
                    'W' => out.push_str(&class_or(WORD, true)),
                    's' => out.push_str(&class_or(JS_SPACE, false)),
                    'S' => out.push_str(&class_or(JS_SPACE, true)),
                    'b' if in_class => out.push_str(r"\x08"),
                    'b' => out.push_str(JS_B),
                    'B' => out.push_str(r"(?-u:\B)"),
                    'u' if chars.get(i + 1) == Some(&'{') => {
                        let close = (i..chars.len()).find(|&j| chars[j] == '}').expect("bad \\u{...}");
                        out.push_str(&format!(r"\x{{{}}}", chars[i + 2..close].iter().collect::<String>()));
                        i = close;
                    }
                    'u' => {
                        out.push_str(&format!(r"\x{{{}}}", chars[i + 1..i + 5].iter().collect::<String>()));
                        i += 4;
                    }
                    'x' => {
                        out.push_str(&format!(r"\x{}", chars[i + 1..i + 3].iter().collect::<String>()));
                        i += 2;
                    }
                    'p' | 'P' => {
                        let close = (i..chars.len()).find(|&j| chars[j] == '}').expect("bad \\p{...}");
                        out.extend(&chars[i - 1..=close]);
                        i = close;
                    }
                    '0' => out.push_str(r"\x00"),
                    'n' | 't' | 'r' | 'f' | 'v' => {
                        out.push('\\');
                        out.push(e);
                    }
                    '1'..='9' => panic!("JS regex backreference is not supported: {src}"),
                    other => out.push_str(&regex::escape(&other.to_string())),
                }
            }
            '[' if in_class => out.push_str(r"\["),
            '[' => {
                in_class = true;
                out.push('[');
                if chars.get(i + 1) == Some(&'^') {
                    out.push('^');
                    i += 1;
                }
                if chars.get(i + 1) == Some(&']') {
                    panic!("JS empty class [] / [^] is not supported: {src}");
                }
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            '&' | '~' if in_class => {
                out.push('\\');
                out.push(c);
            }
            '-' if in_class && chars.get(i + 1) == Some(&'-') => out.push_str(r"\-"),
            '.' if !in_class => out.push_str(if dot_all { "(?s:.)" } else { r"[^\n\r\x{2028}\x{2029}]" }),
            '(' if !in_class && chars.get(i + 1) == Some(&'?') => {
                let next = chars.get(i + 2).copied();
                let after = chars.get(i + 3).copied();
                if matches!(next, Some('=') | Some('!')) || (next == Some('<') && matches!(after, Some('=') | Some('!'))) {
                    panic!("JS regex lookaround is not supported: {src}");
                }
                out.push('(');
            }
            '{' if !in_class => {
                // A real quantifier is {n}, {n,} or {n,m}; any other { is a literal in JS.
                let rest: String = chars[i..].iter().collect();
                let quant = Regex::new(r"^\{[0-9]+(,[0-9]*)?\}").unwrap();
                match quant.find(&rest) {
                    Some(m) => {
                        out.push_str(m.as_str());
                        i += m.as_str().chars().count() - 1;
                    }
                    None => out.push_str(r"\{"),
                }
            }
            '}' if !in_class => out.push_str(r"\}"),
            other => out.push(other),
        }
        i += 1;
    }
    out
}

impl JsRe {
    pub fn new(src: &str, flags: &str) -> Self {
        assert!(!flags.contains('y'), "sticky flag is not supported: /{src}/{flags}");
        let pattern = translate(src, flags);
        let re = Regex::new(&pattern).unwrap_or_else(|e| panic!("JS regex /{src}/{flags} → {pattern}: {e}"));
        Self { re, global: flags.contains('g') }
    }

    /// `re.test(s)`. (Stateless: JS's lastIndex quirk with `g` is not copied.)
    pub fn test(&self, s: &str) -> bool {
        self.re.is_match(s)
    }

    /// `s.match(re)` without `g`: groups (index 0 = whole match), `None` for unmatched groups.
    pub fn exec(&self, s: &str) -> Option<Vec<Option<String>>> {
        self.re.captures(s).map(|c| c.iter().map(|m| m.map(|m| m.as_str().to_string())).collect())
    }

    /// `s.match(re)` with `g`: every match, or empty (JS gives null).
    pub fn match_all(&self, s: &str) -> Vec<String> {
        self.re.find_iter(s).map(|m| m.as_str().to_string()).collect()
    }

    /// `s.replace(re, repl)`: all matches with `g`, else the first. Supports `$1 $& $$ $<name>`.
    pub fn replace(&self, s: &str, repl: &str) -> String {
        self.replace_with(s, |caps| expand(caps, repl))
    }

    /// `s.replace(re, fn)`.
    pub fn replace_with(&self, s: &str, mut f: impl FnMut(&Captures) -> String) -> String {
        let limit = if self.global { 0 } else { 1 };
        self.re.replacen(s, limit, |c: &Captures| f(c)).into_owned()
    }

    /// `s.split(re)` (no capture groups in the pattern).
    pub fn split<'a>(&self, s: &'a str) -> Vec<&'a str> {
        self.re.split(s).collect()
    }
}

/// JS replacement string expansion.
fn expand(caps: &Captures, repl: &str) -> String {
    let chars: Vec<char> = repl.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '$' || i + 1 >= chars.len() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let n = chars[i + 1];
        match n {
            '$' => {
                out.push('$');
                i += 2;
            }
            '&' => {
                out.push_str(&caps[0]);
                i += 2;
            }
            '<' => match (i + 2..chars.len()).find(|&j| chars[j] == '>') {
                Some(close) => {
                    let name: String = chars[i + 2..close].iter().collect();
                    out.push_str(caps.name(&name).map_or("", |m| m.as_str()));
                    i = close + 1;
                }
                None => {
                    out.push('$');
                    i += 1;
                }
            },
            '0'..='9' => {
                // Two digits when that group exists, else one; $0 is literal.
                let groups = caps.len() - 1;
                let d1 = n.to_digit(10).unwrap() as usize;
                let two = chars.get(i + 2).and_then(|c| c.to_digit(10)).map(|d2| d1 * 10 + d2 as usize);
                if let Some(g) = two.filter(|&g| g >= 1 && g <= groups) {
                    out.push_str(caps.get(g).map_or("", |m| m.as_str()));
                    i += 3;
                } else if d1 >= 1 && d1 <= groups {
                    out.push_str(caps.get(d1).map_or("", |m| m.as_str()));
                    i += 2;
                } else {
                    out.push('$');
                    i += 1;
                }
            }
            _ => {
                out.push('$');
                i += 1;
            }
        }
    }
    out
}

/// Node's `path` module (POSIX), for code that compares paths as strings.
pub mod path {
    pub const SEP: char = '/';

    pub fn normalize(p: &str) -> String {
        if p.is_empty() {
            return ".".into();
        }
        let absolute = p.starts_with('/');
        let trailing = p.ends_with('/');
        let mut parts: Vec<&str> = Vec::new();
        for seg in p.split('/') {
            match seg {
                "" | "." => {}
                ".." if parts.last().is_some_and(|l| *l != "..") => {
                    parts.pop();
                }
                ".." if absolute => {}
                s => parts.push(s),
            }
        }
        let mut out = parts.join("/");
        if out.is_empty() && !absolute {
            out = ".".into();
        }
        if trailing && !parts.is_empty() {
            out.push('/');
        }
        if absolute {
            format!("/{out}")
        } else {
            out
        }
    }

    pub fn join(a: &str, b: &str) -> String {
        let joined = [a, b].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("/");
        normalize(&joined)
    }

    pub fn resolve(a: &str, b: &str) -> String {
        let mut p = String::new();
        for seg in [b, a] {
            if seg.is_empty() {
                continue;
            }
            p = if p.is_empty() { seg.to_string() } else { format!("{seg}/{p}") };
            if seg.starts_with('/') {
                break;
            }
        }
        if !p.starts_with('/') {
            let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
            p = if p.is_empty() { cwd } else { format!("{cwd}/{p}") };
        }
        let n = normalize(&p);
        if n.len() > 1 {
            n.trim_end_matches('/').to_string()
        } else {
            n
        }
    }

    /// `path.relative(from, to)`.
    pub fn relative(from: &str, to: &str) -> String {
        let (from, to) = (resolve(from, ""), resolve(to, ""));
        if from == to {
            return String::new();
        }
        let a: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
        let b: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
        let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
        let mut parts = vec![".."; a.len() - common];
        parts.extend(&b[common..]);
        parts.join("/")
    }

    pub fn basename(p: &str) -> String {
        let t = p.trim_end_matches('/');
        if t.is_empty() {
            return String::new();
        }
        t.rsplit('/').next().unwrap().to_string()
    }

    /// `path.basename(p, ext)`.
    pub fn basename_without(p: &str, ext: &str) -> String {
        let b = basename(p);
        match b.strip_suffix(ext) {
            Some(rest) if !ext.is_empty() && !rest.is_empty() => rest.to_string(),
            _ => b,
        }
    }

    pub fn extname(p: &str) -> String {
        let b = basename(p);
        match b.rfind('.') {
            Some(i) if i > 0 && b != ".." => b[i..].to_string(),
            _ => String::new(),
        }
    }

    pub fn dirname(p: &str) -> String {
        let t = p.trim_end_matches('/');
        if t.is_empty() {
            return if p.is_empty() { ".".into() } else { "/".into() };
        }
        match t.rfind('/') {
            None => ".".into(),
            Some(i) => match t[..i].trim_end_matches('/') {
                "" => "/".into(),
                d => d.to_string(),
            },
        }
    }
}
