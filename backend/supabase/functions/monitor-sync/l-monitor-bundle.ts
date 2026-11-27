import { strFromU8, strToU8, unzipSync, zipSync } from "npm:fflate@0.8.2";
import { publisherArticleKey, urlKey } from "../l-news-collector/core.ts";

type Json = Record<string, unknown>;
type Publication = {
  document_id: string;
  publication: { url: string; normalized_url: string; preview_image_url?: string };
  provenance?: { url_aliases?: unknown[]; content_level?: string };
  source: { name: string; configured_region?: string };
  classification: { category?: string };
  event?: { signature?: string };
};
type ReadyKeys = (keys: string[], asOf: string) => Promise<Set<string>>;

export function publicationKeys(row: Publication): string[] {
  const keys = new Set<string>();
  for (const url of [row.publication.url, row.publication.normalized_url, ...(row.provenance?.url_aliases ?? [])]) {
    if (typeof url !== "string") continue;
    try {
      keys.add(urlKey(url));
      const edition = publisherArticleKey(url);
      if (edition) keys.add(edition);
    } catch {
      // Some older exports contain URL fields the collector cannot normalize.
    }
  }
  return [...keys];
}

function read(archive: Record<string, Uint8Array>, path: string): string {
  const bytes = archive[path];
  if (!bytes) throw new Error(`Missing dashboard entry: ${path}`);
  return strFromU8(bytes);
}

function jsonl<T>(archive: Record<string, Uint8Array>, path: string): T[] {
  return read(archive, path).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function encodeRows(rows: unknown[]): Uint8Array {
  return strToU8(rows.map((row) => JSON.stringify(row) + "\n").join(""));
}

export async function filterLMonitorBundle(bytes: Uint8Array, readyKeys: ReadyKeys) {
  const outer = unzipSync(bytes);
  const nested = Object.keys(outer).filter((name) => name.includes("dashboard") && name.toLowerCase().endsWith(".zip"));
  const archive = outer["manifest.json"] ? outer : nested.length === 1 ? unzipSync(outer[nested[0]]) : null;
  if (!archive) throw new Error("No unambiguous L-Monitor dashboard bundle");

  const manifest = JSON.parse(read(archive, "manifest.json"));
  if (manifest.monitor?.key !== "lukashenko") throw new Error("Unexpected dashboard monitor");
  const asOf = manifest.run?.started_at;
  if (typeof asOf !== "string" || !Number.isFinite(Date.parse(asOf))) throw new Error("Invalid L-Monitor bundle date");
  const files = manifest.files;
  const rows = jsonl<Publication>(archive, files.publications);
  const keys = rows.map(publicationKeys);
  const ready = await readyKeys([...new Set(keys.flat())], asOf);
  const kept = rows.filter((_, i) => !keys[i].some((key) => ready.has(key)));
  const removed = rows.length - kept.length;
  if (!removed) return { bytes, removed };

  const ids = new Set(kept.map((row) => row.document_id));
  archive[files.publications] = encodeRows(kept);
  let full = 0;
  for (const path of [files.full_texts, files.entities]) {
    if (!path) continue;
    const entries = jsonl<{ document_id: string }>(archive, path).filter((row) => ids.has(row.document_id));
    archive[path] = encodeRows(entries);
    if (path === files.full_texts) full = new Set(entries.map((row) => row.document_id)).size;
  }

  const sources = new Map<string, number>();
  const agenda = new Map<string, number>();
  for (const row of kept) {
    const source = row.source.name.trim().toLowerCase();
    sources.set(source, (sources.get(source) ?? 0) + 1);
    const category = row.classification.category;
    if (category) agenda.set(category, (agenda.get(category) ?? 0) + 1);
  }
  const sourceRows = jsonl<Json>(archive, files.source_metrics).map((row) => {
    const count = sources.get(String(row.source ?? "").trim().toLowerCase()) ?? 0;
    return { ...row, included: count, results: count };
  });
  archive[files.source_metrics] = encodeRows(sourceRows);

  const percentage = (count: number) => kept.length ? Math.round(count * 1000 / kept.length) / 10 : 0;
  const partial = kept.filter((row) => row.provenance?.content_level?.toUpperCase() === "SUFFICIENT_PREVIEW").length;
  const previews = kept.filter((row) => row.publication.preview_image_url).length;
  const integrity = {
    final_publications: kept.length,
    full_text_full: full,
    full_text_partial: partial,
    full_text_missing: Math.max(0, kept.length - full - partial),
    full_text_coverage_pct: percentage(full),
  };
  const metrics = {
    ...JSON.parse(read(archive, files.run_metrics)),
    ...integrity,
    suppressed_helper_duplicates: removed,
    preview_images: previews,
    preview_image_coverage_pct: percentage(previews),
    unique_sources_in_result: sources.size,
    countries_in_result: new Set(kept.map((row) => row.source.configured_region).filter(Boolean)).size,
    story_clusters: new Set(kept.map((row) => row.event?.signature).filter(Boolean)).size,
    agenda_split: Object.fromEntries(agenda),
  };
  archive[files.run_metrics] = strToU8(JSON.stringify(metrics) + "\n");
  if (files.full_text_integrity) {
    archive[files.full_text_integrity] = encodeRows(
      jsonl<Json>(archive, files.full_text_integrity).map((row) => ({ ...row, ...integrity })),
    );
  }
  // A stable timestamp prevents an identical download from replacing the local run.
  return { bytes: zipSync(archive, { level: 6, mtime: new Date("2000-01-01T00:00:00Z") }), removed };
}
