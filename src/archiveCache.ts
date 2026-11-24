import type { ArchiveFacets, ArchivePage, ArchiveQuery, PeriodDays, SourceSummary } from "./types";

/** Short-lived in-process LRU only: never re-fetch unchanged archive pages on tab switches. */
type Entry<T> = { at: number; value: T };
const TTL_MS = 30 * 60_000;
const facets = new Map<string, Entry<ArchiveFacets>>();
const pages = new Map<string, Entry<ArchivePage>>();
const sources = new Map<string, Entry<SourceSummary[]>>();

function read<T>(map: Map<string, Entry<T>>, key: string): T | null {
  const found = map.get(key);
  if (!found) return null;
  if (Date.now() - found.at > TTL_MS) { map.delete(key); return null; }
  // Promote recently used pages; bound the total cache.
  map.delete(key);
  map.set(key, found);
  return found.value;
}
function write<T>(map: Map<string, Entry<T>>, key: string, value: T, limit = 32) {
  map.delete(key);
  map.set(key, { at: Date.now(), value });
  while (map.size > limit) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}
const pageKey = (monitorKey: string, options: ArchiveQuery) =>
  JSON.stringify([monitorKey, options.query || "", options.periodDays ?? null,
    options.category || "", options.region || "",
    [...(options.sources || [])].sort(), options.sort || "newest", options.limit || 30, options.offset || 0]);

export const cachedFacets = (monitorKey: string) => read(facets, monitorKey);
export const saveFacets = (monitorKey: string, value: ArchiveFacets) => write(facets, monitorKey, value, 2);
export const cachedPage = (monitorKey: string, options: ArchiveQuery) => read(pages, pageKey(monitorKey, options));
export const savePage = (monitorKey: string, options: ArchiveQuery, value: ArchivePage) =>
  write(pages, pageKey(monitorKey, options), value, 32);
export const cachedSources = (monitorKey: string, period: PeriodDays) => read(sources, `${monitorKey}:${period ?? "all"}`);
export const saveSources = (monitorKey: string, period: PeriodDays, value: SourceSummary[]) =>
  write(sources, `${monitorKey}:${period ?? "all"}`, value, 10);

export function invalidateArchiveCache(monitorKey: string) {
  facets.delete(monitorKey);
  for (const key of [...pages.keys()]) if (key.startsWith('["' + monitorKey + '",')) pages.delete(key);
  for (const key of [...sources.keys()]) if (key.startsWith(monitorKey + ":")) sources.delete(key);
}
