import type { ArchiveFacets, ArchivePage, ArchiveQuery, PeriodDays, SourceSummary } from "./types";

/** Small, stale-while-revalidate archive caches. SQLite remains the source of truth. */
type Entry<T> = { at: number; value: T };
// Archive caches are explicitly invalidated on imported data and moderation.
const TTL_MS = 2 * 60 * 60_000;
const MAX_JSON = 450_000;
// Ignore old L-Monitor country/source snapshots after the geography fix.
const prefix = (monitor: string) => monitor === "lukashenko" ? "monitor-archive-v3:" : "monitor-archive-v2:";
const facets = new Map<string, Entry<ArchiveFacets>>();
const pages = new Map<string, Entry<ArchivePage>>();
const sources = new Map<string, Entry<SourceSummary[]>>();

function read<T>(map: Map<string, Entry<T>>, key: string): T | null {
  const found = map.get(key);
  if (!found) return null;
  // Keep expired snapshots visible while a fresh SQLite query runs.
  map.delete(key);
  map.set(key, found);
  return found.value;
}
function fresh<T>(map: Map<string, Entry<T>>, key: string) {
  const found = map.get(key);
  return Boolean(found && found.at > 0 && Date.now() - found.at < TTL_MS);
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
function restore<T>(map: Map<string, Entry<T>>, mapKey: string, storageKey: string): T | null {
  if (map.has(mapKey)) return read(map, mapKey);
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return null;
    const entry: Entry<T> = JSON.parse(saved);
    if (!entry || !Number.isFinite(entry.at) || entry.value == null) return null;
    map.set(mapKey, entry);
    return entry.value;
  } catch { return null; }
}
function persist<T>(key: string, entry: Entry<T>) {
  try {
    const json = JSON.stringify(entry);
    if (json.length < MAX_JSON) localStorage.setItem(key, json);
    else localStorage.removeItem(key);
  } catch { /* caching must never block or break SQLite reads */ }
}
const pageKey = (monitorKey: string, options: ArchiveQuery) =>
  JSON.stringify([monitorKey, options.query || "", options.periodDays ?? null,
    options.category || "", options.region || "",
    [...(options.sources || [])].sort(), options.sort || "newest", options.limit || 30, options.offset || 0]);
function isDefaultPage(options: ArchiveQuery) {
  return !options.query && !options.category && !options.region && !(options.sources || []).length &&
    (options.periodDays ?? 30) === 30 && (!options.sort || options.sort === "newest") &&
    (options.limit ?? 30) === 30 && (options.offset ?? 0) === 0;
}
const facetsKey = (monitor: string) => prefix(monitor) + "facets:" + monitor;
const firstPageKey = (monitor: string) => prefix(monitor) + "first:" + monitor;
const sourcesKey = (monitor: string) => prefix(monitor) + "sources:" + monitor;

export function cachedFacets(monitor: string) { return restore(facets, monitor, facetsKey(monitor)); }
export function facetsFresh(monitor: string) { cachedFacets(monitor); return fresh(facets, monitor); }
export function saveFacets(monitor: string, value: ArchiveFacets) {
  write(facets, monitor, value, 2);
  persist(facetsKey(monitor), facets.get(monitor)!);
}
export function cachedPage(monitor: string, options: ArchiveQuery) {
  const key = pageKey(monitor, options);
  return isDefaultPage(options) ? restore(pages, key, firstPageKey(monitor)) : read(pages, key);
}
export function pageFresh(monitor: string, options: ArchiveQuery) {
  cachedPage(monitor, options);
  return fresh(pages, pageKey(monitor, options));
}
export function savePage(monitor: string, options: ArchiveQuery, value: ArchivePage) {
  const key = pageKey(monitor, options);
  write(pages, key, value, 32);
  if (isDefaultPage(options)) persist(firstPageKey(monitor), pages.get(key)!);
}
export function cachedSources(monitor: string, period: PeriodDays) {
  const key = `${monitor}:${period ?? "all"}`;
  return period === 30 ? restore(sources, key, sourcesKey(monitor)) : read(sources, key);
}
export function sourcesFresh(monitor: string, period: PeriodDays) {
  cachedSources(monitor, period);
  return fresh(sources, `${monitor}:${period ?? "all"}`);
}
export function saveSources(monitor: string, period: PeriodDays, value: SourceSummary[]) {
  const key = `${monitor}:${period ?? "all"}`;
  write(sources, key, value, 10);
  if (period === 30) persist(sourcesKey(monitor), sources.get(key)!);
}
export function invalidateArchiveCache(monitor: string, hard = false) {
  for (const map of [facets, pages, sources] as Array<Map<string, Entry<unknown>>>) {
    for (const [key, entry] of [...map.entries()]) {
      const matched = map === facets ? key === monitor :
        map === pages ? key.startsWith('["' + monitor + '",') : key.startsWith(monitor + ":");
      if (!matched) continue;
      if (hard) map.delete(key);
      else entry.at = 0;
    }
  }
  for (const key of [facetsKey(monitor), firstPageKey(monitor), sourcesKey(monitor)]) {
    try {
      if (hard) { localStorage.removeItem(key); continue; }
      const raw = localStorage.getItem(key);
      if (raw) { const entry = JSON.parse(raw); entry.at = 0; persist(key, entry); }
    } catch { /* optional cache */ }
  }
}
