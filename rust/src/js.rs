//! JavaScript string/regex behavior that Rust does not share by default.
//! Ported modules use these so their output matches the Node version exactly.

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
