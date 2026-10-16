/**
 * Folder names for one meeting, lecture, or document: 20261016_weekly-huddle.
 * Kept in its own file so the upload path and the meeting path can both use it.
 */

import fsSync from "node:fs";
import path from "node:path";

/**
 * The date the meeting started, then the title, made safe for a folder name.
 * Letters from any language are kept. Other characters become a hyphen.
 */
export function eventFolderName(date, title, fallback = "item") {
  const when = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
  const slug = String(title || "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || fallback;
  return `${ymd}_${slug}`;
}

/** A free path under parent. Adds -2, -3, … when that folder name is already used. */
export function freeChildPath(parent, name) {
  let candidate = name;
  let n = 2;
  while (fsSync.existsSync(path.join(parent, candidate))) {
    candidate = `${name}-${n}`;
    n += 1;
    if (n > 50) break;
  }
  return path.join(parent, candidate);
}
