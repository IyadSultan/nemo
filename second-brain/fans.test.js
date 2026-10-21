/**
 * Fan monitor sentences. The real chip is not opened here.
 * Run: node --test second-brain/fans.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { describeFans, fanEffort, presentFans } from "./fans.js";

test("an idle fan is quiet", () => {
  assert.equal(fanEffort({ rpm: 2315, min: 2317, max: 7826 }), "quiet");
  assert.equal(fanEffort({ rpm: 4000, min: 2317, max: 7826 }), "easy");
  assert.equal(fanEffort({ rpm: 6000, min: 2317, max: 7826 }), "busy");
  assert.equal(fanEffort({ rpm: 7500, min: 2317, max: 7826 }), "hard");
});

test("two fans become a sentence with left and right names", () => {
  const shown = presentFans({
    ok: true,
    fans: [
      { index: 0, rpm: 2315, min: 2317, max: 7826 },
      { index: 1, rpm: 2503, min: 2317, max: 7826 },
    ],
    temps: [{ name: "CPU", c: 57.2 }],
  });
  assert.equal(shown.fans[0].name, "Left fan");
  assert.equal(shown.fans[1].name, "Right fan");
  assert.equal(shown.fans[0].effort, "quiet");
  assert.match(shown.line, /Left fan is at 2,315 revolutions per minute, and it is quiet/);
  assert.match(shown.line, /CPU 57 degrees/);
});

test("a missing reading says so", () => {
  assert.equal(describeFans({ ok: false }), "I could not read the fan speed.");
  assert.equal(describeFans({ ok: true, fans: [] }), "This Mac has no fan to report.");
});
