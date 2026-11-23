import assert from "node:assert/strict";
import { test } from "node:test";
import { todayInMinsk, quickEventRange, formatEventDate, QUICK_EVENT_PERIODS } from "../src/eventPeriod.ts";

test("Minsk calendar is independent of browser timezone at local midnight", () => {
  assert.equal(todayInMinsk(new Date("2026-11-22T20:59:59Z")), "2026-11-22");
  assert.equal(todayInMinsk(new Date("2026-11-22T21:00:00Z")), "2026-11-23");
});
test("presets are inclusive and span calendar month and year boundaries", () => {
  assert.deepEqual(QUICK_EVENT_PERIODS, [1, 3, 7, 30]);
  assert.deepEqual(quickEventRange(1, "2026-11-23"), { from: "2026-11-23", through: "2026-11-23" });
  assert.deepEqual(quickEventRange(3, "2026-11-23"), { from: "2026-11-21", through: "2026-11-23" });
  assert.deepEqual(quickEventRange(7, "2026-11-23"), { from: "2026-11-17", through: "2026-11-23" });
  assert.deepEqual(quickEventRange(30, "2026-03-01"), { from: "2026-01-31", through: "2026-03-01" });
  assert.deepEqual(quickEventRange(3, "2027-01-01"), { from: "2026-12-30", through: "2027-01-01" });
});
test("dates are displayed in the Russian/Belarusian familiar form", () => {
  assert.equal(formatEventDate("2026-11-23"), "23.11.2026");
});
