/**
 * PubMed from this Mac: NCBI E-utilities (esearch, then efetch for abstracts), no key needed.
 * Results come back shaped like web pages, so the prompt and the Sources list take them as they are.
 */

import { decodeHtml } from "./web.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

/** "Search PubMed for ...", "latest papers on ... in pubmed". */
export function wantsPubmed(question) {
  return /pub ?med|بابميد|بابمد|ببمد/i.test(String(question || ""));
}

/** The question without the asking words, as a PubMed search term. */
export function pubmedTerm(question) {
  return String(question || "")
    .replace(/pub ?med|بابميد|بابمد|ببمد/gi, " ")
    .replace(/\b(please|can you|could you|search|look up|look for|find|check|show me|tell me|what (does|do|is|are)|say|says|the|latest|recent|newest|new)\b/gi, " ")
    .replace(/\b(papers?|articles?|studies|study|literature|publications?|abstracts?)\b/gi, " ")
    .replace(/\b(in|on|from|for|about|regarding|of)\b/gi, " ")
    .replace(/[?!.,;:"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Up to five PubMed articles for the question, most relevant first; only the last two years when it asks for the latest. */
export async function searchPubmed(question) {
  const term = pubmedTerm(question);
  if (!term) return [];
  // Sorting by date lets weak matches win, so "latest" keeps relevance and narrows the dates instead.
  const recent = /\b(latest|recent|newest|new)\b/i.test(question) ? { datetype: "pdat", reldate: "730" } : {};
  try {
    const found = await fetch(`${EUTILS}/esearch.fcgi?${new URLSearchParams({ db: "pubmed", term, retmax: "5", sort: "relevance", ...recent, retmode: "json", tool: "talk_to_your_brain" })}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!found.ok) throw new Error(`esearch returned ${found.status}`);
    const ids = (await found.json()).esearchresult?.idlist || [];
    if (!ids.length) return [];
    const fetched = await fetch(`${EUTILS}/efetch.fcgi?${new URLSearchParams({ db: "pubmed", id: ids.join(","), retmode: "xml", tool: "talk_to_your_brain" })}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!fetched.ok) throw new Error(`efetch returned ${fetched.status}`);
    return parseArticles(await fetched.text());
  } catch (err) {
    console.error("Failed while searching PubMed:", err?.message || err);
    return [];
  }
}

/** efetch XML → { title, url, text } per article. */
export function parseArticles(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? clean(m[1]) : "";
  };
  return [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)].map(([, a]) => {
    const pmid = tag(a, "PMID");
    const authors = [...a.matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/g)].map(([, au]) => tag(au, "LastName")).filter(Boolean);
    const who = authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ");
    const pubDate = a.match(/<PubDate>([\s\S]*?)<\/PubDate>/)?.[1] || "";
    const year = tag(pubDate, "Year") || tag(pubDate, "MedlineDate").slice(0, 4);
    const abstract = [...a.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
      .map(([, attrs, body]) => {
        const label = attrs.match(/Label="([^"]+)"/)?.[1];
        return label ? `${label}: ${clean(body)}` : clean(body);
      })
      .join(" ");
    return {
      title: `PubMed: ${tag(a, "ArticleTitle")}`,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      text: [`${who} (${year}). ${tag(a, "Title")}. PMID ${pmid}.`, abstract.slice(0, 1500) || "(no abstract)"].join("\n"),
    };
  }).filter((p) => p.url.match(/\/\d+\/$/));
}

function clean(s) {
  // NCBI writes accents as hex entities (Sj&#xf6;berg), which decodeHtml leaves alone.
  const hex = s.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  return decodeHtml(hex).replace(/\s+/g, " ").trim();
}
