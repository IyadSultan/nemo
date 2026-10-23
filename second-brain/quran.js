/**
 * Reciting the Quran.
 *
 * The model does not write these words. They come from a copy of the Quran
 * installed in quran-text/, from the Quran API
 * (https://github.com/fawazahmed0/quran-api):
 * Arabic is the Uthmani Hafs script. English is Saheeh International.
 *
 * "Recite some verses" plays Yasir al-Adusari (everyayah.com).
 * A number picks that many verses. A surah or a verse number starts there.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { __dirname } from "./config.js";

// Per-verse recordings. The folder name is the site's spelling of Yasir al-Adusari.
const RECITER_NAME = "Yasir al-Adusari";
const RECITER_BASE = "https://everyayah.com/data/Yasser_Ad-Dussary_128kbps";

const TEXT_DIR = path.join(__dirname, "quran-text");
// Loaded once, then reused. Null until the first recitation.
let book = null;

/** Open the installed Quran. Throws if a file is missing or the two languages disagree. */
function loadBook() {
  if (book) return book;
  try {
    const arabic = JSON.parse(readFileSync(path.join(TEXT_DIR, "arabic.json"), "utf8")).quran;
    const english = JSON.parse(readFileSync(path.join(TEXT_DIR, "english.json"), "utf8")).quran;
    const chapters = JSON.parse(readFileSync(path.join(TEXT_DIR, "chapters.json"), "utf8"));
    if (!Array.isArray(arabic) || !Array.isArray(english) || arabic.length !== english.length) {
      throw new Error(`The Arabic and English files do not match (${arabic?.length} and ${english?.length} verses).`);
    }
    if (!Array.isArray(chapters) || chapters.length !== 114) {
      throw new Error(`Expected 114 surahs, found ${chapters?.length}.`);
    }
    book = { arabic, english, chapters };
    return book;
  } catch (err) {
    console.error("Failed while opening the installed Quran text:", err?.message || err);
    throw err;
  }
}

const ONES = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Spoken names that the chapter list spells differently, or that people say in English.
const EXTRA_NAMES = {
  1: ["opening", "fatihat"],
  2: ["cow", "baqarah", "bakara"],
  3: ["imran", "imraan"],
  9: ["tawbah", "tauba"],
  17: ["isra", "israa"],
  18: ["cave"],
  19: ["mary"],
  20: ["taha"],
  24: ["noor", "nur"],
  36: ["yasin", "yassin", "yaseen"],
  55: ["rahman", "rehman"],
  67: ["mulk"],
  71: ["nooh", "noah"],
  78: ["naba"],
  87: ["ala"],
  94: ["inshirah"],
  105: ["elephant"],
  106: ["quraysh"],
  108: ["kauthar", "kawthar"],
  109: ["kafirun", "kafiroon"],
  111: ["lahab"],
  112: ["ikhlas", "ikhlaas"],
  114: ["mankind", "naas"],
};

let chapterList = null;
let aliasIndex = null;

function loadChapters() {
  if (chapterList) return chapterList;
  try {
    chapterList = JSON.parse(readFileSync(path.join(TEXT_DIR, "chapters.json"), "utf8"));
    if (!Array.isArray(chapterList) || chapterList.length !== 114) {
      throw new Error(`Expected 114 surahs, found ${chapterList?.length}.`);
    }
    return chapterList;
  } catch (err) {
    console.error("Failed while opening the surah list:", err?.message || err);
    throw err;
  }
}

