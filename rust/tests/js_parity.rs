//! Golden test: rust/src/js.rs must behave like Node's regex and path functions.
//! Fixture comes from `node rust/tests/fixtures/gen_js.mjs`.

use nemo_realtime_voice::js::{self, path, JsRe};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/js.json")).unwrap()
}

#[test]
fn regexes_match_node() {
    let mut checked = 0;
    for r in fixture()["regexes"].as_array().unwrap() {
        let (src, flags) = (r["src"].as_str().unwrap(), r["flags"].as_str().unwrap());
        let re = JsRe::new(src, flags);
        for case in r["results"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let ctx = format!("/{src}/{flags} on {input:?}");
            assert_eq!(json!(re.test(input)), case["test"], "test {ctx}");
            let matched = if flags.contains('g') {
                let all = re.match_all(input);
                if all.is_empty() { Value::Null } else { json!(all) }
            } else {
                json!(re.exec(input))
            };
            // Node's match array also carries index/input/groups; JSON keeps only the items.
            assert_eq!(matched, case["match"], "match {ctx}");
            assert_eq!(json!(re.replace(input, "<$1|$&|$$>")), case["replace"], "replace {ctx}");
            checked += 1;
        }
    }
    assert!(checked > 800, "only {checked} cases");
}

#[test]
fn paths_match_node() {
    for c in fixture()["paths"].as_array().unwrap() {
        let p = c["p"].as_str().unwrap();
        assert_eq!(json!(path::extname(p)), c["extname"], "extname {p:?}");
        assert_eq!(json!(path::dirname(p)), c["dirname"], "dirname {p:?}");
        assert_eq!(json!(path::basename(p)), c["basename"], "basename {p:?}");
        assert_eq!(json!(path::basename_without(p, &path::extname(p))), c["basenameExt"], "basename ext {p:?}");
        assert_eq!(json!(path::normalize(p)), c["normalize"], "normalize {p:?}");
        assert_eq!(json!(path::join("/root/notes", p)), c["join"], "join {p:?}");
        assert_eq!(json!(path::resolve("/root/notes", p)), c["resolve"], "resolve {p:?}");
        if !c["relative"].is_null() {
            assert_eq!(json!(path::relative("/root/notes", p)), c["relative"], "relative {p:?}");
        }
    }
}

#[test]
fn utf16_lengths_match_node() {
    for c in fixture()["slices"].as_array().unwrap() {
        let s = c["s"].as_str().unwrap();
        assert_eq!(json!(js::len16(s)), c["len"]);
        assert_eq!(json!(js::slice16(s, 0, 4)), c["head4"]);
    }
}
