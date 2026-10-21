# Second Brain — user manual

This folder holds two apps.

**Nemo** is a small voice chatbot. You talk, OpenAI talks back. It does not read your notes. Open it at `http://localhost:3000` after `npm start`.

**Second Brain** is the main app. You talk to it (or type), and it answers from your private notes, then can also write PDFs, edit PDFs, edit Word files, build slide decks, take meeting notes, draft email, and more. Open it in **Second Brain.app**, or at `http://127.0.0.1:3001/voice.html`.

The rest of this manual is about Second Brain. Nemo is only the short section near the end.

Your notes stay on your Mac (in OneDrive). The app searches them in place. It sends the model only the short passages that match the question. It does not copy the whole wiki into the chat.

---

## How to open it

The Mac starts the app when you log in (`voice/start-brain.sh`, via the launchd job `com.iyad.talk-to-your-brain`).

Two programs share the work:

| Program | Port | What it does |
|---|---|---|
| Rust front (`rust/target/release/brain`) | **3001** | The address you open. Serves the page, a few routes, and the terminal. Passes everything else to Node. |
| Node (`second-brain/server.js`) | **3002** | Answers questions, edits files, talks to models. |

If the Rust program is missing, or a file named `.node-only` exists in the project folder, Node listens on 3001 by itself.

Restart after a code change:

```bash
launchctl kickstart -k gui/$(id -u)/com.iyad.talk-to-your-brain
```

Check it is up:

```bash
curl -i http://127.0.0.1:3001/health
```

A healthy reply includes the header `x-served-by`. The menu-bar brain icon turns red when that check fails.

The window app is `Second Brain.app`. A small file on the Desktop named `Second Brain.secondbrain` opens it. After three minutes with no use, the window shrinks to a 200×200 mascot at the bottom-right of the screen (**Tiny mode**). It still listens. Click it to get the full window back.

---

## The screen

Left side: the mascot, status, **Start talking**, a type box, and buttons.

Right side: the transcript (what you said and what it answered).

Top bar:

| Item | Meaning |
|---|---|
| Last answer / Avg answer | How long until the first spoken word |
| In / Out / Thinking | Token counts for this whole chat |
| Cost | Estimated price for cloud models. Claude (subscription) and local models show $0. |
| **PDF** | Upload PDFs to edit. You can also drop PDF files on the window. |
| **Word** | Opens the Word editor. |
| **Terminal** | Opens or closes a terminal on this Mac. |

Above the transcript, two fold-away lists appear when they have something in them:

- **Work** — emails that may need a reply, drafts waiting for a yes, reminders, watched web pages.
- **PDFs** — one box per PDF you are editing.

**Clear** wipes the transcript. **Clear & save** writes a short summary of this chat into `~/.brain/brain.md`, then clears the screen.

---

## How to ask

1. Click **Start talking** and allow the microphone. Or type in the box and press **Ask**.
2. Say **Hey**, then your question. You can also press **Command and Control** together, then speak. That next sentence does not need to start with Hey.
3. Interrupt anytime. **Pause** or **Stop** cuts the current answer. Then say Hey again.
4. **Mute mic** stops sending your voice until you unmute.
5. **Restart last** asks the last question again.

While a slide show or the slide editor is open, heard sentences go to the slides instead of the normal chat. The editor still wants you to say Hey. The live slide show does not.

Room noises (“thank you”, “silence”, coughing) are ignored. They are not sent to the model.

### What happens to one question

The server looks at the words in this order. The first match wins. The code lives in `second-brain/server.js` (`POST /ask`) and the small files it calls.

| If you say something like… | What runs | File |
|---|---|---|
| “What can you do?” or “How does the watermark work?” | The answer comes from this manual, not from the notes. A “what can you do?” answer ends by pointing to `/brain`. | `prompt.js` `appManualPrompt`, live models call `app_manual` |
| “/brain” or “brain functions” | A table of every phrase you can say, and what each one does. No model call. | `commands.js` |
| A meeting or lecture just ended | A summary, not a wiki search | `meetings.js` |
| “Dance” / “wave” (Tiny, 8 words or fewer) | A short spoken line while the mascot moves | `voice.js` |
| “Use the … skill” or a skill name | That skill’s instructions | `skills.js` |
| “Stop the skill” | Skill turns off | `skills.js` |
| Noise only | Ignored | `intents.js` `isNoise` |
| “Remind me…”, “watch this page”, “what jobs”, “do number two” | Desk job, no model | `desk.js` `parseDesk` |
| “Text me …” | Sends an iMessage | `imessage.js` |
| “Learn that…”, “forget that…”, “what have you learned” | Saved preferences | `learnings.js` |
| “Show me cnn.com” (or a known site shortcut) | Opens the browser | `web.js` `showSiteJob` |
| “Merge these PDFs”, “rotate the PDF”, “make the scan searchable” | PDF tool | `pdftools.js` |
| “Open the email from Sara” | Finds the saved email and opens Outlook | `emailsearch.js` |
| “Open the ketamine paper” | Finds a file and opens it | `openfile.js` |
| “Find the file named …” on the Mac | Spotlight-style find | `docs.js` |
| “What meetings do I have today?” | Reads the calendar out loud | `calendar.js` |
| “Schedule a meeting …” | Drafts an Outlook event and waits for yes | `calendar.js` |
| “Write a memo …” | Saves a note file | `memos.js` |
| Anything else | Searches notes (and sometimes the web) and asks the model | `notes.js`, `prompt.js`, `models.js` |

After the model answers, if the answer contains a hidden `PDF_BODY` or `DECK_BODY` block, the server turns that into a PDF or a slide deck and shows a card. The voice never reads that block.

If a PDF box has **Q/A** turned on, that PDF’s text is added to every later question until you press **End Q/A**.