/** Fold spelling differences: Al-Baqara and "baqarah" become the same letters. */
function squash(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[٠-٩]/g, (digit) => "٠١٢٣٤٥٦٧٨٩".indexOf(digit))
    .replace(/[۰-۹]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹".indexOf(digit))
    .replace(/['’]/g, "")
    .replace(/aa/g, "a")
    .replace(/ee/g, "i")
    .replace(/ii/g, "i")
    .replace(/oo/g, "u")
    .replace(/uu/g, "u")
    .replace(/[^a-z0-9]/g, "");
}

function soft(text) {
  const key = squash(text);
  // "Fatihah" and "Baqarah" lose the last h. A 4-letter name like "Fath" stays whole.
  return key.endsWith("h") && key.length > 4 ? key.slice(0, -1) : key;
}

function aliasForms(name) {
  const raw = String(name || "").toLowerCase().replace(/['’]/g, "");
  const parts = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const noPrefix = raw.replace(/^(?:a[lnsdt]|a[rs]h|adh|az)-/i, "");
  const forms = new Set();
  for (const source of [raw, noPrefix, parts.join(""), parts[parts.length - 1] || ""]) {
    const key = soft(source);
    if (key.length >= 3) forms.add(key);
  }
  return [...forms];
}

function surahAliases() {
  if (aliasIndex) return aliasIndex;
  const found = new Map();
  for (const chapter of loadChapters()) {
    // The English titles ("The Man", "The Star") are ordinary words, so only the
    // transliterated name and the spoken extras are used.
    const forms = [
      ...aliasForms(chapter.name),
      ...(EXTRA_NAMES[chapter.chapter] || []).flatMap((extra) => [squash(extra), soft(extra)]),
    ];
    for (const form of forms) {
      if (form.length < 3) continue;
      const prev = found.get(form);
      // A shorter surah name must not steal a longer one's key. First one of this length wins.
      if (!prev) found.set(form, chapter.chapter);
    }
  }
  aliasIndex = [...found.entries()].sort((a, b) => b[0].length - a[0].length);
  return aliasIndex;
}

/** Every spoken surah key, longest first, for the page that decides to play a recording. */
export function surahNamePattern() {
  return surahAliases().map(([name]) => name).join("|");
}

function questionText(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[٠-٩]/g, (digit) => "٠١٢٣٤٥٦٧٨٩".indexOf(digit))
    .replace(/[۰-۹]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹".indexOf(digit))
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s:]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function questionTokens(q) {
  return q.split(/\s+/).filter(Boolean);
}

/** Read a number written as digits or words, starting at this word. */
function takeNumber(tokens, index) {
  const word = tokens[index];
  if (!word) return null;
  if (/^\d{1,3}$/.test(word)) return { value: Number(word), next: index + 1 };
  let at = index;
  let value = 0;
  let seen = false;
  let usedTens = false;
  if (ONES[tokens[at]] && tokens[at + 1] === "hundred") {
    value = ONES[tokens[at]] * 100;
    at += 2;
    seen = true;
    if (tokens[at] === "and") at += 1;
  } else if (tokens[at] === "hundred") {
    value = 100;
    at += 1;
    seen = true;
    if (tokens[at] === "and") at += 1;
  }
  if (TENS[tokens[at]]) {
    value += TENS[tokens[at]];
    at += 1;
    seen = true;
    usedTens = true;
  }
  // "ten" and "fifteen" stand alone. "five" can follow "twenty" or "two hundred".
  if (ONES[tokens[at]] && (ONES[tokens[at]] < 10 || !usedTens)) {
    value += ONES[tokens[at]];
    at += 1;
    seen = true;
  }
  if (!seen) return null;
  return { value, next: at };
}

/** Arabic surah names, with the vowel marks and "Al-" taken off, so يس still matches. */
function arabicKey(name) {
  return String(name || "")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/سوره/g, "")
    .replace(/ال/g, "")
    .replace(/\s+/g, "");
}

function findArabicSurah(raw) {
  const q = arabicKey(raw);
  if (q.length < 2) return 0;
  let best = null;
  for (const chapter of loadChapters()) {
    const key = arabicKey(chapter.arabicname);
    if (key.length < 2 || !q.includes(key)) continue;
    if (!best || key.length > best.key.length) best = { key, chapter: chapter.chapter };
  }
  return best ? best.chapter : 0;
}

function findSurah(q, raw) {
  const numbered = q.match(/\b(?:surah|surat|sura|chapter)\s+(\d{1,3})\b/);
  if (numbered) {
    const chapter = Number(numbered[1]);
    if (chapter >= 1 && chapter <= 114) return chapter;
  }
  const colon = q.match(/\b(\d{1,3})\s*:\s*\d{1,3}\b/);
  if (colon) {
    const chapter = Number(colon[1]);
    if (chapter >= 1 && chapter <= 114) return chapter;
  }
  const tokens = new Set();
  const words = questionTokens(q).map(soft);
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].length >= 3) tokens.add(words[i]);
    if (words[i + 1]) {
      const joined = words[i] + words[i + 1];
      if (joined.length >= 3) tokens.add(joined);
    }
    const stripped = words[i].replace(/^(?:al|an|ar|as|at|ad|ash)/, "");
    if (stripped.length >= 3) tokens.add(stripped);
  }
  let best = null;
  for (const [name, chapter] of surahAliases()) {
    if (!tokens.has(name)) continue;
    if (!best || name.length > best.name.length) best = { name, chapter };
  }
  if (best) return best.chapter;
  return findArabicSurah(raw);
}

