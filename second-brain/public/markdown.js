/**
 * A small markdown renderer for answer bubbles. It escapes all HTML first,
 * then adds headings, lists, tables, quotes, code, bold, italic and links.
 * Partial text (while the answer streams) renders without breaking.
 */

function mdEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mdInline(s) {
  const codes = [];
  s = mdEscape(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function mdCells(row) {
  return row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function markdownToHtml(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${mdEscape(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<h${Math.min(h[1].length + 2, 6)}>${mdInline(h[2])}</h${Math.min(h[1].length + 2, 6)}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.includes("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const head = mdCells(line).map((c) => `<th>${mdInline(c)}</th>`).join("");
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(`<tr>${mdCells(lines[i++]).map((c) => `<td>${mdInline(c)}</td>`).join("")}</tr>`);
      }
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (item.test(line)) {
      // One level of nesting: items indented two or more spaces go under the last item.
      const ordered = /\d/.test(line.match(item)[2]);
      const items = [];
      while (i < lines.length && item.test(lines[i])) {
        const [, indent, , text] = lines[i].match(item);
        if (indent.length >= 2 && items.length) items[items.length - 1].sub.push(lines[i].trim());
        else items.push({ text, sub: [] });
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) =>
        `<li>${mdInline(it.text)}${it.sub.length ? markdownToHtml(it.sub.join("\n")) : ""}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])
      && !(lines[i].includes("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || ""))) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${para.map(mdInline).join("<br>")}</p>`);
  }
  return out.join("");
}

/** Show markdown in an element. textContent stays the readable words. */
function renderMarkdown(el, md) {
  if (!el) return;
  el.classList.add("md");
  el.innerHTML = markdownToHtml(md);
}
