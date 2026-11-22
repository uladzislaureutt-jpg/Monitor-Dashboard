import { strFromU8, strToU8, unzipSync, zipSync } from "npm:fflate@0.8.2";
import { filterLMonitorBundle } from "./l-monitor-bundle.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("filters the app bundle and its counts by URL and verified edition", async () => {
  const date = "2026-11-22T06:00:00Z";
  const files = {
    publications: "publications.jsonl", entities: "entities.jsonl", full_texts: "full_texts.jsonl",
    source_metrics: "source_metrics.jsonl", run_metrics: "run_metrics.json", full_text_integrity: "integrity.jsonl",
  };
  const rows = [
    ["tracking", "http://www.example.com/News/?id=1&utm_source=feed"],
    ["different-id", "https://example.com/News?id=2"],
    ["edition", "https://www.pravda.com.ua/rus/news/2026/11/22/8063865/"],
    ["pending", "https://news.example.org/pending"],
  ].map(([id, url]) => ({
    document_id: id, publication: { url, normalized_url: url, preview_image_url: "image" },
    source: { name: "Example", configured_region: "Украина" },
    classification: { category: "Политика" }, event: { signature: id },
    provenance: { content_level: id === "pending" ? "SUFFICIENT_PREVIEW" : "FULL_TEXT" },
  }));
  const entries = rows.slice(0, 3).map(({ document_id }) => ({ document_id }));
  const lines = (values: unknown[]) => strToU8(values.map((value) => JSON.stringify(value)).join("\n"));
  const archive = zipSync({
    "manifest.json": strToU8(JSON.stringify({ monitor: { key: "lukashenko" }, run: { started_at: date }, files })),
    [files.publications]: lines(rows),
    [files.entities]: lines(entries),
    [files.full_texts]: lines(entries),
    [files.source_metrics]: lines([{ source: "Example", relevance_passed: 4, included: 4, results: 4 }]),
    [files.run_metrics]: strToU8(JSON.stringify({ final_publications: 4, dry_run: false })),
    [files.full_text_integrity]: lines([{ final_publications: 4 }]),
  });
  const wrapped = zipSync({ "dashboard-l-monitor.zip": archive });
  const lookup = (keys: string[], asOf: string) => {
    equal(asOf, date);
    return Promise.resolve(new Set(keys.filter((key) =>
      ["https://example.com/News?id=1", "edition:pravda.com.ua:8063865"].includes(key)
    )));
  };
  const result = await filterLMonitorBundle(wrapped, lookup);
  equal(result.removed, 2);
  const output = unzipSync(result.bytes);
  for (const path of [files.publications, files.full_texts, files.entities]) {
    equal(strFromU8(output[path]).trim().split("\n").map((line) => JSON.parse(line).document_id),
      path === files.publications ? ["different-id", "pending"] : ["different-id"]);
  }
  const stats = JSON.parse(strFromU8(output[files.run_metrics]));
  equal([stats.final_publications, stats.full_text_full, stats.full_text_partial, stats.full_text_coverage_pct], [2, 1, 1, 50]);
  equal(JSON.parse(strFromU8(output[files.source_metrics])), { source: "Example", relevance_passed: 4, included: 2, results: 2 });
  equal(result.bytes, (await filterLMonitorBundle(archive, lookup)).bytes);
  const noMatch = await filterLMonitorBundle(wrapped, () => Promise.resolve(new Set()));
  if (noMatch.bytes !== wrapped) throw new Error("Unchanged archive was rewritten");
  const all = await filterLMonitorBundle(archive, (keys) => Promise.resolve(new Set(keys)));
  equal(all.removed, rows.length);
  equal(strFromU8(unzipSync(all.bytes)[files.publications]), "");
});