function findVerse(q) {
  if (/\bkursi\b/.test(q)) return 255;
  const colon = q.match(/\b\d{1,3}\s*:\s*(\d{1,3})\b/);
  if (colon) return Number(colon[1]);
  const tokens = questionTokens(q);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!/^(?:verse|verses|ayah|ayahs|ayat|aya)$/.test(tokens[i])) continue;
    const number = takeNumber(tokens, i + 1);
    if (number) return number.value;
  }
  return 0;
}

function findRange(q) {
  const tokens = questionTokens(q);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!/^(?:verse|verses|ayah|ayat)$/.test(tokens[i])) continue;
    const start = takeNumber(tokens, i + 1);
    if (!start) continue;
    const link = tokens[start.next];
    if (!/^(?:to|through|till|until)$/.test(link || "")) continue;
    const end = takeNumber(tokens, tokens[start.next + 1] === "verse" ? start.next + 2 : start.next + 1);
    if (end && end.value >= start.value) return { verse: start.value, count: end.value - start.value + 1 };
  }
  return null;
}

function findCount(q) {
  const range = findRange(q);
  if (range) return range.count;
  const tokens = questionTokens(q);
  for (let i = 0; i < tokens.length; i += 1) {
    const number = takeNumber(tokens, i);
    if (!number) continue;
    const next = tokens[number.next];
    if (/^(?:verses|ayahs|ayat)$/.test(next || "")) return number.value;
  }
  if (/\b(?:a|an|one|the last|last)\s+(?:verse|ayah|aya)\b/.test(q)) return 1;
  // "Recite ten" — the number itself is the request.
  for (let i = 0; i < tokens.length; i += 1) {
    if (!/^(?:recite|quote|chant|play|read)$/.test(tokens[i])) continue;
    const number = takeNumber(tokens, i + 1);
    if (number && number.next >= tokens.length - 1) return number.value;
  }
  return 0;
}

/**
 * What to recite, or null when this is not a recitation.
 * A question about meaning stays with the model.
 */
