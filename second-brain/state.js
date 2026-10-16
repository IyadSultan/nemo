/**
 * The few things every part of the server shares and may change while it runs.
 * Readers import the live binding; writers call the matching set function,
 * because an imported binding cannot be assigned to.
 */

import { WIKI_PATH } from "./config.js";

/** @type {{ rel: string, title: string, text: string, lower: string }[]} */
export let notes = [];
export let folders = [WIKI_PATH];
export let selected = [WIKI_PATH];
/** @type {{ rel: string, title: string, full: string, mtime: number, words: string[] }[]} */
export let rawMail = [];
/** The Ollama model this server last loaded, so switching models unloads the old one. */
export let loadedLocalId = "";

export function setNotes(list) { notes = list; }
export function setFolders(list) { folders = list; }
export function setSelected(list) { selected = list; }
export function setRawMail(list) { rawMail = list; }
export function setLoadedLocalId(id) { loadedLocalId = id; }
