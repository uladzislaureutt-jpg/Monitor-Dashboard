import { desktopApi } from "./api";
import type { DashboardOverview, PeriodDays } from "./types";

/** Small, local, disposable snapshots. The SQLite database remains authoritative. */
type Snapshot = { savedAt: number; data: DashboardOverview };
const PREFIX = "monitor-dashboard-overview-v1:";
// Local writes explicitly invalidate the cache; avoid rebuilding the full
// overview after each idle hour if nothing in SQLite has changed.
const FRESH_MS = 4 * 60 * 60_000;
const MAX_SAVED_BYTES = 600_000;
const memory = new Map<string, Snapshot>();
const pending = new Map<string, Promise<DashboardOverview>>();
const generations = new Map<string, number>();

const keyFor = (monitor: string, period: PeriodDays) => `${monitor}:${period ?? "all"}`;
const storageKey = (key: string) => PREFIX + key;

export function peekOverview(monitor: string, period: PeriodDays): Snapshot | null {
  const key = keyFor(monitor, period);
  const found = memory.get(key);
  if (found) return found;
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const snapshot: Snapshot = JSON.parse(raw);
    if (!snapshot || !Number.isFinite(snapshot.savedAt) || !snapshot.data ||
        !Array.isArray(snapshot.data.trend) || !Array.isArray(snapshot.data.recent)) return null;
    memory.set(key, snapshot);
    return snapshot;
  } catch { return null; }
}

export function overviewIsFresh(monitor: string, period: PeriodDays) {
  const snapshot = peekOverview(monitor, period);
  return Boolean(snapshot && Date.now() - snapshot.savedAt < FRESH_MS);
}

function saveOverview(monitor: string, period: PeriodDays, data: DashboardOverview) {
  const key = keyFor(monitor, period);
  const snapshot = { savedAt: Date.now(), data };
  memory.set(key, snapshot);
  // Avoid oversized full-text/story objects exceeding WebView localStorage quotas.
  try {
    const json = JSON.stringify(snapshot);
    if (json.length <= MAX_SAVED_BYTES) localStorage.setItem(storageKey(key), json);
    else localStorage.removeItem(storageKey(key));
  } catch { /* memory cache still available */ }
}

export function invalidateOverview(monitor: string) {
  generations.set(monitor, (generations.get(monitor) || 0) + 1);
  for (const key of [...memory.keys()]) if (key.startsWith(monitor + ":")) memory.delete(key);
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX + monitor + ":")) localStorage.removeItem(key);
  } catch { /* local cache is optional */ }
}

export function loadOverview(monitor: string, period: PeriodDays, force = false): Promise<DashboardOverview> {
  const key = keyFor(monitor, period);
  const cached = peekOverview(monitor, period);
  if (!force && cached && overviewIsFresh(monitor, period)) return Promise.resolve(cached.data);
  const existing = pending.get(key);
  if (existing && !force) return existing;
  const generation = generations.get(monitor) || 0;
  const started = desktopApi.dashboardFor(monitor, period).then((data) => {
    if ((generations.get(monitor) || 0) === generation) saveOverview(monitor, period, data);
    return data;
  }).finally(() => { if (pending.get(key) === started) pending.delete(key); });
  pending.set(key, started);
  return started;
}