export function parseRecite(question) {
  const raw = String(question || "");
  const q = questionText(raw);
  if (!q) return null;
  if (/^(?:what|why|how|when|where|who|which)\b/.test(q)) return null;
  if (/\b(?:mean|meaning|means|explain|tafsir|interpret)\b/.test(q)) return null;
  if (/\b(?:notes?|emails?|memos?|files?|documents?|pdf|paper|wiki)\b/.test(q)) return null;
  if (/\b(?:bible|poem|poetry|song|songs|shakespeare|lyrics|torah|gospel)\b/.test(q)) return null;

  const asks = /\b(?:recite|quote|chant|play|listen|read|give|share)\b/.test(q) || /اقرأ|اتل/.test(raw);
  const aboutBook = /\bquran\b|\bkoran\b/.test(q) || /قرآن|قران/.test(raw);
  const aboutVerse = /\b(?:verses?|ayahs?|ayat|aya)\b/.test(q) || /آيات|آية|ايات/.test(raw);
  const aboutSurah = /\b(?:surahs?|surat|sura|chapters?)\b/.test(q) || /سورة|سوره/.test(raw);
  const chapter = findSurah(q, raw);
  const kursi = /\bkursi\b/.test(q);
  const countGuess = findCount(q);
  if (!asks) return null;
  if (!aboutBook && !aboutVerse && !aboutSurah && !chapter && !kursi && !countGuess) return null;

  const range = findRange(q);
  let verse = range ? range.verse : findVerse(q);
  let count = countGuess;
  // Ayat al-Kursi is one verse, even if another surah name was also said.
  const chapterNumber = kursi ? 2 : chapter;
  if (kursi) verse = 255;
  return {
    chapter: chapterNumber || 0,
    verse: verse || 0,
    count: count || 0,
    last: /\blast\b/.test(q),
    rest: /\b(?:from|starting|start)\b/.test(q) && !count,
  };
}

/** True when the user wants verses recited. */
export function wantsQuran(question) {
  return Boolean(parseRecite(question));
}