---

## Models

Pick the model in **Settings**. The default is **Claude Opus**.

**Voice models** hear the microphone themselves:

| Name | Id | Notes |
|---|---|---|
| Voice mini | `gpt-realtime-2.1-mini` | Default voice model. Cheaper. |
| Voice | `gpt-realtime-2.1` | Stronger, costs more. |
| Gemini Live | `gemini-3.8-live` | Google hears and speaks. Talk over it to cut it off. |

**Text models** do not hear audio. This Mac writes down your words (Whisper), the model writes the answer, and a local voice (Kokoro) speaks it.

| Name | Where it runs |
|---|---|
| GPT-6 Luna, Sol, 6.1 Sol, Astra | OpenAI, billed per token. Luna is the cheapest. |
| Claude Opus, Claude Sonnet | Your Claude subscription, through the `claude` program on this Mac. No API key. Opus and Sonnet answers can use helper agents (see below). |
| Bonsai 27B, GPT-OSS 20B, Gemma 4 (12B, E4B, E2B), Qwen 3.8 27B | On this Mac, through Ollama (port 11434). The written answer is free. |

**Thinking** is how long the model may “think” before the answer: Off, Low, Medium, High, Extra high, Maximum. Higher thinking uses more tokens and costs more on OpenAI. GPT-OSS cannot turn thinking off; its lowest level is Low. Local spoken answers stay short on purpose.

**Listening** (who writes down your speech):

- Whisper, English and Arabic (auto) — the usual choice.
- Whisper English and Arabic together — two models at once.
- Whisper, English only.

**Wake**:

- **Hey** — the usual start word.
- **Medical speech** — cleans medical words with GPT-OSS on this Mac (`medgem.js`).
- **Hey + Jev** — a cloud check (`jev.js`).
- **Hey + Gemma** — a local check.

**Voice** (Kokoro) is the spoken voice for text models: Heart, Bella, Nicole, and others, American and British. Voice mini and Gemini use their own voices.

Prices are in `second-brain/pricing.js`. They are US dollars per million tokens. A very long OpenAI question (over 272,000 input tokens) is billed at the long-context rate.

### Claude helpers

Every Claude Opus or Sonnet answer goes through a small team in Rust (`rust/src/team.rs`):

1. A planner (Sonnet) decides if helpers are needed.
2. If the question is simple, the model you picked answers alone.
3. If the question has several parts, up to four helpers (Ada, Milo, Juno, Kai, Nova, Remy) read your selected folders in parallel. They can only read files, not change them.
4. The lead writes the answer you hear.

You see a small picture per helper and what it is doing (“Reading a note”). Click a helper to open a read-only log. You can also say “ask Ada …” to give that helper the job and keep what it found last time (until the app restarts).

---

## Your notes

The default notes folder is the Obsidian wiki at:

`~/Library/CloudStorage/OneDrive-KingHusseinCancerCenter/2nd_brain/wiki`

Change it with `WIKI_PATH` in the project `.env` file.

**Settings → Second brains** lets you add more folders (paste a full path), tick the ones to search, or remove one from the list. Removing a folder from the list does not delete the files.

On every answer the model also reads `~/.brain/code.md`, if that file exists. That file is the rulebook for the notes. It is not a file inside each notes folder.

Search is two steps (`notes.js` and `embed.js`):

1. **Keyword** — words from your question matched against note titles and text.
2. **Meaning** — a small local model (`embeddinggemma` in Ollama) finds notes that mean the same thing even when the words differ. Vectors are cached in `second-brain/tmp/embeddings.json`.

If the question needs a fact that changes (news, weather, a price, “today”), the app also looks on the web (`web.js`, DuckDuckGo) and shows those pages as sources. It only fetches public web pages, never this Mac or a private network.

The answer lists its sources under the bubble: note titles, or web page titles.

### Long-term memory (`brain.md`)

Three different memories:

| Kind | Where | How long |
|---|---|---|
| This chat | In the browser, sent with the next question | Until you end the call or press Clear |
| Memories | `~/.brain/memories.md` | Until you say “forget that…” |
| Day summary | `~/.brain/brain.md` | Kept. Newest part is put into every answer. Older days can still be found by search. |
| Agent visits | `~/.brain/agents.md` | Kept. Who started work, the prompt, and a short summary when they finished. |

Every question and answer is also appended to `second-brain/daylog/YYYY-MM-DD.md`.

Each night at 23:30 the default model writes one section of `~/.brain/brain.md` for that day: people, work, decisions, preferences, open items. It reads the day’s calls, saved meetings, saved memos, and dated lines on agent wiki pages. It is told not to copy medical record numbers or patient names. You can run one day by hand with `POST /brain/summarize`.

**Clear & save** writes an extra section for this conversation only: `## <day> — conversation at HH:MM`.

When a Claude in a Terminal starts working, a small Claude appears in this chat with that agent's name and your prompt. Click that small Claude to open where it is working: the Terminal, or Cursor when the agent (Grok or another) is in Cursor. On a Terminal Claude, Exit quits it while it is still running, and Wake starts it again with `claude --continue` (the same as `claude -c`) so the last chat comes back. When it finishes, the brain reads what it did and the small Claude comes back with a short summary. Both moments are saved in `~/.brain/agents.md`, so you can ask who worked and when.

Every 6 hours the brain looks at every Claude that is still open in the Terminal. It also looks once, shortly after the app starts. If that Claude has had nothing new for 30 hours — no new chat, no typing in its tab, and it was not just started — the brain tells it to quit and then closes that Terminal tab. A tab still running something else is left open. Other tabs in the same window stay open. A Claude opened more recently is left alone. Claudes in Cursor, iTerm, or tmux are left alone. The close is written in `~/.brain/agents.md` and spoken, the same way a finished Claude is.

