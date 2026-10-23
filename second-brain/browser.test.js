import { test } from "node:test";
import assert from "node:assert/strict";
import { browserFollowUp, parseBrowserJob } from "./browser.js";

test("browser orders are caught", () => {
  for (const q of [
    "browser: find the cheapest flight to Paris",
    "/browser check my order status",
    "Browser, book a table for two",
    "use the browser to renew my library books",
    "pls use the browser and fill the visa form",
    "go to httpbin.org/forms/post and order a large pizza",
    "open dominos.jo then order a pizza",
    "order a large pizza with bacon from dominos.jo",
    "book a table for 4 on opentable.com",
    "fill in the registration form on example.com with my details",
  ]) assert.ok(parseBrowserJob(q), q);
  assert.equal(parseBrowserJob("browser: order pizza").task, "order pizza");
});

test("other questions are left alone", () => {
  for (const q of [
    "show me cnn.com",
    "open cnn.com",
    "order the list by date",
    "book a meeting with Sami tomorrow",
    "what is the browser market share?",
    "add a sticky: buy milk",
    "fill in the form",
  ]) assert.equal(parseBrowserJob(q), null, q);
});

test("follow-ups do nothing without a plan or a running task", async () => {
  assert.equal(await browserFollowUp("yes"), null);
  assert.equal(await browserFollowUp("tell the browser to hurry"), null);
  assert.equal((await browserFollowUp("stop the browser")).text, "The browser is not doing anything.");
});
