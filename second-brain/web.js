/**
 * The web from this Mac: decide when a question needs fresh facts, search DuckDuckGo,
 * read a page down to plain text, and open a site the user named.
 */

import { isChatQuestion, isVaultQuestion, needsFreshFacts, wantsEmail, wantsFile, wantsNews } from "./intents.js";
import { todayLabel } from "./spoken.js";

/** The web is slow (1-14s). Look only when the answer needs fresh facts. */
export function shouldBrowse(question) {
  const cleaned = question.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
  const skip = new Set([
    "hi",
    "hello",
    "hey",
    "can you hear me",
    "are you there",
    "thank you",
    "thanks",
  ]);
  if (skip.has(cleaned) || isChatQuestion(question)) return false;
  if (wantsEmail(question)) return false;
  if (wantsFile(question)) return false;
  if (isVaultQuestion(question) && !wantsNews(question)) return false;
  return cleaned.split(" ").filter(Boolean).length >= 2 && needsFreshFacts(question);
}

export function decodeHtml(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "Show me cnn.com" or "open https://www.cnn.com" opens that page in the browser.
 * A file name such as todo.md is not a web page.
 */
export function showSiteJob(question) {
  const q = String(question || "").trim().replace(/^["“'\s.,]+|["”'\s.?!]+$/g, "");
  const asking = /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:please\s+)?(?:show(?:\s+me)?|open|pull up|bring up|go to)\b/i.test(q);
  if (!asking) return null;
  const found = q.match(/https?:\/\/[^\s]+/i)
    || q.match(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|gov|edu|ai|co\.uk|uk|jo|news|tv|info|me)(?:\/[^\s]*)?/i);
  if (!found) return null;
  let url = found[0].replace(/[.,!?;)]+$/g, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!isPublicWebUrl(parsed.href)) return null;
    const name = parsed.hostname.replace(/^www\./, "");
    return { url: parsed.href, name };
  } catch (err) {
    console.error("Failed while reading a web address to open:", err.message);
    return null;
  }
}

/** Only fetch normal public web pages. Never call this Mac or a private network. */
export function isPublicWebUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (host === "::1" || host === "[::1]") return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return false;
    if (/\.(pdf|zip|png|jpe?g|gif|mp3|mp4|wav)$/i.test(url.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function unwrapDuckLink(href) {
  if (href.startsWith("//")) href = `https:${href}`;
  try {
    const url = new URL(href);
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

/** Turn a web page into plain sentences, and keep only the opening part. */
export function pageText(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");
  const paragraphs = [...stripped.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => decodeHtml(match[1]))
    .filter((paragraph) => paragraph.length > 40);
  const text = paragraphs.length ? paragraphs.join("\n\n") : decodeHtml(stripped);
  return text.slice(0, 1800);
}

export async function readLimitedText(response, maxBytes = 180_000) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch {
    /* the rest of a long page is not needed */
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read one search result page. A slow site is skipped so the answer can still start. */
export async function fetchPage(result) {
  try {
    const response = await fetch(result.url, {
      signal: AbortSignal.timeout(3000),
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,text/plain",
      },
    });
    if (!response.ok) return { ...result, text: result.snippet };
    const kind = response.headers.get("content-type") || "";
    if (kind && !/text\/html|text\/plain/.test(kind)) return { ...result, text: result.snippet };
    const html = await readLimitedText(response);
    const text = pageText(html);
    return { ...result, text: text || result.snippet };
  } catch (err) {
    console.error("Failed while reading a web page:", result.url, err?.message || err);
    return { ...result, text: result.snippet };
  }
}

/**
 * Look the question up on the web from this Mac.
 * DuckDuckGo returns a list of pages. We keep four and use their snippets.
 * Only news reads one full page, since headlines need more than a snippet.
 * The model never connects to the internet itself.
 */
export async function searchWeb(question, { force = false } = {}) {
  // force: the caller already decided to look this up (deck.js "add online data").
  if (!force && !shouldBrowse(question)) return [];
  let html = "";
  try {
    const query = wantsNews(question) ? `top news headlines ${todayLabel()}` : question;
    const response = await fetch(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`, {
      signal: AbortSignal.timeout(3000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (!response.ok) throw new Error(`Search returned ${response.status}`);
    html = await response.text();
  } catch (err) {
    console.error("Failed while searching the web:", err?.message || err);
    return [];
  }

  const results = [];
  const linkPattern = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((match) =>
    decodeHtml(match[1])
  );
  let match;
  let matchIndex = 0;
  while ((match = linkPattern.exec(html)) && results.length < 4) {
    const snippet = snippets[matchIndex] || "";
    matchIndex += 1;
    const url = unwrapDuckLink(match[1]);
    if (!isPublicWebUrl(url)) continue;
    results.push({
      title: decodeHtml(match[2]) || url,
      url,
      snippet,
    });
  }
  if (!results.length) return [];

  const read = wantsNews(question) ? 1 : 0;
  const opened = await Promise.all(results.slice(0, read).map((result) => fetchPage(result)));
  const rest = results.slice(read).map((result) => ({ ...result, text: result.snippet }));
  return [...opened, ...rest].filter((page) => page.text);
}
