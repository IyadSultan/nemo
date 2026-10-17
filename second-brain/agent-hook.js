/**
 * Claude Code and Cursor call this when you send a prompt, and again when
 * the reply is done. It hands the note to the brain app and exits at once,
 * so a slow summary never holds up the Terminal.
 *
 * A failure here must not stop Claude. This script always exits 0.
 */

const URL = process.env.BRAIN_HOOK_URL || "http://127.0.0.1:3001/agents/hook";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks).toString("utf8").trim();

if (body.startsWith("{")) {
  const timer = AbortSignal.timeout(2000);
  try {
    await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: timer,
    });
  } catch {
    // The brain app may be closed. The Terminal should keep going.
  }
}
process.exit(0);