/** Add a period so the voice can pause at the end of a verse. */
function finishSentence(text) {
  const line = String(text || "").trim();
  if (!line) return "";
  return /[.!?…"»]$/.test(line) ? line : `${line}.`;
}

/** One verse from the installed text, with its surah name. */
function verseAt(loaded, index) {
  const arabic = loaded.arabic[index];
  const english = loaded.english[index];
  if (!arabic || !english || arabic.chapter !== english.chapter || arabic.verse !== english.verse) {
    throw new Error(`Arabic and English disagree at position ${index}.`);
  }
  const chapter = loaded.chapters[arabic.chapter - 1];
  return {
    chapter: arabic.chapter,
    verse: arabic.verse,
    name: chapter?.name || `Surah ${arabic.chapter}`,
    englishName: chapter?.englishname || "",
    arabic: arabic.text,
    english: english.text,
  };
}

/** How many verses each surah has. Index 1 is Al-Fatihah. */
function surahLengths(loaded) {
  if (loaded.lengths) return loaded.lengths;
  const lengths = new Array(115).fill(0);
  for (const row of loaded.arabic) lengths[row.chapter] = Math.max(lengths[row.chapter], row.verse);
  loaded.lengths = lengths;
  return lengths;
}

/** The flat-list position of verse 1 of this surah. */
function surahStartIndex(loaded, chapter) {
  for (let i = 0; i < loaded.arabic.length; i += 1) {
    if (loaded.arabic[i].chapter === chapter && loaded.arabic[i].verse === 1) return i;
  }
  return -1;
}

/** Places where `count` following verses stay inside one surah. */
function rowStarts(loaded, count) {
  const key = `starts${count}`;
  if (loaded[key]) return loaded[key];
  const starts = [];
  for (let i = 0; i + count - 1 < loaded.arabic.length; i += 1) {
    const first = loaded.arabic[i];
    const last = loaded.arabic[i + count - 1];
    if (first.chapter === last.chapter) starts.push(i);
  }
  loaded[key] = starts;
  return starts;
}

/**
 * Pick `count` verses in a row, inside one surah.
 * `random` returns a number from 0 up to, but not including, 1.
 * Tests pass their own `random` so the pick is predictable.
 */
export function consecutiveVerses(count = 3, random = Math.random) {
  let loaded;
  try {
    loaded = loadBook();
  } catch (err) {
    console.error("Failed while picking Quran verses: the text did not open.", err?.message || err);
    throw err;
  }
  const want = Math.min(loaded.arabic.length, Math.max(1, count));
  const starts = rowStarts(loaded, want);
  if (!starts.length) throw new Error(`No surah has ${want} verses in a row.`);
  const slot = Math.min(starts.length - 1, Math.max(0, Math.floor(Number(random()) * starts.length)));
  const start = starts[slot];
  return Array.from({ length: want }, (_, offset) => verseAt(loaded, start + offset));
}

/**
 * The verses this question asked for.
 * No surah and no verse: that many verses in a row, somewhere in one surah (three when they did not say a number).
 * A surah alone: the whole surah. A verse alone: that verse. A number and a verse: that many, starting there.
 * A short surah is recited to its end instead of spilling into the next one.
 */
export function versesForQuestion(question, random = Math.random) {
  const plan = parseRecite(question);
  if (!plan) throw new Error("This was not a recitation.");
  let loaded;
  try {
    loaded = loadBook();
  } catch (err) {
    console.error("Failed while picking Quran verses: the text did not open.", err?.message || err);
    throw err;
  }
  const lengths = surahLengths(loaded);

  if (!plan.chapter && !plan.verse) {
    const want = Math.min(286, Math.max(1, plan.count || 3));
    return { verses: consecutiveVerses(want, random) };
  }

  let chapter = plan.chapter;
  if (!chapter) {
    const fits = [];
    for (let number = 1; number <= 114; number += 1) {
      if (lengths[number] >= plan.verse) fits.push(number);
    }
    if (fits.length === 1) chapter = fits[0];
    else if (!fits.length) return { error: `No surah has a verse ${plan.verse}.`, verses: [] };
    else return { error: `A few surahs have a verse ${plan.verse}. Name the surah.`, verses: [] };
  }

  const length = lengths[chapter] || 0;
  const info = loaded.chapters[chapter - 1];
  const name = info?.name || `Surah ${chapter}`;
  if (!length) return { error: "I could not find that surah.", verses: [] };
  if (plan.verse > length) return { error: `${name} ends at verse ${length}.`, verses: [] };

  let startVerse = plan.verse || 1;
  let count = plan.count;
  if (!count) count = plan.verse && !plan.rest ? 1 : length - startVerse + 1;
  if (plan.last) startVerse = Math.max(1, length - count + 1);
  if (startVerse + count - 1 > length) count = length - startVerse + 1;
  count = Math.max(1, count);

  const startIndex = surahStartIndex(loaded, chapter) + startVerse - 1;
  if (startIndex < 0 || !loaded.arabic[startIndex]) return { error: "I could not find that surah.", verses: [] };
  const verses = Array.from({ length: count }, (_, offset) => verseAt(loaded, startIndex + offset));
  return { verses };
}

/** The recording of one verse in Yasir al-Adusari's voice. */
export function reciterUrl(verse) {
  const surah = String(verse.chapter).padStart(3, "0");
  const ayah = String(verse.verse).padStart(3, "0");
  return `${RECITER_BASE}/${surah}${ayah}.mp3`;
}

/** Words for the screen. The reciter's recording is the voice, so this is not read aloud. */
export function verseText(verses) {
  const first = verses[0];
  const last = verses[verses.length - 1];
  const span = first.verse === last.verse ? `verse ${first.verse}` : `verses ${first.verse} to ${last.verse}`;
  const where = first.englishName
    ? `${first.name}, ${first.englishName}, ${span}.`
    : `${first.name}, ${span}.`;
  const lines = [RECITER_NAME + ".", where];
  // A whole long surah would fill the screen. Show the range, and the first verse.
  const shown = verses.length <= 12 ? verses : verses.slice(0, 1);
  for (const verse of shown) {
    lines.push(verse.arabic);
    lines.push(finishSentence(verse.english));
  }
  if (verses.length > 12) lines.push(`Then the next ${verses.length - 1} verses.`);
  return lines.join("\n\n");
}
