/**
 * The quiet-Claude sweep: when a Claude in Terminal counts as quiet for 30 hours.
 * Run: node --test second-brain/agents.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { QUIET_MS, quietLongEnough } from "./agents.js";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-21T12:00:00+03:00");

test("a Claude quiet for 30 hours is closed", () => {
  assert.equal(QUIET_MS, 30 * HOUR);
  assert.equal(quietLongEnough(now - 40 * HOUR, now - 31 * HOUR, now), true);
  assert.equal(quietLongEnough(now - 30 * HOUR, 0, now), true);
});

test("a Claude just started is not quiet, even when its old chat file is old", () => {
  assert.equal(quietLongEnough(now - 2 * HOUR, now - 90 * HOUR, now), false);
  assert.equal(quietLongEnough(now - 29 * HOUR, 0, now), false);
});

test("recent chat or typing keeps an old Claude open", () => {
  assert.equal(quietLongEnough(now - 100 * HOUR, now - HOUR, now), false);
  assert.equal(quietLongEnough(now - 100 * HOUR, now - 29.9 * HOUR, now), false);
});

test("an unknown start time leaves it open", () => {
  assert.equal(quietLongEnough(0, now - 90 * HOUR, now), false);
  assert.equal(quietLongEnough(undefined, 0, now), false);
  assert.equal(quietLongEnough(Number.NaN, 0, now), false);
});

test("a start time in the future (clock change) is not quiet", () => {
  assert.equal(quietLongEnough(now + HOUR, 0, now), false);
});
