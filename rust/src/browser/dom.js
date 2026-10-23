// Runs in the page. Lists what the agent can see and use, browser-use style:
//   [3]<input type=text placeholder=Name />
//   *[4]<button>Send</button>      (* = new since the last look)
// Interactive elements are kept in window.__brainEls so actions find them by number.
(() => {
  const INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "summary", "option", "label"]);
  const ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton", "listbox", "treeitem"]);
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "svg", "path"]);
  const ATTRS = ["type", "name", "role", "placeholder", "aria-label", "title", "alt", "value", "href",
    "checked", "selected", "aria-expanded", "aria-checked", "aria-selected", "required", "disabled"];
  const before = window.__brainSeen || new Set();
  const seen = new Set();
  const els = [];
  const lines = [];
  const reach = innerHeight * 1.5;

  const short = (s, n) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return null;
    return r;
  };
  const near = (r) => r.bottom > 0 && r.top < reach && r.right > 0 && r.left < innerWidth;
  // Something else drawn on top (a cookie banner, a modal) hides it.
  const onTop = (el, r) => {
    if (r.top < 0 || r.top > innerHeight) return true;
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const root = el.getRootNode();
    const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return true;
    const label = hit.closest && hit.closest("label");
    return !!(label && (label.control === el || label.contains(el)));
  };
  const isInteractive = (el, tag, insideLink) => {
    if (tag === "input" && el.type === "hidden") return false;
    if (tag === "label" && el.control) return false; // the input it names is listed itself
    if (tag === "option") return false; // listed through select_dropdown
    if (INTERACTIVE.has(tag)) return true;
    const role = el.getAttribute("role");
    if (role && ROLES.has(role)) return true;
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    if (insideLink) return false;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0) return true;
    return getComputedStyle(el).cursor === "pointer" && getComputedStyle(el.parentElement || el).cursor !== "pointer";
  };
  const attrs = (el, tag) => {
    const out = [];
    for (const a of ATTRS) {
      let v = a === "value" ? el.value : el.getAttribute(a);
      if (a === "checked" && (el.type === "checkbox" || el.type === "radio")) v = el.checked ? "true" : null;
      if (a === "selected") continue;
      if (v === null || v === undefined || v === "") continue;
      if (a === "value" && (el.type === "password" || /^cc-/.test(el.autocomplete || ""))) v = "••••";
      if (a === "href") v = short(v, 60);
      out.push(`${a}=${short(v, 100)}`);
    }
    if (tag === "select") {
      const sel = el.options[el.selectedIndex];
      if (sel) out.push(`selected=${short(sel.text, 60)}`);
      out.push(`options=${el.options.length}`);
    }
    return out.length ? " " + out.join(" ") : "";
  };

  function walk(node, depth, insideLink) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = short(child.textContent, 100);
        if (!text) continue;
        const parent = child.parentElement;
        const r = parent && shown(parent);
        if (r && near(r) && !insideLink) lines.push("\t".repeat(depth) + text);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      const r = shown(el);
      // A hidden parent can still have shown children (position: fixed menus).
      if (r && near(r) && isInteractive(el, tag, insideLink) && onTop(el, r)) {
        const n = els.length;
        els.push(el);
        const text = tag === "select" || tag === "input" || tag === "textarea" ? "" : short(el.innerText || el.textContent, 80);
        const key = tag + "|" + text + "|" + (el.id || el.name || el.getAttribute("aria-label") || "");
        seen.add(key);
        const mark = before.size && !before.has(key) ? "*" : "";
        lines.push(`${"\t".repeat(depth)}${mark}[${n}]<${tag}${attrs(el, tag)}${text ? `>${text}</${tag}>` : " />"}`);
        if (tag === "a" || tag === "button") {
          walk(el, depth + 1, true);
          continue;
        }
      }
      // Their text is the options or the typed value, shown in the attributes instead.
      if (tag === "select" || tag === "textarea") continue;
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1, insideLink);
      if (tag === "iframe") {
        try {
          if (el.contentDocument?.body) walk(el.contentDocument.body, depth + 1, insideLink);
        } catch {}
        continue;
      }
      walk(el, depth + (r && els[els.length - 1] === el ? 1 : 0), insideLink);
    }
  }

  walk(document.body || document.documentElement, 0, false);
  window.__brainEls = els;
  window.__brainSeen = seen;
  const text = lines.join("\n");
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  const doc = document.scrollingElement || document.documentElement;
  return {
    url: location.href,
    title: document.title,
    text,
    count: els.length,
    hash: String(hash),
    above: Math.round((scrollY / innerHeight) * 10) / 10,
    below: Math.round((Math.max(0, doc.scrollHeight - scrollY - innerHeight) / innerHeight) * 10) / 10,
  };
})()
