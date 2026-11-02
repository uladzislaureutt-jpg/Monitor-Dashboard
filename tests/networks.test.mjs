import test from "node:test";
import assert from "node:assert/strict";
import { importNetworkCards, mergeNetworkCards, networkTrend, isTikTokVideoUrl, effectiveCategory } from "../src/networks.ts";

const now = "2026-11-02T07:00:00Z";
function card(id, category = "P2", date = "2026-11-02T05:00:00Z") {
  return {
    schema_version: "networks.v1", platform: "tiktok", item_id: "tiktok:" + id,
    source_url: "https://www.tiktok.com/@person/video/" + id,
    category, queue: date ? "candidate" : "date_unknown",
    publication: { published_at: date, date_status: date ? "verified_original" : "unknown", eligible_for_daily: !!date },
    operator_lane: "candidate", included_in_current_overview: true, review_displayed: true,
    generated_at: now, title: "Жалоба", text_excerpt: "Не работает отопление",
  };
}

test("strict JSONL import validates TikTok video ID and transactional errors", () => {
  const rows = importNetworkCards(JSON.stringify(card("7699429238109113652")) + "\n");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_id, "tiktok:7699429238109113652");
  assert.throws(() => importNetworkCards(JSON.stringify(card("7699429238109113652")) + "\n{bad}"));
  assert.throws(() => importNetworkCards(JSON.stringify({ ...card("7699429238109113652"), item_id: "tiktok:other" })));
  assert.equal(isTikTokVideoUrl("https://tiktok.com.evil.example/@x/video/7699429238109113652"), false);
  assert.throws(() => importNetworkCards(JSON.stringify({ ...card("7699429238109113652"), source_url: "https://example.com/video/7699429238109113652" })));
});

test("reimport is idempotent and preserves operator decisions", () => {
  const a = card("7699429238109113652");
  const reviewed = { ...a, review: { decision: "confirmed", category_override: "P1", revision: 2 }, review_status: "operator_confirmed" };
  const merged = mergeNetworkCards([reviewed], [a, a]);
  assert.equal(merged.length, 1);
  assert.equal(effectiveCategory(merged[0]), "P1");
  assert.equal(merged[0].review.revision, 2);
});

test("trend uses publication date, excludes undated and rejected", () => {
  const a = card("7699429238109113652");
  const b = card("7699429238109113653", "P1");
  const unknown = card("7699429238109113654", "REVIEW", null);
  const rejected = { ...card("7699429238109113655", "REJECT"), queue: "archive" };
  const result = networkTrend([a, b, unknown, rejected], 1, Date.parse("2026-11-02T08:00:00Z"));
  assert.equal(result.reduce((total, p) => total + p.count, 0), 2);
  const deferred = { ...card("7699429238109113656", "REVIEW"), operator_lane: "review", review_displayed: false };
  const repeated = { ...card("7699429238109113657"), report_suppressed: true };
  const withNoise = networkTrend([a, b, unknown, rejected, deferred, repeated], 1, Date.parse("2026-11-02T08:00:00Z"));
  assert.equal(withNoise.reduce((total, p) => total + p.count, 0), 2);
});

import { contextFromCard, normalizeSourceContext, rememberSourceContext } from "../src/networkEditorMetadata.ts";

test("editor retains source caption independently of transcription and refreshes", () => {
  const url = "https://www.tiktok.com/@person/video/7699429238109113652";
  const context = contextFromCard({ title: "Жалоба в Вилейке", text_excerpt: "Вода на улице. #вилейка", transcript_excerpt: "Не распознано" });
  assert.equal(context.description, "Вода на улице. #вилейка");
  const remembered = rememberSourceContext({}, url, context);
  assert.equal(rememberSourceContext(remembered, url, { title: "New AI title", description: "AI transcript" }), remembered);
  const reloaded = normalizeSourceContext(JSON.parse(JSON.stringify(remembered)));
  assert.equal(reloaded[url].title, "Жалоба в Вилейке");
  assert.equal(reloaded[url].description, "Вода на улице. #вилейка");
  assert.equal(Object.keys(normalizeSourceContext({ "https://evil.example/": context })).length, 0);
});


import { removeReviewVideo, clearReviewVideos, selectedVideoCount } from "../src/networkReviewSelection.ts";

test("editor can remove legacy video 1 while retaining other selected clips", () => {
  const old = [
    "https://www.tiktok.com/@old/video/7702043649848184085",
    "https://www.tiktok.com/@new/video/7702059935407836448",
    "https://www.tiktok.com/@another/video/7702037883107937559",
    "",
  ];
  const remaining = removeReviewVideo(old, 0);
  assert.deepEqual(remaining, [old[1], old[2]]);
  assert.equal(selectedVideoCount(remaining), 2);
  assert.deepEqual(removeReviewVideo(remaining, 1), [old[1]]);
  assert.deepEqual(removeReviewVideo([old[0]], 0), [""]);
});

test("clearing a review resets membership without deleting video metadata", () => {
  const metadata = { title: "Original caption", transcript: "Previously transcribed text" };
  const empty = clearReviewVideos();
  assert.deepEqual(empty, [""]);
  assert.equal(selectedVideoCount(empty), 0);
  assert.deepEqual(metadata, { title: "Original caption", transcript: "Previously transcribed text" });
});