Say **“learn that …”**, **“from now on …”**, or **“remember: always …”** to add a preference (up to 40 lines). **“Forget that …”** removes the closest line. **“What have you learned?”** reads them back.

---

## Skills

A skill is a saved instruction file (Markdown). When it is on, the model follows that file instead of the normal note search.

The app offers every skill Claude Code can see, in this order (the same name is kept once; the earlier place wins):

1. `.claude/skills` and `.agents/skills` inside the folders you selected, and nearby projects
2. This app’s own skills: `second-brain/skills/`
3. `~/.claude/skills` (your copy beats the synced copy)
4. `~/.agents/skills`
5. Plugins turned on in `~/.claude/settings.json`
6. Skills under `~/code`

Built-in skills in this app:

- **one-page-summary** — a one-page PDF summary.
- **prd-simple** — a simple product write-up.

Type `/` in the question box to pick a skill. Or say “use the one page summary skill”. “Stop the skill” turns it off. While a skill is on, Claude may read that skill’s folder.

`GET /skills` lists them. The list is cached for about a minute.

---

## Capture: meetings, lectures, photos, documents

### Meeting

Turn **Meeting** on before the meeting. The app writes down what is said and stays quiet (it does not answer each sentence).

**Recap** (only while Meeting is on) shows a short “so far” plus a few questions to ask. It is written on screen only. It is not spoken, and it is not mixed into the final minutes.

Turn Meeting off. The model writes minutes. You get **Save minutes** and **Save to…**. The file goes to `raw/meetings/` inside your notes folder, named with the date and a short title. It includes the time range, title, and attendees when the Mac’s Calendar can see the overlapping invite.

The recording itself is saved as a small `.m4a` audio file next to the notes (mono, about 22 MB per hour).

You can ask about the meeting afterwards (“what did we decide?”). Those questions use the recording, not today’s Outlook calendar, unless you clearly ask about the calendar.

### Lecture

Same idea as Meeting, for a talk. When you turn it off, the app asks who presented, suggests a title, then summarizes. Files go to `raw/lectures/`.

### Photo

**Photo** uses your iPhone camera when the phone is unlocked and nearby (Continuity Camera). Otherwise it uses this Mac’s camera. The picture is attached to the next question. Cloud models that accept images can describe it. Local models and Claude are told they cannot see the picture, so they will not invent what is in it. **Edit** under the picture, or **Photo** in the top bar, opens PhotoCraft to change it.

### Snapshot

**Snapshot** captures part of the screen. Press it, drag over the area to keep (press Esc to cancel), and the picture is used exactly like a Photo: attached to the next question, or saved with the open meeting or lecture. The first time, macOS asks to allow Screen Recording for Second Brain. It works only in the Second Brain window, not in a browser tab.

### Document (add to the notes)

**Document** (not the same as PDF tools) accepts a PDF, Word file, PowerPoint, RTF, or text file. A copy and a wiki page are saved under `raw/meetings`, and you can ask about that file right away. The code is `upload.js` (`POST /document`).

---

## Email, calendar, memos

Saved emails live as text files under `raw/` in the notes folder. The app re-reads that folder about every 15 minutes.

| You say | What you get |
|---|---|
| “How many emails today?” | A count from the file dates, not a guess. |
| “Read the email from Sara” | The message, spoken. |
| “List my emails” | A list. |
| “Which emails need a reply?” | A review of urgent ones. |
| “Reply to this email” | A draft. Outlook opens with it. The app does not send mail by itself. |
| “Send an email to Haitham about the budget” | A new draft. “Reply” is not treated as a new email. |
| “Open the email from Sara” | Opens that message in Outlook. |
| “What meetings do I have today / tomorrow?” | Spoken from the calendar. |
| “What did I ask this morning?” | Answered from today’s calls, before the nightly summary. Yesterday is included until that night’s summary is written. |
| “Tell me when Eman emails” | A watch. When a new saved email from that person shows up, it is read aloud and texted. The first check only learns what is already saved. Say “stop watching email from Eman” to stop. |
| “Text me if I have a meeting before 9” | A watch for a meeting that starts before that hour, later today or tomorrow. Say “stop watching meetings” to stop. |
| “Open the calendar” | The Calendar button in the top bar. It shows the days Outlook has ready on this Mac, in place of the transcript. Refresh reads them again. Open in Outlook launches the Outlook app. Say “close the calendar” to go back. |
| “Open the stickies” | The Stickies button. A wooden board of paper notes. Say “close the stickies” to go back. |
| “Stop” or “make it shorter” | While an answer is still being written. Stop ends it. “Make it shorter”, “instead …”, or “do the slides first” continues from the words already written. |
| “Add an appointment” | A form on the Calendar tab. Type a title, day, start, and end. Add in Outlook opens it. Press Add in that window to put it on the calendar. Nothing is saved before that. The + on a day starts the form on that day. |
| “Schedule a meeting tomorrow at 3 pm called budget” | A draft event. It waits on the Work list until you say “send it” or “don’t send it”. |

Memos are short notes you ask to keep. “Write a memo that …” saves a file in `raw/notes`, named with the date. “Recent memos” is the past two weeks. “All memos” is every one. “Did you save the memo about …” looks one up. A complaint (“stop saving”) does not create a file.

Work cards on the page are the same jobs: reply ideas (a short summary is added), drafts waiting for yes, web pages you said “watch …”, reminders (“remind me in 20 minutes to …”, or “remind me at 3 pm to …”), and repeating jobs. Say “what jobs”, “do number two”, or “skip number one”.

### Repeating jobs

Say **“every weekday at 8 am, text me which emails need a reply”**. On those days the brain answers that question, reads it aloud if the voice page is open and quiet, and texts it when iMessage is on. **“Every day at 9 pm, remind me to …”** only sends those words. It does not ask the brain.

