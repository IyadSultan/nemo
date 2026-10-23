//! Zotero questions (src/team.rs): the lead gets zotero-mcp with read-only tools, and the planner does not.
//! Its own file, because it sets CLAUDE_BIN for the whole test process.

use nemo_realtime_voice::team::{self, Request};
use serde_json::Value;
use std::os::unix::fs::PermissionsExt;

// Records each call's arguments on one line and answers with no helpers, so only the planner and lead run.
const ARGS_FAKE: &str = r#"#!/bin/sh
echo "$*" >> "$FAKE_LOG"
cat > /dev/null
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"{\"helpers\":[]}"}}}'
echo '{"type":"result","is_error":false,"result":"x","usage":{"input_tokens":1,"output_tokens":1}}'
"#;

#[tokio::test]
async fn zotero_questions_give_the_lead_read_only_zotero_tools() {
    let dir = std::env::temp_dir().join(format!("team-zotero-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("claude");
    std::fs::write(&bin, ARGS_FAKE).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let log = dir.join("args.log");
    std::env::set_var("CLAUDE_BIN", &bin);
    std::env::set_var("FAKE_LOG", &log);

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let req = Request {
        system: "Answer briefly.".into(),
        prompt: "Search my Zotero for neuroblastoma".into(),
        lead_model: "opus".into(),
        effort: None,
        dirs: vec![],
        workspace: None,
        zotero: true,
    };
    team::run(req, tx).await;
    let calls: Vec<String> = std::fs::read_to_string(&log).unwrap().lines().map(String::from).collect();
    assert_eq!(calls.len(), 2, "{calls:?}");
    // The planner only plans; the lead gets zotero-mcp with read tools only.
    assert!(!calls[0].contains("--mcp-config"));
    assert!(calls[1].contains("--mcp-config") && calls[1].contains("zotero-mcp"));
    assert!(calls[1].contains("mcp__zotero__zotero_search_items"));
    assert!(!calls[1].contains("zotero_create") && !calls[1].contains("zotero_update") && !calls[1].contains("zotero_delete"));
}
