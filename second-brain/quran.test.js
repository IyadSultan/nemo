/**
 * Quran recitation: the right requests match, and the three verses are real text.
 * Run: node --test second-brain/quran.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { consecutiveVerses, parseRecite, reciterUrl, surahNamePattern, verseText, versesForQuestion, wantsQuran } from "./quran.js";

test("a recitation request matches, a question about meaning does not", () => {
  assert.equal(wantsQuran("Recite some verses of the Quran"), true);
  assert.equal(wantsQuran("please recite some verses"), true);
  assert.equal(wantsQuran("read me the quran"), true);
  assert.equal(wantsQuran("give me a verse from the Quran"), true);
  assert.equal(wantsQuran("quote an ayah"), true);
  assert.equal(wantsQuran("اقرأ آيات من القرآن"), true);

  assert.equal(wantsQuran("What does the Quran say about patience?"), false);
  assert.equal(wantsQuran("How do I recite the Quran?"), false);
  assert.equal(wantsQuran("Read my notes on the Quran"), false);
  assert.equal(wantsQuran("Open the ketamine paper"), false);
  assert.equal(wantsQuran("What is the latest news today?"), false);
  assert.equal(wantsQuran("Recite some verses of the Bible"), false);
  assert.equal(wantsQuran("recite ten verses"), true);
  assert.equal(wantsQuran("recite surah yasin"), true);
  assert.equal(wantsQuran("recite yasin"), true);
  assert.equal(wantsQuran("recite 2:255"), true);
  assert.equal(wantsQuran("play surah mulk"), true);
  assert.equal(wantsQuran("what does surah yasin mean"), false);
  assert.equal(wantsQuran("play the movie"), false);
});

function spots(question) {
  return versesForQuestion(question, () => 0).verses.map((verse) => [verse.chapter, verse.verse]);
}

test("a number recites that many verses in a row", () => {
  const verses = spots("recite ten verses");
  assert.equal(verses.length, 10);
  assert.equal(verses[0][0], verses[9][0]);
  assert.equal(verses[9][1], verses[0][1] + 9);
  assert.equal(spots("recite twenty five verses").length, 25);
  assert.equal(spots("please recite some verses").length, 3);
  assert.equal(parseRecite("recite one verse").chapter, 0);
  assert.equal(spots("recite one verse").length, 1);
});

test("a surah name or number recites that surah, and a verse recites that verse", () => {
  const fatiha = spots("recite surah al fatihah");
  assert.equal(fatiha.length, 7);
  assert.deepEqual(fatiha[0], [1, 1]);
  assert.deepEqual(fatiha[6], [1, 7]);
  assert.deepEqual(spots("recite fatihah")[0], [1, 1]);
  assert.equal(spots("recite surah 1").length, 7);
  assert.deepEqual(spots("recite baqarah verse 255"), [[2, 255]]);
  assert.deepEqual(spots("recite 2:255"), [[2, 255]]);
  assert.deepEqual(spots("recite ayat al kursi"), [[2, 255]]);
  assert.deepEqual(spots("recite verse 255"), [[2, 255]]);
  assert.deepEqual(spots("recite five verses from surah yasin"), [[36, 1], [36, 2], [36, 3], [36, 4], [36, 5]]);
  assert.deepEqual(spots("recite ya sin"), spots("recite yasin"));
  assert.equal(spots("recite ya sin").length, spots("recite surah 36").length);
  assert.deepEqual(spots("recite ten verses of surah kawthar").map((pair) => pair[0]), [108, 108, 108]);
  assert.deepEqual(spots("recite nasr").map((pair) => pair[0]), [110, 110, 110]);
  assert.equal(spots("recite nas")[0][0], 114);
  assert.match(versesForQuestion("recite baqarah verse 300").error, /ends at verse 286/);
  assert.match(versesForQuestion("recite verse 1").error, /Name the surah/);
  assert.equal(parseRecite("اقرأ سورة يس").chapter, 36);
});

test("the voice page uses the same surah names", () => {
  const page = readFileSync(new URL("./public/voice-page.js", import.meta.url), "utf8");
  const found = page.match(/const QURAN_SURAH_KEYS = "([^"]*)"/);
  assert.ok(found, "QURAN_SURAH_KEYS is missing");
  assert.equal(found[1], surahNamePattern());
});

test("a long recitation shows the range, not every verse", () => {
  const verses = versesForQuestion("recite surah yasin").verses;
  const said = verseText(verses);
  assert.ok(verses.length > 12);
  assert.match(said, /Then the next/);
  assert.equal(said.split("\n\n").length, 5);
});

test("the first pick is the first three verses of Al-Fatihah, in order", () => {
  const verses = consecutiveVerses(3, () => 0);
  assert.deepEqual(
    verses.map((verse) => [verse.chapter, verse.verse]),
    [[1, 1], [1, 2], [1, 3]],
  );
  assert.equal(verses[0].name, "Al-Faatiha");
  assert.match(verses[0].english, /^In the name of Allah/);
  assert.match(verses[0].arabic, /^بِسۡمِ/);
  assert.deepEqual(verses.map(reciterUrl), [
    "https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/001001.mp3",
    "https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/001002.mp3",
    "https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/001003.mp3",
  ]);
});

test("a real pick is three verses in a row inside one surah", () => {
  const verses = consecutiveVerses(3);
  assert.equal(verses.length, 3);
  assert.equal(verses[0].chapter, verses[1].chapter);
  assert.equal(verses[1].chapter, verses[2].chapter);
  assert.equal(verses[1].verse, verses[0].verse + 1);
  assert.equal(verses[2].verse, verses[1].verse + 1);
  for (const verse of verses) {
    assert.ok(verse.arabic.length > 0);
    assert.ok(verse.english.length > 0);
    assert.match(reciterUrl(verse), /\/\d{6}\.mp3$/);
  }
});

test("the screen names the reciter and keeps each Arabic verse on its own line", () => {
  const verses = consecutiveVerses(3, () => 0);
  const said = verseText(verses);
  assert.match(said, /^Yasir al-Adusari\./);
  assert.match(said, /Al-Faatiha, The Opening, verses 1 to 3\./);
  assert.match(said, /In the name of Allah, the Entirely Merciful, the Especially Merciful\./);
  assert.match(said, /\n\nبِسۡمِ/);
});
