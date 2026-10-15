// Regenerate: node rust/tests/fixtures/gen_routes.mjs > rust/tests/fixtures/routes.json
//
// server.js starts the whole app on import, so this pulls the exact source of
// the functions and route handlers being ported out of it, runs them in a small
// Express app against a temp skills folder, and records every answer.
// The Rust test sends the same requests to the Rust routes.

process.env.TZ = "Asia/Amman";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const server = await fs.readFile(path.join(repo, "second-brain/server.js"), "utf8");

/** Source text from `start` up to the end of that top-level block. */
function pick(start) {
  const at = server.indexOf(start);
  if (at < 0) throw new Error(`Not found in server.js: ${start}`);
  const ends = ["\n}\n", "\n});\n", "\n];\n"].map((end) => [server.indexOf(end, at), end]).filter(([i]) => i > 0);
  const [i, end] = ends.sort((a, b) => a[0] - b[0])[0];
  return server.slice(at, i + end.length);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routes-fixture-"));
const skillsDir = path.join(dir, "skills");
await fs.mkdir(skillsDir);
const seed = {
  "prd-simple.md": "---\nname: PRD simple\ndescription: Write a short PRD.\n---\n\nSteps here.",
  "zeta.md": "No front matter, just a body that is long enough.",
  "alpha-2.md": "---\r\nName: alpha two\r\ndescription:   spaced   \r\nother: x\r\n---\r\nBody",
  "Bad_Name.md": "---\nname: ignored\n---\nbody",
  "notes.txt": "not a skill",
  "_draft.md": "---\nname: Underscore\n---\n",
  "beta.md": "---\nname: beta\n---\n",
  "beta-upper.md": "---\nname: Beta\n---\n",
  "digits.md": "---\nname: 2 Fast\n---\n",
  "dash.md": "---\nname: - dash first\n---\n",
  "long.md": `---\nname: ${"N".repeat(100)}\ndescription: ${"d".repeat(300)}\n---\n`,
};
for (const [name, text] of Object.entries(seed)) await fs.writeFile(path.join(skillsDir, name), text);

const module = [
  'import fs from "node:fs/promises";',
  'import path from "node:path";',
  `import express from ${JSON.stringify(path.join(repo, "node_modules/express/index.js"))};`,
  "const app = express();",
  'app.use(express.json({ limit: "15mb" }));',
  `const SKILLS_DIR = ${JSON.stringify(skillsDir)};`,
  pick("const MONTH_NAMES = ["),
  pick("const SMALL_WORDS = ["),
  pick("const DAY_WORDS = ["),
  pick("function numberWord("),
  pick("function spokenYear("),
  pick("function spokenClock("),
  pick("function spokenDay("),
  pick("function hereAndNow("),
  pick("function skillFileId("),
  pick("function parseSkill("),
  pick("async function listSkills("),
  pick('app.get("/here"'),
  pick('app.get("/skills"'),
  pick('app.post("/skills"'),
  "export { app, hereAndNow };",
].join("\n\n");
await fs.writeFile(path.join(dir, "routes.mjs"), module);

const RealDate = Date;
globalThis.__now = 0;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [globalThis.__now]));
  }
  static now() {
    return globalThis.__now;
  }
};
const { app, hereAndNow } = await import(path.join(dir, "routes.mjs"));
const listener = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${listener.address().port}`;

// Amman local times (UTC+3) covering every part of the day and minute form.
const times = [
  [2026, 9, 15, 6, 0], [2026, 9, 15, 9, 7], [2026, 9, 15, 12, 0], [2026, 9, 15, 16, 59], [2026, 9, 15, 17, 30],
  [2026, 9, 15, 21, 11], [2026, 9, 15, 22, 0], [2026, 9, 15, 0, 7], [2026, 9, 15, 4, 59], [2026, 9, 15, 5, 0],
  [2000, 0, 1, 13, 45], [2009, 1, 28, 23, 20], [2010, 11, 31, 11, 11], [1999, 6, 4, 10, 10], [2101, 2, 3, 8, 40],
].map(([y, mo, d, h, mi]) => RealDate.UTC(y, mo, d, h - 3, mi));
const heres = times.map((ms) => {
  globalThis.__now = ms;
  return { ms, text: hereAndNow() };
});

const requests = [
  ["GET", "/skills"],
  ["POST", "/skills", { text: "too short" }],
  ["POST", "/skills", { text: "x".repeat(80001) }],
  ["POST", "/skills", { text: "   Plenty of words for a skill body here.   ", name: "My New Skill.md" }],
  ["POST", "/skills", { text: "---\nname: From Front\ndescription: Has front matter\n---\nBody of the skill text." }],
  ["POST", "/skills", { text: "Another body that is long enough to keep.", name: "!!!" }],
  ["POST", "/skills", { text: "A body with a multi-line name that is long.", name: "Line one\nline two" }],
  ["POST", "/skills", { text: "Numeric name body that is long enough.", name: 42 }],
  ["POST", "/skills", { text: 12345 }],
  ["POST", "/skills", "not json"],
  ["GET", "/skills"],
  ["GET", "/here"],
];
globalThis.__now = RealDate.UTC(2026, 9, 15, 14, 5);
const answers = [];
for (const [method, url, body] of requests) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = typeof body === "string" ? "text/plain" : "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(base + url, init);
  answers.push({ method, url, body: body ?? null, status: res.status, answer: await res.json() });
}
const files = {};
for (const name of (await fs.readdir(skillsDir)).sort()) files[name] = await fs.readFile(path.join(skillsDir, name), "utf8");

listener.close();
console.log(JSON.stringify({ seed, heres, now: globalThis.__now, answers, files }, null, 1));
await fs.rm(dir, { recursive: true });