The card shows the next time. **Pause** and **Resume** are on the card. You can also say “pause the email job”, “resume the email job”, “drop the email job”, or “change the email job to 9 am”. A paused job stays on the list and does not run. If the Mac was asleep at the clock time, the job runs once when the Mac wakes, then waits for the next day. Up to 8 repeating jobs. They are kept in `second-brain/desk.json` and still run after a restart.

---

## Sticky notes

**Stickies** is a board of paper notes. Press **Stickies** in the top bar, or say “open the stickies”.

- **+ New note**, double-click an empty spot, or right-click and choose New note. Press **n** while the board is open.
- Drag a note by its title. Drag the corner to resize. Scroll to move around the board. Pinch, or hold Control and scroll, to zoom.
- The writing can look handwritten or typed. Arabic uses an Arabic handwriting font when the note is in Arabic.
- A title, a few hashtags, and a priority are filled in after you stop typing. The note is saved first. If you edit the title, press **Lock** and later labeling will not rename it.
- **Settings** changes the wood, cork, dark wood, plain colors, or your own photo. Light, dark, or match the Mac. Those choices stay after a restart.
- Sort and group from the row under the buttons. Alphabetical order lines the notes up. Switch back to manual and the old spots return.
- Archive hides a note. Trash is the first stop for delete. Restore puts it back in the same place.
- A note can become a task and become a note again. The words stay. Task views: today, upcoming, overdue, completed, high priority.
- Select text, right-click, **Add link**. **Link to a note** stores a link by the note’s id, not by where it sits.
- Say “create a yellow sticky note reminding me to …”, “show all my pink sticky notes”, “arrange the notes alphabetically”, or “delete the sticky note about …”. If two notes match, you get a numbered list. Say “number 1”, then “yes” before a delete.

The notes are in `second-brain/stickies.json` on this Mac. They are not in git. Details of the tools are in `docs/stickies-api.md`.

---

## Morning briefing and texts

If `BRIEFING_AT` is set in `.env` (for example `08:00`), each morning the app speaks today’s meetings, tasks due, and emails that need a reply. An open voice page reads it aloud. If iMessage is set up, the same text is sent to your phone.

`GET /briefing` builds one now without sending it. `POST /briefing/send` delivers it.

“Text me …” uses the same iMessage bridge (`voice/imessage-bridge`).

---

## PDF tools

There are three different PDF jobs. Do not mix them up.

| Job | When | What you do |
|---|---|---|
| **Make a new PDF** | “Make a one-page summary as a PDF” | The model writes a page. You see it in the chat with Save and Open. |
| **Change a PDF you already have, by talking** | “Rotate the PDF”, “merge the last two PDFs” | The app picks a tool and a file, then shows the result as a card. |
| **Change a PDF with the buttons** | PDF button, or drop files on the window | Boxes above the transcript. No model until you press Q/A. |

### Make a new PDF

Ask for a PDF, a one-pager, a printable, or a report. The model says one or two sentences (that is what you hear), then writes an HTML page the server does not show as text. Headless Chrome prints that page to a PDF (`pdf.js`, function `renderPdf`).

The card in the chat has:

- a preview
- **Save** — Downloads, then Finder shows the file
- **Save to…** — you pick the folder
- **Open** — Preview

Files live in `second-brain/pdfs/` as `<date>-<id>.pdf` plus a small `.name` file. They are not committed to git.

### Change a PDF by talking

`wantsPdfTool` in `pdftools.js` notices verbs such as merge, split, extract, delete, rotate, reverse, page numbers, watermark, compress, or OCR, together with the word PDF, scan, page, or document. “Make me a new PDF” is **not** this path. That stays with “make a new PDF” above.

A model (Claude Sonnet, unless `PDF_TOOL_MODEL` is set) picks one tool and which files, as a small JSON plan. If it decides you did not mean to edit a file, the question falls through to a normal answer.

Files it may use, newest first (up to 20):

1. PDFs you uploaded in the app
2. PDFs the brain already made
3. PDFs sitting at the top level of Downloads, Desktop, and Documents (not inside subfolders)

“It” or “the PDF” means the newest one. A merge with no names uses the newest files you counted.

Spoken tools (the planner’s list):

| Tool name | What it does | You might say |
|---|---|---|
| `merge` | Joins two or more PDFs in the order you said | “Merge the last two PDFs” |
| `split` | Cuts one PDF. Ranges like `1-3, 4-6`, or every page if you do not say | “Split the PDF into separate pages” |
| `extract` | Keeps only the pages you name | “Keep only pages 2 to 4” |
| `delete` | Removes those pages. Refuses if that would delete every page | “Delete page 3 of the PDF” |
| `rotate` | 90, 180, or 270 degrees clockwise. Empty pages means all pages | “Rotate the PDF 90 degrees” |
| `reverse` | Last page becomes first | “Reverse the PDF pages” |
| `numbers` | “Page n of total” at the bottom center | “Add page numbers to the PDF” |
| `watermark` | Faint diagonal text, default DRAFT | “Watermark the PDF with DRAFT” |
| `compress` | Smaller file, Ghostscript “ebook” quality | “Make the PDF smaller” |
| `ocr` | Makes a scan searchable. English only. About 3 seconds per page | “Make the scanned PDF searchable” |
| `none` | Not an edit. Normal answer instead | “How do I rotate a PDF?” |

Results show as PDF cards (up to 3). More than 3 files (a big split) go into a new folder in Downloads, and Finder opens it. A typical edit takes a few seconds.

### Change a PDF with the boxes

This path does not ask a model, except **Q/A**.

