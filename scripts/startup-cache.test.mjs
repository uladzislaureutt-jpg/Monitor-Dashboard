import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedFacets, cachedPage, cachedSources, saveFacets, savePage, saveSources, invalidateArchiveCache } from "../src/archiveCache.ts";
import { saveCore, peekCore, coreFresh, invalidateCore } from "../src/coreCache.ts";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, value); },
  removeItem: (key) => { storage.delete(key); },
};
test("archive pages stay separate by monitor and filter and invalidate precisely", () => {
  const options = { periodDays: 30, query: "", limit: 30, offset: 0 };
  const sample = { total: 1, items: [{ id: 9, title: "test" }] };
  savePage("social_economic", options, sample);
  assert.deepEqual(cachedPage("social_economic", options), sample);
  assert.equal(cachedPage("lukashenko", options), null);
  assert.equal(cachedPage("social_economic", { ...options, query: "other" }), null);
  const other = { total: 2, items: [] };
  savePage("lukashenko", options, other);
  invalidateArchiveCache("social_economic");
  assert.equal(cachedPage("social_economic", options), null);
  assert.deepEqual(cachedPage("lukashenko", options), other);
});
test("source catalogue and facets stay scoped to the monitoring key", () => {
  const f = { categories: ["A"], regions: [], sources: ["B"] };
  saveFacets("social_economic", f);
  saveSources("social_economic", 30, []);
  assert.deepEqual(cachedFacets("social_economic"), f);
  assert.deepEqual(cachedSources("social_economic", 30), []);
  assert.equal(cachedSources("lukashenko", 30), null);
  invalidateArchiveCache("social_economic");
  assert.equal(cachedFacets("social_economic"), null);
  assert.equal(cachedSources("social_economic", 30), null);
});
test("core snapshot persists and invalidates per monitor", () => {
  saveCore("social_economic", { documents: 23 }, [{ id: 1 }]);
  saveCore("lukashenko", { documents: 47 }, [{ id: 2 }]);
  assert.equal(peekCore("social_economic")?.stats.documents, 23);
  assert.equal(coreFresh("social_economic"), true);
  invalidateCore("social_economic");
  assert.equal(peekCore("social_economic"), null);
  assert.equal(peekCore("lukashenko")?.stats.documents, 47);
});
