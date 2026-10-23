// Clicks, typing and keys for the app's browser (WebKit has no DevTools protocol here).
// Pasted in front of each command (pane.rs); the helpers are made once per page.
const __brainPane = window.__brainPane || (window.__brainPane = (() => {
  const focused = () => {
    let el = document.activeElement || document.body;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  const isField = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  const caret = (el) => {
    try {
      if (typeof el.selectionStart === "number") return [el.selectionStart, el.selectionEnd];
    } catch {}
    return [el.value.length, el.value.length];
  };
  // React and similar keep their own copy of a field's value; the prototype's setter updates both.
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  };
  const place = (el, at) => {
    try { el.setSelectionRange(at, at); } catch {}
  };

  function type(text) {
    const el = focused();
    if (isField(el)) {
      const [start, end] = caret(el);
      el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true, composed: true }));
      setValue(el, el.value.slice(0, start) + text + el.value.slice(end));
      place(el, start + text.length);
      el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true, composed: true }));
      return true;
    }
    if (el && el.isContentEditable) return document.execCommand("insertText", false, text);
    return false;
  }

  function removeChar(el, forward) {
    const [start, end] = caret(el);
    const from = start === end ? (forward ? start : Math.max(0, start - 1)) : start;
    const to = start === end ? (forward ? start + 1 : start) : end;
    setValue(el, el.value.slice(0, from) + el.value.slice(to));
    place(el, from);
    el.dispatchEvent(new InputEvent("input", { inputType: forward ? "deleteContentForward" : "deleteContentBackward", bubbles: true, composed: true }));
  }

  function click(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    const at = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
    const pointer = { ...at, pointerId: 1, isPrimary: true, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerover", pointer));
    el.dispatchEvent(new MouseEvent("mouseover", at));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    const focusable = el.closest("input, textarea, select, button, a[href], [tabindex], [contenteditable='true'], [contenteditable='']");
    if (focusable) focusable.focus();
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    // click() runs what a real click does: follow a link, tick a box, press a button.
    el.click();
    return true;
  }

  function focusables() {
    return [...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex], [contenteditable='true']")]
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
  }

  function key(spec) {
    const el = focused();
    const m = spec.modifiers || 0;
    const init = {
      key: spec.key, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode, bubbles: true, cancelable: true, composed: true,
      altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8),
    };
    const go = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (go) {
      const shortcut = m & 6;
      if (spec.text && !shortcut) el.dispatchEvent(new KeyboardEvent("keypress", init));
      if (spec.key === "Enter") {
        if (el instanceof HTMLTextAreaElement || el.isContentEditable) type("\n");
        else if (el instanceof HTMLInputElement && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
        else if (el.matches && el.matches("button, a[href], [role=button], summary")) el.click();
      } else if (spec.key === "Tab") {
        const list = focusables();
        const next = list[(list.indexOf(el) + (m & 8 ? -1 : 1) + list.length) % list.length];
        if (next) next.focus();
      } else if ((spec.key === "Backspace" || spec.key === "Delete") && isField(el)) {
        removeChar(el, spec.key === "Delete");
      } else if (shortcut && spec.key.toLowerCase() === "a" && isField(el)) {
        el.select();
      } else if (!isField(el) && ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(spec.key)) {
        const by = { ArrowDown: 60, ArrowUp: -60, PageDown: innerHeight * 0.85, PageUp: -innerHeight * 0.85, " ": innerHeight * 0.85 }[spec.key];
        if (spec.key === "Home") scrollTo(0, 0);
        else if (spec.key === "End") scrollTo(0, document.documentElement.scrollHeight);
        else scrollBy(0, by);
      } else if (spec.text && !shortcut) {
        type(spec.text);
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  }

  return { click, type, key };
})());