1. Click **PDF** (or **Add PDFs**), or drop PDFs onto the window.
2. Each file becomes a box: thumbnail, name, page count.
3. The **PDFs** section can be collapsed. Uploading a file opens it again.
4. **‹ ›** move a box left or right. **×** removes the box. The file stays saved. **Clear** removes every box.
5. Click the thumbnail to open that PDF in Preview.
6. A result appears as a **new box** next to the one you edited.
7. When two or more boxes are showing, the last box has **Combine all N**. That merges the boxes from left to right.

**Split** can be typed (“cut after 3, 7”, or ranges `1-3, 4-9`) or **Pick on pages…** (thumbnails; click between pages to cut). More than 20 parts go to a folder in Downloads instead of more boxes.

**Sign…** opens a window: draw or type a signature, click or drag it on a large page preview, set the size. “Remember” keeps it in this browser (`localStorage`, key `brainSignature`). It is an image on the page, not a cryptographic certificate.

**Bookmarks…** is a list of title + page number, added to the PDF outline.

**Q/A** reads the PDF (text if it has text, otherwise OCR), shows a short summary in the chat, and outlines the box. Up to 3 PDFs can be in Q/A at once. Later questions in the chat include that text (about 60,000 characters each) until you press **End Q/A**. Realtime voice models do not get this extra text; use a text model (Claude, GPT-6, or a local model) if you want answers about the file.

**To Word** writes a `.docx` in Downloads and shows it in Finder. It uses the `pdf2docx` converter (`voice/pdf_to_word.py`).

Buttons on each box:

| Button | Tool name | What it does |
|---|---|---|
| Rotate | `rotate` | 90° right, 90° left, or 180°. You can limit it to some pages. |
| Delete pages | `delete` | Removes the pages you type, for example `2, 5-7`. |
| Keep pages | `extract` | A new PDF with only those pages. |
| Split | `split` | Cut after pages, or ranges, or every page, or pick on thumbnails. |
| Sign… | `sign` | Place a drawn or typed signature. |
| Bookmarks… | `bookmarks` | Add outline entries. |
| To Word | `word` | A Word copy in Downloads. |
| Q/A | `qa` | Summarize, then answer questions about this PDF. |
| Page numbers | `numbers` | Page n of total, bottom center. |
| Header & footer | `headerfooter` | Text you type. `{page}` and `{total}` are filled in. Optional page numbers. |
| Watermark | `watermark` | Diagonal text, default DRAFT, faint. |
| Stamp | `stamp` | Approved, Rejected, Confidential, Draft, Final, or Copy, near the top right. Default is page 1. |
| Blank page | `blank` | Insert blank pages after a page number (`0` means at the start). Up to 50. |
| Password | `password` | Asks for a password to open. Ghostscript, 128-bit. |
| Unlock | `unlock` | Removes a password you already know. A wrong password is rejected. |
| Title & author | `info` | Sets the document title and author. |
| Pages per sheet | `nup` | 2 or 4 pages on one A4 sheet. |
| Flatten forms | `flatten` | Form fields and notes become part of the page. |
| Remove notes | `noannotations` | Removes comments, highlights, and links. |
| Compress | `compress` | Smaller file. |
| Searchable | `ocr` | OCR so you can search a scan. English. |
| Reverse | `reverse` | Flips the page order. |
| To images | `images` | Every page as a picture, in a new folder in Downloads. |

Page numbers and header/footer, watermark, stamps, bookmarks, and signatures come from the bundled PDFCraft tools (`second-brain/vendor/pdfcraft-tools.mjs`, installed by `voice/install-pdfcraft.sh`). Compress, password, unlock, OCR, thumbnails, and “to images” use programs on the Mac: Ghostscript (`gs`), `pdftoppm`, and Tesseract.

Upload limit is 100 MB. The file must start with the PDF marker (`%PDF`). Thumbnails are cached in `second-brain/tmp/pdfthumbs`. Q/A text is cached in `second-brain/tmp/pdfqa/`.

Routes:

| Route | Role |
|---|---|
| `POST /pdfedit/upload` | Store an uploaded PDF and return its id |
| `GET /pdfedit/:id/thumb/:page` | One page as a picture (`?big=1` for the sign window) |
| `POST /pdfedit/:id/run` | Run one tool. Body: `{tool, pages, angle, text, …}` |
| `POST /pdfedit/merge` | Combine boxes. Body: `{ids}` |
| `POST /pdfedit/:id/qa` | Summary plus stored text for later questions |
| `GET /pdf/:id` | The PDF bytes |
| `POST /pdf/:id/save` | Copy to Downloads or a folder you pick |
| `POST /pdf/:id/open` | Open in Preview |

---

## Photo editor

Click **Photo** in the top bar, or **Edit** under a picture in the chat. This needs PhotoCraft installed (`voice/install-photocraft.sh`). If it is missing, the button will say so.

The large area is PhotoCraft, the same editor as the desktop app: crop, layers, colour, and the rest. If the picture does not show up inside it, choose **File**, then **Open**. PhotoCraft fills in the picture you were editing.

The buttons above the editor, the ask box, and spoken requests use PhotoCraft's engine. Type the change in the box under the orb, for example "make the image white and black". Say it after Hey while the editor is open. A picture already in the chat is used if the editor is still closed.

| You press or say (after Hey) | What happens |
|---|---|
| Rotate right / "rotate it right" | Turns the picture a quarter turn clockwise |
| Rotate left / "rotate it left" | Turns it the other way |
| "turn it upside down" | Half turn |
| Flip / "flip it" | Mirror image |
| Brighter / Darker | Lifts or lowers the brightness |
| Black & white / "make the image white and black" | Removes the colour |
| Sharpen | Sharpens the picture |
| Auto color | Lets PhotoCraft correct the colour |
| Undo | Puts the previous picture back |
| Save | Writes a JPEG in Pictures |

