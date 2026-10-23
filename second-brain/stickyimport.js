// A web page as sticky notes. A GitHub link reads the README, a PubMed link the abstract,
// a PDF its first pages, and any other page its headings and paragraphs. The text goes to
// the model (stickies.js, mode "import"), which turns it into at most ten notes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { isPublicWebUrl, decodeHtml } from "./web.js";
import { parseArticles } from "./pubmed.js";

const PDFTOTEXT = "/opt/homebrew/bin/pdftotext";
const MAX_CHARS = 14_000;
const MAX_BYTES = 25 * 1024 * 1024;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** http(s) to a public host. The file type does not matter here; a PDF is welcome. */
export function importableUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    return isPublicWebUrl(`${url.origin}/`) ? url : null;
  } catch {
    return null;
  }
}

function get(url, accept, timeout = 15_000) {
  return fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "follow", headers: { "User-Agent": UA, Accept: accept } });
}

/** Headings and paragraphs of an HTML page, in order, up to MAX_CHARS. */
export function articleText(html) {
  const body = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  const title = decodeHtml(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const blocks = [...body.matchAll(/<(h[1-4]|p|li|td)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map(([, tag, inner]) => {
      const text = decodeHtml(inner).replace(/\s+/g, " ").trim();
      return /^h/.test(tag) ? `\n## ${text}` : text;
    })
    .filter((line) => line.length > 30 || line.startsWith("\n##"));
  const text = (blocks.length ? blocks.join("\n") : decodeHtml(body).replace(/\s+/g, " ")).trim();
  return { title, text: text.slice(0, MAX_CHARS) };
}

async function pdfText(bytes) {
  const file = path.join(os.tmpdir(), `sticky-import-${crypto.randomBytes(4).toString("hex")}.pdf`);
  await fs.writeFile(file, bytes);
  try {
    const text = await new Promise((resolve, reject) => {
      execFile(PDFTOTEXT, ["-l", "12", "-enc", "UTF-8", file, "-"], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, out) => (err ? reject(err) : resolve(out)));
    });
    return text.replace(/\f/g, "\n").replace(/[ \t]+\n/g, "\n").slice(0, MAX_CHARS);
  } finally {
    await fs.rm(file, { force: true });
  }
}

async function github(url) {
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  const name = repo.replace(/\.git$/, "");
  const api = `https://api.github.com/repos/${owner}/${name}`;
  const [about, readme] = await Promise.all([
    get(api, "application/vnd.github+json", 10_000).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    get(`${api}/readme`, "application/vnd.github.raw", 15_000).then((r) => (r.ok ? r.text() : "")).catch(() => ""),
  ]);
  const head = about ? `${about.full_name}: ${about.description || ""}\nLanguage: ${about.language || "?"}. Stars: ${about.stargazers_count ?? "?"}. Topics: ${(about.topics || []).join(", ")}.` : `${owner}/${name}`;
  if (!readme && !about) return null;
  return { kind: "github", title: about?.full_name || `${owner}/${name}`, text: `${head}\n\n${readme}`.slice(0, MAX_CHARS) };
}

async function pubmed(url) {
  const id = url.pathname.match(/\/(\d{5,9})\/?$/)?.[1];
  if (!id) return null;
  const response = await get(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${new URLSearchParams({ db: "pubmed", id, retmode: "xml", tool: "talk_to_your_brain" })}`, "text/xml", 10_000);
  if (!response.ok) return null;
  const [article] = parseArticles(await response.text());
  if (!article) return null;
  return { kind: "paper", title: article.title.replace(/^PubMed: /, ""), text: article.text };
}

/** { kind, title, text } for the page, or a thrown error that says why not. */
export async function fetchForImport(raw) {
  const url = importableUrl(raw);
  if (!url) throw new Error("That is not a web address I can read.");
  const host = url.hostname.replace(/^www\./, "");
  if (host === "github.com") {
    const found = await github(url);
    if (found) return found;
  }
  if (host === "pubmed.ncbi.nlm.nih.gov") {
    const found = await pubmed(url);
    if (found) return found;
  }
  const response = await get(url.href, "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5");
  if (!response.ok) throw new Error(`The page answered ${response.status}.`);
  const kind = (response.headers.get("content-type") || "").toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error("That page is too big to read.");
  if (kind.includes("application/pdf") || bytes.subarray(0, 5).toString() === "%PDF-") {
    const text = await pdfText(bytes);
    if (!text.trim()) throw new Error("The PDF has no text I can read.");
    return { kind: "paper", title: text.split("\n").find((line) => line.trim().length > 20)?.trim().slice(0, 120) || url.href, text };
  }
  const page = articleText(bytes.toString("utf8"));
  if (page.text.length < 200) throw new Error("The page has too little text to read.");
  const paper = /doi\.org|pubmed|nejm|thelancet|jamanetwork|bmj\.com|nature\.com|sciencedirect|springer|wiley|academic\.oup|ascopubs|ashpublications|medrxiv|biorxiv|arxiv/.test(host);
  return { kind: paper ? "paper" : "page", title: page.title || url.href, text: page.text };
}
