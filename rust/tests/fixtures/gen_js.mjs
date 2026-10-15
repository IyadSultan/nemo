// Regenerate: node rust/tests/fixtures/gen_js.mjs > rust/tests/fixtures/js.json
//
// Ground truth for rust/src/js.rs: what Node's regex and path functions return.
// Every regex is run on every input with test, match, and replace.

import path from "node:path";

const R = String.raw;
const regexes = [
  // openfile.js
  [R`^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+|would\s?you\s+)?(?:please\s+)?(?:open|pull up|bring up|edit|read)\s+(?:up\s+)?(?:my\s+|the\s+)?(.+?)(?:\s+(file|note|document|doc|page|word file|pdf))?(?:\s+for me)?(?:\s+please)?[?.!]*$`, "i"],
  [R`\b(?:e-?mails?|mail|inbox|outlook|calendar|meetings?|messages?)\b`, "i"],
  [R`^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+)?(?:please\s+)?(?:find|search for|look for|locate|where is)\s+(?:my\s+|the\s+|a\s+)?(.+?)\s+(?:file\s+|document\s+)?(?:on|in)\s+(?:my\s+|the\s+)?(?:mac|computer|laptop|finder)[?.!]*$`, "i"],
  [R`^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+)?search\s+(?:my\s+|the\s+)?(?:finder|mac|computer)\s+for\s+(?:my\s+|the\s+|a\s+)?(.+?)[?.!]*$`, "i"],
  [R`^(?:number\s+|the\s+)?(one|two|three|1|2|3|first|second|third)(?:\s+one)?$`, "i"],
  [R`\/(?:Library|node_modules|\.[^/]+|[^/]+\.app|tmp|venv|site-packages)\/`, ""],
  [R`\s+(?:file|document|doc|word file|pdf|presentation|spreadsheet)$`, "i"],
  [R`\s+dot\s+(md|pdf|docx?)\b`, "g"],
  [R`\.(md|pdf|docx?)$`, ""],
  [R`[^\p{L}\p{N}]+`, "gu"],
  [R`^["“'\s.,]+|["”'\s]+$`, "g"],
  [R`^(?:hey,?\s+)?(?:please\s+)?(?:can\s?you\s+|could\s?you\s+|would\s?you\s+)?(?:please\s+)?read\b`, "i"],
  [R`\b(?:word|docx?|dot\s+docx?)\b`, "i"],
  [R`\b(?:word\s+(?:documents?|docs?|files?)|docx?|dot\s+docx?)\b`, "i"],
  [R`\.(?:docx?|dot\s+docx?)\b`, "gi"],
  [R`\b(?:word|documents?|docs?|files?|docx)\b`, "gi"],
  [R`\s+`, "g"],
  [R`(?:\.|\bdot\s+)(?:md|pdf|docx?)\b`, "i"],
  [R`\bword\b`, "i"],
  [R`\.(md|pdf|docx?)$`, "i"],
  [R`\s+dot\s+\w+$`, "i"],
  [R`\s+dot\s+(\w+)$`, "i"],
  [R`\.\w+$`, ""],
  [R`[\p{L}\p{N}]+`, "gu"],
  [R`^(?:it|that|this|one|the one|that one|this one|same one|we discussed|one we discussed|document we discussed|file we discussed|the one we discussed)$`, "i"],
  [R`[?.!]+$`, "g"],
  [R`\b(?:word|docx?)\b`, "i"],
  [R`[_]+`, "g"],
  [R`y$`, ""],
  // translator edge cases
  [R`a.c`, ""],
  [R`a.c`, "s"],
  [R`a.c`, "g"],
  [R`[\s\S]+`, ""],
  [R`[^\s\d]+`, "g"],
  [R`[\w.-]+@[\w.-]+`, "g"],
  [R`é|\x41`, "g"],
  [R`x{2}|{a}|}`, "g"],
  [R`[[a]`, "g"],
  [R`[a&&b~]`, "g"],
  [R`(?<word>\w+) (\w+)`, ""],
  [R`^b`, "m"],
  [R`\Bb\B`, "g"],
];

const inputs = [
  "open my todo.md file",
  "Hey, can you please open the grant budget document for me please?",
  "Could you read the protocol word document",
  "read the news",
  "open the email from Sara",
  "open to-do dot md",
  "Find the grant budget on my Mac",
  "search my finder for a lonely plan.",
  "number two",
  "The Third one",
  "/Users/x/Library/a.txt and /Users/x/.git/b and /A/Foo.app/c and /Users/x/docs/f",
  "  “Open it.”  ",
  "café Ünïcode مرحبا ١٢٣ x_y z-9",
  "a\nc abc a c a\rc",
  "mail@x.com, a.b-c@d.e",
  "xx {a} } é A",
  "[a] & b ~",
  "hello world\nbig bob",
  "Reading_my__file_name",
  "lazy y",
  "",
];

const run = (src, flags, input) => {
  const fresh = () => new RegExp(src, flags);
  return {
    test: fresh().test(input),
    match: input.match(fresh()),
    replace: input.replace(fresh(), "<$1|$&|$$>"),
  };
};

const paths = [
  ".bashrc", "..", "...", "..a", "a.", "a.b.c", ".a.b", "dir/.x", "dir/a.b/", "a", "/", "", "x/", "/a",
  "/Users/me/notes/wiki/todo.md", "notes//sub/../x.docx", "./a/./b/", "/../a", "../../a/b", "/root/notes", "/root/notes/a/b.pdf", "/root/notesx/y", "/root", "/other/z",
];
const pathCases = paths.map((p) => ({
  p,
  extname: path.extname(p),
  dirname: path.dirname(p),
  basename: path.basename(p),
  basenameExt: path.basename(p, path.extname(p)),
  normalize: path.normalize(p),
  join: path.join("/root/notes", p),
  resolve: path.resolve("/root/notes", p),
  // Relative inputs depend on the working folder, so only absolute ones are compared.
  relative: path.isAbsolute(p) ? path.relative("/root/notes", p) : null,
}));

console.log(JSON.stringify({
  regexes: regexes.map(([src, flags]) => ({ src, flags, results: inputs.map((input) => ({ input, ...run(src, flags, input) })) })),
  paths: pathCases,
  slices: ["abcdefg", "ab😀cd", "مرحبا بالعالم", "x"].map((s) => ({ s, len: s.length, head4: Buffer.from(s.slice(0, 4)).toString() })),
}, null, 1));
