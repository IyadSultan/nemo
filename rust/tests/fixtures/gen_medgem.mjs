// Regenerate: node rust/tests/fixtures/gen_medgem.mjs > rust/tests/fixtures/medgem.json
//
// 1. Runs medgem.js's private helpers (exported from a temp copy) on tricky inputs.
// 2. Runs cleanMedical() against a fake Ollama and records every request and
//    reply, so the Rust test can replay the replies and compare requests.
// All names and numbers below are made up.

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(path.join(here, "../../../second-brain/medgem.js"), "utf8");

// Fake Ollama. Main call: canned JSON by transcript. Name pass: replace "Cap Cap" pairs.
const CANNED = {
  "Hello, nice weather. The child has fever.": '{"medical":true,"english":"The child has fever.","for_brain":""}',
  "Let's get coffee.": '{"medical":false,"english":"ignored","for_brain":"ignored"}',
  "Hey, what is our protocol for febrile neutropenia?":
    '<think>short</think>{"medical":true,"english":"What is our protocol for febrile neutropenia?","for_brain":""}',
  "Sara Haddad, MRN: AB-1234, phone +962 79 111 2233, has neutropenia.":
    'Sure: {"medical":true,"english":"Sara Haddad, MRN: AB-1234, phone +962 79 111 2233, has neutropenia.","for_brain":""} done',
  "Did you give the morning dose?": '{"medical":true,"english":"Did you give the morning dose?","for_brain":"Did you give the morning dose?"}',
  "هاي شو البروتوكول": '{"medical":true,"english":"Can you find our note on vancomycin dosing?","for_brain":""}',
  "Omar Nasser born March 3, 2014 has fever": '{"medical":"yes","english":"Omar Nasser born March 3, 2014 has fever","for_brain":0}',
};
const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const json = JSON.parse(body);
    let response;
    if (json.prompt === "") response = "";
    else if (json.prompt.startsWith("Rewrite the sentence")) {
      const sentence = json.prompt.split("\n").find((l) => l.startsWith("Sentence: ")).slice(10);
      response = `"${sentence.replace(/[A-Z][a-z]+ [A-Z][a-z]+/g, "the patient")}"`;
    } else {
      const heard = json.prompt.slice(json.prompt.lastIndexOf("Heard: ") + 7);
      response = CANNED[heard];
    }
    const reply = { response, eval_count: 42 };
    requests.push({ body: json, reply });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(reply));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "medgem-fixture-"));
const copy = path.join(dir, "medgem.mjs");
await fs.writeFile(copy, `${source}\nexport { promptFor, questionForBrain, visibleText, parseCleaned, stripObviousIds };\n`);
const m = await import(copy);

const strip = [
  "Email sara.h@khcc.jo or SARA@EXAMPLE.ORG now",
  "call 0791112233 or +962 (79) 111-2233.",
  "short 12345 stays, 1234567 goes",
  "MRN: AB-1234 and mrn#99887 and File Number 445566 and national id 9981234567 and ID number X12",
  "national number: 1234 stays label-less? mrn 12 too short",
  "seen 2/2/2014 and 12-31-99 and 1/1/1 stays",
  "born March 3, 2014; DOB: Feb 2 2014; date of birth sept 9, 2001; Sep 10 1999",
  "may 5, 2020 and mayday 5, 2020",
  "Born, the child.  Two  spaces , and comma .",
  "  padded  text ﻿",
  "ſep 3, 2020 and Kelvin@x.com", // long s and Kelvin sign: JS /i does not fold these
  "Arabic digits ٠٧٩١١١٢٢٣٣ stay",
  "",
];
const questions = [
  ["Hey what is the dose", "What is the dose", ""],
  ["hey my brain, find it", "Hey my brain, can you find our note on X?", ""],
  ["  هاي شو", "هاي، what is our protocol?", ""],
  ["يا دماغي", "يا  دماغي - our protocol for fever", ""],
  ["the dose", "Can you find our note on dosing?", ""],
  ["the dose", "Did you give it?", ""],
  ["the dose", "Did you find our note?", ""],
  ["Hey", "Did you give it?", ""],
  ["the dose", "", "Could you check vitals?"],
  ["the dose", "", "What is the protocol?"],
  ["heyday", "What is the dose", ""],
  ["the dose", "what did I write yesterday", ""],
  ["the dose", "Hey ourprotocol", ""],
];
const visible = ["<think>a\nb</think> answer ", "<THINK>x</Think>{}<think>y</think>", "no think", ""];
const parse = ['{"a":1}', ' <think>t</think> {"medical":true} ', 'pre {"x":{"y":2}} post', "nothing here", "{ broken"];

const helpers = {
  prompt: m.promptFor("Patient has fever."),
  strip: strip.map((s) => [s, m.stripObviousIds(s)]),
  questions: questions.map(([raw, english, fromModel]) => ({ raw, english, fromModel, result: m.questionForBrain(raw, english, fromModel) })),
  visible: visible.map((s) => [s, m.visibleText(s)]),
  parse: parse.map((s) => {
    try {
      return { input: s, ok: m.parseCleaned(s) };
    } catch {
      return { input: s, ok: null };
    }
  }),
};

const log = console.log;
console.log = () => {};
const cases = [];
for (const text of Object.keys(CANNED)) {
  requests.length = 0;
  const result = await m.cleanMedical(text);
  delete result.ms;
  cases.push({ text, result, requests: [...requests] });
}
requests.length = 0;
await m.warmMedgem();
const warm = requests[0].body;
console.log = log;

console.log(JSON.stringify({ helpers, cases, warm }, null, 1));
await fs.rm(dir, { recursive: true });
server.close();
