// One motion rulebook for every deck, used by the PowerPoint builder (deckcraft.js)
// and the full-screen presenter (deck.js), so both move the same way.
// Distilled from the motion skills (pptx-animator, motion-director, motion-designer,
// motion-animator, motion-graphics):
// - one idea per click: bullets build paragraph by paragraph, in speaking order;
// - restraint: fade, wipe, a short fly or a subtle zoom; no spin or bounce;
// - entrances 400-700 ms, Morph 1000-2000 ms; everything eased, entrances ease out;
// - the same transition between sibling slides, Morph where a title carries on;
// - one motion personality per deck: "calm" (default) or "lively".

/** The deck's personality. Anything but "lively" is calm. */
export function moodOf(deck) {
  return deck?.mood === "lively" ? "lively" : "calm";
}

/**
 * Motion for slide i: the transition into it and its builds, in order.
 * build.part names the slide part (title, bar, body, leftHead, left, rightHead, right, value,
 * label, quote, by, chart). start: afterPrevious/withPrevious play by themselves; onClick
 * waits for the presenter.
 */
export function motionFor(deck, i) {
  const slides = deck?.slides || [];
  const slide = slides[i] || {};
  const before = slides[i - 1];
  const lively = moodOf(deck) === "lively";
  const kind = slide.kind || "bullets";

  let transition;
  if (i === 0) transition = { kind: "fade", duration: 700 };
  else if (kind === "section") transition = { kind: "push", option: "u", duration: 800 };
  else if (kind === "closing") transition = { kind: "fade", duration: 900 };
  else if (before && (before.kind === "title" || before.kind === "section") && slide.title) {
    // The title glides from the opening/section position to its place on the content slide.
    transition = { kind: "morph", duration: 1200 };
  } else transition = lively ? { kind: "push", option: "l", duration: 700 } : { kind: "fade", duration: 600 };

  const auto = (part, effect, duration, extra = {}) => ({ part, effect, duration, start: "afterPrevious", delay: 0, ...extra });
  const together = (part, effect, duration, extra = {}) => auto(part, effect, duration, { start: "withPrevious", ...extra });
  // The accent bar draws on from the left, like a pen line.
  const bar = auto("bar", "wipe", 400, { option: "l" });
  let builds = [];
  if (kind === "title" || kind === "closing") {
    builds = [auto("title", "fade", 600), bar, auto("body", lively ? "fly" : "fade", 500, lively ? { option: "b" } : {})];
  } else if (kind === "section") {
    builds = [auto("title", "wipe", 600, { option: "l" }), bar, auto("body", "fade", 400)];
  } else if (kind === "bullets") {
    builds = [{
      part: "body",
      effect: lively ? "fly" : "fade",
      ...(lively ? { option: "b" } : {}),
      duration: 500,
      start: "onClick",
      delay: 0,
      byParagraph: true,
    }];
  } else if (kind === "twoColumn") {
    builds = [
      auto("leftHead", "fade", 450), together("left", "fade", 450, { delay: 100 }),
      auto("rightHead", "fade", 450, { delay: 50 }), together("right", "fade", 450, { delay: 100 }),
    ];
  } else if (kind === "stat") {
    builds = [auto("value", "zoom", 600, { option: "in" }), auto("label", "fade", 400)];
  } else if (kind === "quote") {
    builds = [auto("quote", "fade", 800), auto("by", "fade", 400, { delay: 200 })];
  } else if (kind === "chart") {
    builds = [auto("chart", "wipe", 800, { option: "b" })];
  }
  return { transition, builds };
}

/** Ease-out for entrances, the motion skills' default curve. */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
/** Ease-in-out for things that move from one place to another (Morph, Push). */
export const EASE_MOVE = "cubic-bezier(0.65, 0, 0.35, 1)";
/** Gap between bullets that build by themselves (live mode). */
export const STAGGER_MS = 150;