A question that is not a change, such as "what is in this photo", still goes to the brain, and the picture goes with it. PhotoCraft's own Save also downloads a file and updates the picture in the chat.

---

## Word editor

Click **Word** in the top bar. This needs the WordCraft app installed (`voice/install-wordcraft.sh`). If it is missing, the button will say so (`GET /word/installed`).

The editor fills the window. A **Brain** panel sits beside the document.

| Button | What it does |
|---|---|
| New | Blank document |
| Open | Recent files from Documents, Desktop, and Downloads, or pick a file |
| Save | Back to the file it came from, or a new file in Documents |
| Ingest | Adds this document to the brain’s notes, same idea as the Document button |
| Summarize, Key point, Improve, Fix grammar, Shorter, Formal, Heading, Tidy format | Ready-made requests |
| Ask | Sends what you typed |
| Talk | Starts or stops the microphone. Say Hey, then the request. |
| Undo | Undoes the last change in the editor |
| ✕ | Closes the editor. The file on disk is unchanged unless you saved. |

You can open `.docx`, `.docm`, `.dotx`, `.doc`, `.odt`, `.rtf`, `.md`, `.txt`, `.html`. You can save `.docx`, `.odt`, `.rtf`, `.md`, `.txt`, `.html`, `.pdf`. Files must live under your home folder. Hidden folders are refused.

The model (Claude Sonnet, unless you pass another model, or `WORD_MODEL` is set) reads up to about 120,000 characters of the document plus any text you selected. It answers in plain sentences and may send edits:

| Edit | Meaning |
|---|---|
| `select` | Highlight an exact passage (so you can see what the answer is about) |
| `selectAll` | The whole document |
| `replace` | Replace the selection. New paragraphs are separated by line breaks |
| `format` | Bold, italic, font, size, color, highlight, underline, superscript |
| `para` | Alignment, spacing, indent |
| `style` | A paragraph style such as Heading 1 or Normal |

A question (“what is the main point?”) answers in words and highlights the supporting passage. A formatting request does not rewrite the words. The model is told not to invent facts that are not in the document.

`POST /word/ai` is that request. `GET /word/recent` lists files. `GET /word/file` reads one. `POST /word/save` writes bytes.

---

## Presentations

Ask for slides, a deck, a presentation, or a PowerPoint. The model says a sentence or two, then writes a deck. DeckCraft (`deckcraft.js`, installed by `voice/install-deckcraft.sh`) turns it into a real `.pptx` with transitions and animations. The app chooses the motion. The model only writes the content.

A card appears with the first slide and these buttons: **Present**, **Present live**, **PowerPoint**, **Save to…**, **Open**, **Edit with brain**.

### What a deck contains

Stored in `second-brain/decks/<id>.json` (and a `.pptx` rebuilt when the JSON changes).

- **Title**
- **Theme:** DeckCraft, Harbor, Ember, Meadow, Nocturne (dark, the usual one), Paper (plain light), Coral Reef, Slate
- **Mood:** `calm` (work, clinical, board) or `lively` (teaching)
- **Slides**, usually 6 to 12, at most 40

Slide kinds:

| Kind | On the slide |
|---|---|
| `title` | Opening title and optional subtitle |
| `bullets` | A headline and up to five short bullets |
| `section` | Starts a new part |
| `twoColumn` | Two headings, each with bullets |
| `stat` | One big number and a label |
| `quote` | A real quote and who said it |
| `chart` | Column, bar, line, pie, doughnut, or area. Only numbers you or the notes actually gave |
| `closing` | Last slide |

Any slide can have speaker **notes**.

Rules the model is given: one idea per slide, headline of at most seven words, at most five bullets of at most nine words, no invented numbers.

### Presenting

Full screen. Keys:

| Key | Action |
|---|---|
| ← → or Space | Previous / next |
| Home / End | First / last |
| B | Blank the screen |
| N | Speaker notes |
| L | Live mode |
| E | Editor |
| M | Mic on or off |
| Esc | Leave |

**Present live:** you talk, and slides appear or change as you speak. You do not need to say Hey. “Next”, “back”, “slide 3”, and “end the presentation” work without a model. Any other sentence shows a draft slide at once; the real slide replaces it a few seconds later (`POST /deck/:id/live`). Live mode turns the microphone on if it was off. The presenter bar has its own mic button.

### Edit with brain

Opens an editor: thumbnails, one large slide, notes, and a box. You can also open it from the presenter (Edit or E) or by saying “edit the deck with the brain”.

| Action | What it does |
|---|---|
| Change | Rewrites the slide you are looking at, from your sentence |
| More attractive | Redesigns the whole deck (layout and wording, no new facts) |
| Add online data | Looks up the topic on the web and adds a Sources slide |
| Add data from a document… | You upload a file; its text is used |
| Use the last uploaded document | Uses the last file from the Document button |
| Undo | One step back |
| Present / PowerPoint | Same as on the card |

Speech in the editor needs Hey. The same words repeated within 30 seconds are ignored. “It” only means the last deck if that deck was made in the last 3 hours.

Default model for these edits is Claude Sonnet (`DECK_ENHANCE_MODEL` and `DECK_LIVE_MODEL` can override).

Routes: `GET /deck/themes`, `POST /deck/new`, `GET /deck/:id`, `POST /deck/:id/live`, `POST /deck/:id/enhance`, `POST /deck/:id/slide`, `POST /deck/:id/undo`, `GET /deck/:id/pptx`, `POST /deck/:id/save`, `POST /deck/:id/open`.

---

## Writing code and making artifacts

Say or type **write**, **make**, or **build**, then what you want: “make a tip calculator app”, “write a python script that renames my photos by date”, “build a web page about my week”. “How do I write…” is still a question, not a build.

