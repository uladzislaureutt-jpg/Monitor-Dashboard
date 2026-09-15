import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "./api";
import type { DatabaseStats, DashboardOverview, ImportResult, PeriodDays, RunSummary, SyncSettings, ViewKey } from "./types";
import { SearchOverlay } from "./components/SearchOverlay";
import { WorkroomDrawer } from "./components/WorkroomDrawer";
import { DashboardView } from "./views/DashboardView";
import { ArchiveView } from "./views/ArchiveView";
import { AnalyticsView } from "./views/AnalyticsView";
import { SourcesView } from "./views/SourcesView";
import { DataView } from "./views/DataView";

const SYNC_STORAGE_KEY = "monitor-dashboard-github-sync-v1";
const DEFAULT_SYNC: SyncSettings = { repository: "", token: "", autoSync: false, intervalMinutes: 30 };

function loadSyncSettings(): SyncSettings {
  try {
    const raw = localStorage.getItem(SYNC_STORAGE_KEY);
    if (!raw) return DEFAULT_SYNC;
    const parsed = JSON.parse(raw) as Partial<SyncSettings>;
    return {
      repository: typeof parsed.repository === "string" ? parsed.repository : "",
      token: typeof parsed.token === "string" ? parsed.token : "",
      autoSync: parsed.autoSync === true,
      intervalMinutes: [15, 30, 60].includes(Number(parsed.intervalMinutes)) ? Number(parsed.intervalMinutes) : 30,
    };
  } catch {
    return DEFAULT_SYNC;
  }
}

const nav: Array<{ key: ViewKey; label: string; icon: string }> = [
  { key: "dashboard", label: "Dashboard", icon: "▦" },
  { key: "archive", label: "Архив", icon: "▤" },
  { key: "analytics", label: "Аналитика", icon: "◫" },
  { key: "sources", label: "Источники", icon: "◎" },
  { key: "data", label: "Данные", icon: "⇩" },
];

