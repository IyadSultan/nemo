---
name: One page summary
description: Explain one subject on a single colorful A4 page as a PDF, with a simple diagram. Facts only from the notes, the conversation, and the web excerpts.
---

# One page summary → PDF

Goal: a reader who knows nothing about the subject understands it in under two minutes from ONE attractive A4 page, with at least one simple diagram.

## Collect first

Use the note excerpts and, when you have the Read, Glob and Grep tools, the user's folders: start at wiki/index.md, then the project, entity, task and source-summary pages about the subject. Use web excerpts only for facts the notes do not hold. Never invent a number, a name, or a date. If the subject is unclear, ask one short question and stop.

## Distill

Budget hard: about 350 to 450 words plus visuals.

- Title (8 words or fewer) and a one-sentence subtitle: what it is and why it matters.
- Bottom line: one or two sentences to remember.
- Three to five key blocks, each a short heading plus one to three lines. Pick from: What it is, Why it matters, How it works, Status and numbers, Risks and open issues, Next steps.
- Two to four headline numbers as tiles, only if real figures exist.
- One or two simple inline SVG diagrams, at most 6 elements and 4 words per label: a left-to-right flow for a process, a dated line for a timeline, hub-and-spoke for parts of a whole, side-by-side columns for a comparison.
- Footer: short sources line (note names), author, and today's date from the Here and now line.

## Answer shape

First one or two spoken sentences saying what the page covers. Then PDF_BODY on its own line. Then one complete HTML document:

- `<!DOCTYPE html>`, `<title>`, all CSS inside one `<style>` tag, no external files or fonts.
- `@page { size: A4; margin: 0 }`, body margin 0, content padded about 12mm, `-webkit-print-color-adjust: exact`.
- Layout with CSS grid: header band, key-message strip, two-column body (text blocks beside the diagram), KPI row, footer.
- Palette: deep teal #0F6E74, coral #E8684A, sand #F6EFE6, ink #1E2A32. Tinted cards with a colored left rule. Text contrast at least 4.5 to 1.
- One clean sans font (system-ui, Helvetica, Arial): title 26 to 30pt, headings 11 to 12pt, body 9 to 10pt, line-height 1.35.
- Everything must fit one page. Prefer cutting words to shrinking type; never go below 8.5pt.
- No emoji, no clip art, no walls of text.
