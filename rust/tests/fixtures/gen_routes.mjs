// Regenerate: node rust/tests/fixtures/gen_routes.mjs > rust/tests/fixtures/routes.json
//
// server.js starts the whole app on import, so this pulls the exact source of
// the functions being ported out of it and runs them with a fixed clock.
// The Rust test checks its answers against these.

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
const module = [
  pick("const MONTH_NAMES = ["),
  pick("const SMALL_WORDS = ["),
  pick("const DAY_WORDS = ["),
  pick("function numberWord("),
  pick("function spokenYear("),
  pick("function spokenClock("),
  pick("function spokenDay("),
  pick("function hereAndNow("),
  "export { hereAndNow };",
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
const { hereAndNow } = await import(path.join(dir, "routes.mjs"));

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

console.log(JSON.stringify({ heres }, null, 1));
await fs.rm(dir, { recursive: true });