export default function App() {
  const [view, setView] = useState<ViewKey>("dashboard");
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [dashboard, setDashboard] = useState<DashboardOverview | null>(null);
  const [period, setPeriod] = useState<PeriodDays>(30);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [globalQuery, setGlobalQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [archiveSeed, setArchiveSeed] = useState("");
  const [workroomOpen, setWorkroomOpen] = useState(false);
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(loadSyncSettings);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const syncBusyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const refreshCore = useCallback(async () => {
    const [nextStats, nextRuns] = await Promise.all([desktopApi.stats(), desktopApi.runs()]);
    setStats(nextStats);
    setRuns(nextRuns);
  }, []);

  const refreshDashboard = useCallback(async (nextPeriod: PeriodDays) => {
    setDashboardLoading(true);
    try {
      setDashboard(await desktopApi.dashboard(nextPeriod));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  const performSync = useCallback(async (settings: SyncSettings, silent = false) => {
    if (!settings.repository.trim() || syncBusyRef.current) {
      if (!settings.repository.trim()) setSyncStatus("не настроено");
      return;
    }
    syncBusyRef.current = true;
    setSyncBusy(true);
    if (!silent) setError("");
    try {
      const result = await desktopApi.syncGithub(settings.repository.trim(), settings.token);
      const latest = result.latestAvailableRun;
      if (result.errors.length) {
        setSyncStatus(`частично · ${result.errors.length} ошибок`);
        if (!silent) setError(result.errors.join("\n"));
      } else if (latest != null) {
        setSyncStatus(`актуально · run ${latest}`);
      } else {
        setSyncStatus("артефакты не найдены");
      }
      if (result.importedRuns.length) {
        setMessage(`Auto Sync: добавлены run ${result.importedRuns.join(", ")}.`);
        await Promise.all([refreshCore(), refreshDashboard(period)]);
      }
    } catch (reason) {
      setSyncStatus("ошибка синхронизации");
      if (!silent) setError(String(reason));
    } finally {
      syncBusyRef.current = false;
      setSyncBusy(false);
    }
  }, [period, refreshCore, refreshDashboard]);

  useEffect(() => {
    refreshCore().catch((reason) => setError(String(reason)));
  }, [refreshCore]);

  useEffect(() => {
    refreshDashboard(period);
  }, [period, refreshDashboard]);

  useEffect(() => {
    if (!syncSettings.autoSync || !syncSettings.repository.trim()) return;
    const start = window.setTimeout(() => performSync(syncSettings, true), 900);
    const interval = window.setInterval(() => performSync(syncSettings, true), syncSettings.intervalMinutes * 60_000);
    return () => { window.clearTimeout(start); window.clearInterval(interval); };
  }, [syncSettings, performSync]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setWorkroomOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function importBundle() {
    setError("");
    setMessage("");
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Импортировать Dashboard bundle",
      filters: [{ name: "Dashboard bundle ZIP", extensions: ["zip"] }],
    });
    if (!selected || Array.isArray(selected)) return;

    setBusy(true);
    try {
      const result: ImportResult = await desktopApi.importBundle(selected);
      const prefix = result.status === "already_imported" ? "Этот запуск уже был импортирован" : result.status === "replaced" ? "Запуск переимпортирован" : "Bundle импортирован";
      setMessage(`${prefix}: run ${result.runNumber ?? "—"}, ${result.publications} публикаций, ${result.sourcesInCoverage} источников coverage.`);
      await Promise.all([refreshCore(), refreshDashboard(period)]);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  function saveSyncSettings(next: SyncSettings) {
    const normalized = { ...next, repository: next.repository.trim(), intervalMinutes: [15, 30, 60].includes(next.intervalMinutes) ? next.intervalMinutes : 30 };
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(normalized));
    setSyncSettings(normalized);
    setSyncStatus(normalized.repository ? "настроено" : "не настроено");
    setMessage("Настройки Auto Sync сохранены локально.");
  }

  function showArchiveForSearch(query: string) {
    setArchiveSeed(query);
    setGlobalQuery(query);
    setSearchOpen(false);
    setView("archive");
  }

  function navigate(next: ViewKey) {
    setView(next);
    if (next !== "archive") setArchiveSeed("");
  }

  const latestProduction = runs.find((run) => run.dryRun === false) ?? runs[0] ?? null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate("dashboard")}>
          <span className="brand-mark">M</span>
          <span><b>Monitor Dashboard</b><small>SEP-Monitor · Desktop 0.4.1</small></span>
        </button>
        <div className="global-search-wrap">
          <span className="search-icon">⌕</span>
          <input
            ref={searchRef}
            value={globalQuery}
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => { setGlobalQuery(event.target.value); setSearchOpen(true); }}
            placeholder="Поиск по собранным материалам…"
            aria-label="Глобальный поиск"
          />
          <kbd>Ctrl K</kbd>
        </div>
        <div className="top-actions">
          <span className="module-pill">SEP-Monitor</span>
          {latestProduction?.runNumber != null && <span className="run-pill">run {latestProduction.runNumber}</span>}
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="nav-label">Навигация</div>
          {nav.slice(0, 4).map((item) => (
            <button key={item.key} className={`nav-item ${view === item.key ? "active" : ""}`} onClick={() => navigate(item.key)}>
              <span className="nav-icon">{item.icon}</span>{item.label}
            </button>
          ))}
          <button className={`nav-item workroom-nav ${workroomOpen ? "active" : ""}`} onClick={() => setWorkroomOpen((value) => !value)}><span className="nav-icon">◌</span>Рабочая комната</button>
          {nav.slice(4).map((item) => (
            <button key={item.key} className={`nav-item ${view === item.key ? "active" : ""}`} onClick={() => navigate(item.key)}>
              <span className="nav-icon">{item.icon}</span>{item.label}
            </button>
          ))}
          <div className="sidebar-spacer" />
          <button className="side-status side-status-button" onClick={() => navigate("data")} title="Открыть синхронизацию">
            <span className={`status-dot ${syncBusy ? "pulse" : ""}`} />
            <div><b>{syncSettings.autoSync ? "Auto Sync" : "Локальная база"}</b><small>{syncSettings.autoSync && syncSettings.repository ? (syncStatus || "готово к проверке") : stats ? `${stats.documents} публикаций · ${stats.sources} источников` : "инициализация…"}</small></div>
          </button>
        </aside>

        <main className="content">
          {message && <div className="notice success global-notice"><span>{message}</span><button onClick={() => setMessage("")}>×</button></div>}
          {error && <div className="notice error global-notice"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
          {view === "dashboard" && <DashboardView data={dashboard} period={period} onPeriodChange={setPeriod} loading={dashboardLoading} onOpenArchive={() => navigate("archive")} />}
          {view === "archive" && <ArchiveView initialQuery={archiveSeed} />}
          {view === "analytics" && <AnalyticsView data={dashboard} period={period} onPeriodChange={setPeriod} />}
          {view === "sources" && <SourcesView />}
          {view === "data" && <DataView stats={stats} runs={runs} busy={busy} onImport={importBundle} syncSettings={syncSettings} onSaveSyncSettings={saveSyncSettings} onSyncNow={(value) => performSync(value)} syncBusy={syncBusy} syncStatus={syncStatus} />}
        </main>
      </div>

      <SearchOverlay query={globalQuery} open={searchOpen} onClose={() => setSearchOpen(false)} onShowArchive={showArchiveForSearch} />
      <WorkroomDrawer open={workroomOpen} onClose={() => setWorkroomOpen(false)} />
    </div>
  );
}