- **Questions first.** When a request is too vague to build well (“build me a dashboard for my clinic”), the brain asks up to 3 short questions and waits. Your next reply answers them: say the answers, “you decide”, or “cancel”. A new build request instead drops the questions. They wait 15 minutes. Clear requests (“make a simple game”) start right away.
- A planner splits big jobs into up to 4 parts; helpers (Ada, Milo, Juno, Kai…) on Claude Sonnet write their own files at the same time. Their avatars show live; click one to watch its terminal.
- The lead (your picked Claude model, or Claude Opus when another model is picked) is the main author: it reads the helpers' files, joins them, fixes what does not fit, runs a check, and tells you what it made.
- **Skills can build too.** Pick a skill with / and ask it to make something: “/hyperframes make a 10 second mp4 about this app”. The team reads the skill (and the skills next to it) and writes in the workspace. “This app” means Talk to your brain.
- **Videos.** For a HyperFrames video the team writes the composition and checks it with `hyperframes lint`. Then the app renders `video.mp4` itself, outside the sandbox, because Chrome cannot record inside it, and opens it. A 10-second video takes about 15 s to render. Needs `npm i -g hyperframes` once.
- Everything goes in a new folder, `~/.brain/workspace/yyyymmdd_title`. The team cannot write anywhere else: Claude Code's sandbox blocks Bash and file edits outside that folder. Your notes folders can be read but never changed.
- When it is done, `index.html` opens in the browser (or the folder opens in Finder), and a card lists the files.
- Code: `second-brain/build.js` (when to build, the folder, the finish), `rust/src/team.rs` (`build_args`, `BuildPlanner`, `Builder`). A build can take up to about 30 minutes; most take 30 s to 2 min.

---

## Terminal

**Terminal** in the top bar, or say “open a terminal” / “close the terminal” (a short phrase only; “how do I open a terminal?” still goes to the model).

It is a normal login shell in your home folder, inside the page (`terminal.js`). The Rust program runs it (`GET /term`, WebSocket). It only accepts connections from this Mac (`127.0.0.1` or `localhost`). The shell stops when you close the panel. Your Anthropic API key is removed from that shell’s environment so a command cannot print it.

---

## R

**R** in the top bar opens an R notebook in the right-hand panel, in place of the transcript, like Word and Slides. Type R in the box at the bottom and press **Run** (or Cmd+Enter). The output appears above it as a cell: printed text, data frames as tables (the first 200 rows), plots as pictures, and messages, warnings, and errors, in the order they happened, like running an `.R` file. One R session keeps your variables between runs. It works in `~/.brain/r`, so files you write land there.

- **Open files** picks one or more CSV, Excel, RDS, RData, SPSS, Stata, or JSON files, copies them into `~/.brain/r`, and reads each into a variable named after the file (`survey.xlsx` becomes `survey`), showing its size and first rows.
- Every plot and table has **Copy** (to the clipboard: a picture, or a table that pastes into Excel or Word) and **Save** (PNG, or CSV).
- Each cell has a checkbox. **Export** writes the ticked cells (or all of them when none is ticked) to one HTML file, with the questions, replies, code, text, tables, and plots inside it, and asks where to save it. **Run again** on a cell puts its code back in the box and runs it.
- When the brain fills the code box, the box pulses green so you know the code came from it.
- **Clear** empties the output; R keeps its variables. **Restart R** starts a fresh session (variables gone, files stay). **Transcript** and **Close** bring the conversation back; R keeps running.
- **The orb and the question box talk to the notebook while it is open.** Type or say “Hey, plot age by gender” and the brain writes the R, the notebook runs it, and the brain’s one-line reply sits above the cell. “What does that show?” is answered from the recent cells without running anything. The brain sees object names, sizes, and column names, never the values. Say “open R” from the main chat to open the panel.

The session is `rserver.R` run by `rsession.js` (`POST /r/run`); plots are PNG files under `~/.brain/r/.out`. For a plain console, type `arf` in the Terminal (`brew install arf`).

---

## Mascot

**Settings → Mascot:**

- **Claude** (default) — a small drawn character. It bobs when idle, waves when listening, walks while thinking, and moves its mouth while speaking.
- **Tiny** — a different animated character. It only loads when you pick it.

Short requests while Tiny mode is on, eight words or fewer: “dance”, “wave”, “drink coffee”, “celebrate”. The mascot does the move for about six seconds and says a short line. “Can you dance” counts. It does not call the model.

---

## Where things are saved

| What | Where |
|---|---|
| Notes (read in place) | `WIKI_PATH`, default OneDrive `2nd_brain/wiki` |
| Memos | `<notes>/raw/notes/` |
| Meeting minutes and uploaded documents | `<notes>/raw/meetings/` |
| Lecture notes | `<notes>/raw/lectures/` |
| Day call log | `second-brain/daylog/` (not in git) |
| Long-term memory | `~/.brain/brain.md` |
| Memories (preferences you asked it to learn) | `~/.brain/memories.md` |
| App manual | `~/.brain/manual.md` |
| Rulebook | `~/.brain/code.md` |
| PDFs the app made or you uploaded to edit | `second-brain/pdfs/` (not in git) |
| Decks | `second-brain/decks/` (not in git) |
| Work list (reminders, watches, drafts) | `second-brain/desk.json` |
| Folder list | `second-brain/folders.json` |
| API keys | `.env` in the project folder, never in git |

The app does not use a database.

---

## Install extras (once)

These are separate from `npm install`. Without them, that one feature says it is not installed. The rest of the app still works.

