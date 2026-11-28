import type { DatabaseStats, RunSummary } from "./types";

type Snapshot = { savedAt: number; stats: DatabaseStats; runs: RunSummary[] };
const PREFIX = "monitor-core-v1:";
const storageKey = (monitor: string) => (monitor === "lukashenko" ? "monitor-core-v2:" : PREFIX) + monitor;
const MAX_JSON = 700_000;
// Imports and moderation invalidate this snapshot, so an idle application
// should not rescan run history every hour without new local data.
const TTL = 4 * 60 * 60_000;
const memory = new Map<string, Snapshot>();

export function peekCore(monitor: string): Snapshot | null {
  let value = memory.get(monitor);
  if (value) return value;
  try {
    const raw = localStorage.getItem(storageKey(monitor));
    if (!raw) return null;
    value = JSON.parse(raw);
    if (!value || !Array.isArray(value.runs) || !value.stats || !Number.isFinite(value.savedAt)) return null;
    memory.set(monitor, value);
    return value;
  } catch { return null; }
}
export function coreFresh(monitor: string) {
  const value = peekCore(monitor);
  return Boolean(value && Date.now() - value.savedAt < TTL);
}
export function saveCore(monitor: string, stats: DatabaseStats, runs: RunSummary[]) {
  const data = { savedAt: Date.now(), stats, runs };
  memory.set(monitor, data);
  try {
    const raw = JSON.stringify(data);
    if (raw.length <= MAX_JSON) localStorage.setItem(storageKey(monitor), raw);
    else localStorage.removeItem(storageKey(monitor));
  } catch { /* cache is optional */ }
}
export function invalidateCore(monitor: string) {
  memory.delete(monitor);
  try { localStorage.removeItem(storageKey(monitor)); } catch { /* cache is optional */ }
}
