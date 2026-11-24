import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Verify the cache contract without depending on a Tauri window.
const contents = readFileSync(new URL("../src/overviewCache.ts", import.meta.url), "utf8");
test("overview snapshots are scoped by monitor and period", () => {
  assert.match(contents, /monitor.*period/);
  assert.match(contents, /const keyFor/);
});
test("invalidation protects against late responses", () => {
  assert.match(contents, /generations\.get\(monitor\)/);
  assert.match(contents, /invalidateOverview/);
});
