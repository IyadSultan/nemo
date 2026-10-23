/**
 * PubMed questions: when they turn on, the search term, and reading efetch XML.
 * Run: node --test second-brain/pubmed.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseArticles, pubmedTerm, wantsPubmed } from "./pubmed.js";

test("questions that name PubMed turn it on", () => {
  for (const q of ["Search PubMed for neuroblastoma", "latest papers on ketamine in pub med", "ابحث في بابمد"]) assert.equal(wantsPubmed(q), true, q);
  for (const q of ["Search my Zotero for neuroblastoma", "What is on my calendar?"]) assert.equal(wantsPubmed(q), false, q);
});

test("the asking words are dropped from the search term", () => {
  assert.equal(pubmedTerm("Search PubMed for neuroblastoma in adolescents"), "neuroblastoma adolescents");
  assert.equal(pubmedTerm("what are the latest papers on CAR-T toxicity on pubmed?"), "CAR-T toxicity");
  assert.equal(pubmedTerm("pubmed"), "");
});

test("efetch XML becomes one page per article", () => {
  const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">123</PMID><Article>
    <Journal><JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue><Title>Nature</Title></Journal>
    <ArticleTitle>Ketamine &amp; <i>pain</i>.</ArticleTitle>
    <Abstract><AbstractText Label="BACKGROUND">Why.</AbstractText><AbstractText Label="RESULTS">It helps.</AbstractText></Abstract>
    <AuthorList><Author><LastName>Sj&#xf6;berg</LastName></Author><Author><LastName>Lee</LastName></Author></AuthorList>
  </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
  const [page] = parseArticles(xml);
  assert.equal(page.title, "PubMed: Ketamine & pain.");
  assert.equal(page.url, "https://pubmed.ncbi.nlm.nih.gov/123/");
  assert.equal(page.text, "Sjöberg, Lee (2025). Nature. PMID 123.\nBACKGROUND: Why. RESULTS: It helps.");
});