| Script | Feature |
|---|---|
| `voice/install-pdfcraft.sh` | PDF editing tools |
| `voice/pdf_to_word.py` in `voice/pdf2docx-venv` | PDF → Word |
| `voice/install-deckcraft.sh` | PowerPoint export |
| `voice/install-wordcraft.sh` | Word editor |
| `voice/install-photocraft.sh` | Photo editor |
| Ollama with `embeddinggemma` | Meaning search |
| Whisper models under `voice/models/` | Turning speech into text |
| `voice/kokoro_server.py` | Speaking answers for text models |
| Ghostscript, `pdftoppm`, Tesseract, ffmpeg (Homebrew) | Compress, thumbnails, OCR, recordings |

Keys in `.env`:

- `OPENAI_API_KEY` — required for Nemo and for GPT models. Not required for Claude or local models.
- `WIKI_PATH` — optional, if the notes are not in the default folder.
- `BRIEFING_AT` — optional, for example `08:00`.
- `PDF_TOOL_MODEL`, `PDF_QA_MODEL`, `WORD_MODEL`, `DECK_ENHANCE_MODEL`, `DECK_LIVE_MODEL` — optional model overrides.

---

## Nemo (the small voice chatbot)

```bash
cd /Users/USER/code/talk_to_your_brain
npm install
npm start
```

Open `http://localhost:3000`. Click **Start talking**.

Nemo uses OpenAI Realtime (`gpt-realtime-2.1-mini`) over WebRTC. Only `server.js` sees the API key. The browser never does. Headphones help. There are no notes, no PDF tools, and no skills.

`npm run brain` starts only the Node half of Second Brain (it will try port 3001 unless `BRAIN_PORT` is set).

---

## If something is wrong

| What you see | What to try |
|---|---|
| “Missing OPENAI_API_KEY” | Put the key in `.env` and restart. Claude and local models do not need it. |
| Mic denied | Allow the microphone for the app or for localhost. |
| No sound | Check the output device. Click the page once. Try headphones. |
| Menu-bar brain is red | The server is down or the Rust front is missing. Restart with the `launchctl` command above. |
| An old error keeps happening after you change code | A previous Node process may still be running. After restart, confirm `curl -i :3001/health` shows `x-served-by`. |
| “The PDF tools are not installed” | Run `voice/install-pdfcraft.sh`. |
| Word button does nothing useful | Run `voice/install-wordcraft.sh`. The editor needs WebGL2. |
| No PowerPoint file | Run `voice/install-deckcraft.sh`. |
| Notes did not load | OneDrive may still be waking up. The start script waits up to two minutes. Check `WIKI_PATH`. |
| iPhone camera missing | macOS may not be offering Continuity Camera to this app. Quit and reopen, and allow the camera. |
| Q/A answers ignore the PDF | You are on a realtime voice model. Switch to Claude, a GPT-6 model, or a local model. |
| High latency | Wired headphones and a stable network. Voice models bill audio in and out; watch usage on the OpenAI site if you use them. |

---

## How the code is split

You do not need this to use the app. It is here so a later change goes in the right file.

`second-brain/server.js` is the front door. It wires the pieces and handles `POST /ask`. Each concern has its own file:

| File | Job |
|---|---|
| `config.js` | Paths, ports, token limits, the `.env` load |
| `state.js` | The notes and folders currently in memory |
| `intents.js` | Word tests: is this email, a memo, noise, news? |
| `notes.js` | Load the wiki and search it |
| `embed.js` | Meaning search |
| `prompt.js` | The instructions sent to the model, including the PDF and deck abilities |
| `models.js` | Streaming answers: OpenAI, Ollama, Claude |
| `pricing.js` | Model list and prices |
| `mail.js` | Read saved emails and draft replies |
| `memos.js` | Memo files |
| `calendar.js` | Read the day and plan a meeting |
| `outlook.js` | Open a draft or a calendar file in Outlook |
| `web.js` | Web search and “open this site” |
| `spoken.js` | Dates and times in words, so the voice does not read “21:11” as a code |
| `speech.js` | Whisper and Kokoro (`/transcribe`, `/speak`) |
| `live.js` | Realtime and Gemini session setup |
| `control.js` | Keyboard shortcut and briefing events to the open page |
| `folders.js` | Add, select, and reload note folders |
| `desk.js` / `deskjobs.js` | Work cards, reminders, watches |
| `meetings.js` | Meeting and lecture save, recap, recording |
| `skills.js` | Find and run skills |
| `shell.js` | Run a single local command (open a file or a site) |
| `brain.js` | Day log and `brain.md` |
| `agents.js` | Claude session visits, saved in `agents.md` |
| `learnings.js` | “Learn that…” |
| `pdf.js` | Turn the model’s HTML into a PDF and serve it |
| `pdftools.js` | Edit existing PDFs |
| `public/pdfedit.js` | The PDF boxes on the page |
| `wordcraft.js` / `public/wordedit.js` | Word editor |
| `photocraft.js` / `public/photoedit.js` | Photo editor |
| `deck.js` / `deckcraft.js` / `public/deck.js` | Slides, presenter, PowerPoint |
| `public/deck-edit.js` | “Edit with brain” |
| `upload.js` | Add a document to the notes |
| `openfile.js` | “Open the paper…” |
| `emailsearch.js` | “Open the email from…” |
| `docs.js` | Find a file on the Mac |
| `imessage.js` | Texts and the morning briefing |
| `jev.js` / `medgem.js` | Optional wake-word checks |
| `public/voice.html`, `voice.js`, `voice.css` | The page |
| `public/terminal.js` | The terminal panel |
| `public/mascot.js` | The character |
| `rust/src/bin/brain.rs` | The program on port 3001 |
| `rust/src/team.rs` | Claude helpers |
| `rust/src/term.rs` | The terminal |
| `rust/window/` | The desktop window |

The page and the server talk with Server-Sent Events: a stream of small messages (`delta` for words, `sources`, `pdf`, `deck`, `work`, `error`, `done`).
