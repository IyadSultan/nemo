/**
 * Fan monitor sentences. The real chip is not opened here.
 * Run: node --test second-brain/fans.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  cpuPercent,
  describeFans,
  fanEffort,
  formatGb,
  gpuPercent,
  memoryAlarmMessage,
  memoryFromVmStat,
  memoryIsDangerous,
  presentFans,
} from "./fans.js";

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

const VM_SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages active:                                977465.
Pages wired down:                            468829.
Pages occupied by compressor:                589905.
`;

test("memory used is active plus wired plus compressed, and 85 percent is dangerous", () => {
  const calm = memoryFromVmStat(VM_SAMPLE, 51539607552, 1);
  assert.equal(calm.percent, 65);
  assert.equal(calm.pressure, "ok");
  assert.equal(calm.danger, false);
  assert.equal(formatGb(calm.totalBytes), "48 GB");
  const warned = memoryFromVmStat(VM_SAMPLE, 51539607552, 2);
  assert.equal(warned.pressure, "warning");
  assert.equal(warned.danger, true);
  assert.equal(memoryIsDangerous({ percent: 84, pressure: "ok" }), false);
  assert.equal(memoryIsDangerous({ percent: 85, pressure: "ok" }), true);
  assert.equal(memoryFromVmStat(VM_SAMPLE, 51539607552, 8).pressure, "critical");
});

test("gpu percent is the busiest device", () => {
  assert.equal(gpuPercent('{"Device Utilization %"=12} {"Device Utilization %"=40}'), 40);
  assert.equal(gpuPercent("no gpu here"), null);
});

test("the memory alarm warns and leaves working agents running", () => {
  const text = memoryAlarmMessage({
    percent: 91,
    usedBytes: 46 * (1024 ** 3),
    totalBytes: 48 * (1024 ** 3),
    pressure: "ok",
  });
  assert.match(text, /91% full/);
  assert.match(text, /46 GB of 48 GB/);
  assert.match(text, /left running/);
  assert.doesNotMatch(text, /\/exit/);
  const warned = memoryAlarmMessage({
    percent: 90,
    usedBytes: 43 * (1024 ** 3),
    totalBytes: 48 * (1024 ** 3),
    pressure: "warning",
  });
  assert.match(warned, /macOS says it is running out/);
  assert.match(warned, /left running/);
});

test("cpu percent needs two samples", () => {
  const quiet = [{ times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } }];
  const busy = [{ times: { user: 5, nice: 0, sys: 3, idle: 8, irq: 0 } }];
  assert.equal(cpuPercent(quiet), null);
  assert.equal(cpuPercent(busy), 100);
});
