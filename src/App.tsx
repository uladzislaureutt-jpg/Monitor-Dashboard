import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { desktopApi } from "./api";
import type { DatabaseStats, DashboardOverview, ImportResult, PeriodDays, RunSummary, SyncSettings, ViewKey } from "./types";
import { useI18n } from "./i18n";
import { SearchOverlay } from "./components/SearchOverlay";
import { WorkroomDrawer } from "./components/WorkroomDrawer";
import { DashboardView } from "./views/DashboardView";
import { ArchiveView } from "./views/ArchiveView";
import { AnalyticsView } from "./views/AnalyticsView";
import { SourcesView } from "./views/SourcesView";
import { DataView } from "./views/DataView";
import { ReportView } from "./views/ReportView";
import { useReportWorkspace } from "./reportWorkspace";

const SYNC_STORAGE_KEY = "monitor-dashboard-github-sync-v2";
const SYNC_PERSIST_KEY = "github.sync.v2";
const DEFAULT_SYNC: SyncSettings = { repository: "", token: "", autoSync: false, intervalMinutes: 30 };
const DEFAULT_L_SYNC: SyncSettings = { repository: "vladreuth-cmd/M-Trouble", token: "", autoSync: false, intervalMinutes: 30 };

type MonitorKey = "social_economic" | "lukashenko";
type MonitorSyncSettings = Record<MonitorKey, SyncSettings>;
type SyncUiStatus = { kind: "none" | "notConfigured" | "configured" | "notFound" | "error" | "partial" | "upToDate"; run?: number; count?: number; errors?: string[] };

function normalizeSyncSettings(parsed: unknown): SyncSettings {
  const value = parsed && typeof parsed === "object" ? parsed as Partial<SyncSettings> : {};
  return {
    repository: typeof value.repository === "string" ? value.repository.trim() : "",
    token: typeof value.token === "string" ? value.token : "",
    autoSync: value.autoSync === true,
    intervalMinutes: [15, 30, 60].includes(Number(value.intervalMinutes)) ? Number(value.intervalMinutes) : 30,
  };
}

function normalizeMonitorSyncSettings(parsed: unknown): MonitorSyncSettings {
  const value = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const hasMonitorKeys = "social_economic" in value || "lukashenko" in value;
  return {
    social_economic: normalizeSyncSettings(hasMonitorKeys ? value.social_economic : value),
    lukashenko: {
      ...DEFAULT_L_SYNC,
      ...normalizeSyncSettings(hasMonitorKeys ? value.lukashenko : DEFAULT_L_SYNC),
    },
  };
}

function loadSyncSettings(): MonitorSyncSettings {
  try {
    const raw = localStorage.getItem(SYNC_STORAGE_KEY) ?? localStorage.getItem("monitor-dashboard-github-sync-v1");
    return raw ? normalizeMonitorSyncSettings(JSON.parse(raw)) : normalizeMonitorSyncSettings(null);
  } catch { return normalizeMonitorSyncSettings(null); }
}

export default function App() {
  const { t, locale, setLocale } = useI18n();
  const report = useReportWorkspace();
  const [appVersion, setAppVersion] = useState("—");
  const [view, setView] = useState<ViewKey>("dashboard");
  const [monitorKey, setMonitorKey] = useState<MonitorKey>("social_economic");
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
  const [workroomUnread, setWorkroomUnread] = useState(0);
  const [syncSettingsByMonitor, setSyncSettingsByMonitor] = useState<MonitorSyncSettings>(loadSyncSettings);
  const syncSettings = syncSettingsByMonitor[monitorKey];
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncUiStatus>({ kind: "none" });
  const syncBusyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const refreshCore = useCallback(async () => {
    const [nextStats, nextRuns] = await Promise.all([desktopApi.stats(), desktopApi.runs()]);
    setStats(nextStats); setRuns(nextRuns);
  }, [monitorKey]);
  const refreshDashboard = useCallback(async (nextPeriod: PeriodDays) => {
    setDashboardLoading(true);
    try { setDashboard(await desktopApi.dashboard(nextPeriod)); }
    catch (reason) { setError(String(reason)); }
    finally { setDashboardLoading(false); }
  }, []);

  const performSync = useCallback(async (settings: SyncSettings, silent = false) => {
    if (!settings.repository.trim() || syncBusyRef.current) {
      if (!settings.repository.trim()) setSyncStatus({ kind: "notConfigured" });
      return;
    }
    syncBusyRef.current = true; setSyncBusy(true); if (!silent) setError("");
    try {
      const result = await desktopApi.syncGithub(settings.repository.trim(), settings.token);
      const latest = result.latestAvailableRun;
      if (result.errors.length) {
        setSyncStatus({ kind: "partial", count: result.errors.length, errors: result.errors });
        if (!silent) setError(result.errors.join("\n"));
      } else if (latest != null) setSyncStatus({ kind: "upToDate", run: latest });
      else setSyncStatus({ kind: "notFound" });
      if (result.importedRuns.length) {
        setMessage(t("sync.added", { runs: result.importedRuns.join(", ") }));
        await Promise.all([refreshCore(), refreshDashboard(period)]);
      }
    } catch (reason) {
      setSyncStatus({ kind: "error" });
      if (!silent) setError(String(reason));
    } finally { syncBusyRef.current = false; setSyncBusy(false); }
  }, [period, refreshCore, refreshDashboard, t]);

  useEffect(() => {
    let cancelled = false;
    const local = loadSyncSettings();
    Promise.all([desktopApi.getSetting(SYNC_PERSIST_KEY), desktopApi.getSetting("github.sync.v1")]).then(([raw, legacyRaw]) => {
      if (cancelled) return;
      const stored = raw ?? legacyRaw;
      if (stored) {
        try {
          const next = normalizeMonitorSyncSettings(JSON.parse(stored));
          localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(next));
          setSyncSettingsByMonitor(next);
          setSyncStatus({ kind: next[monitorKey].repository ? "configured" : "notConfigured" });
          return;
        } catch { /* fall through to local migration */ }
      }
      if (local.social_economic.repository || local.social_economic.token || local.social_economic.autoSync || local.lukashenko.repository) void desktopApi.setSetting(SYNC_PERSIST_KEY, JSON.stringify(local));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { getVersion().then(setAppVersion).catch(() => undefined); }, []);
  useEffect(() => { refreshCore().catch((reason) => setError(String(reason))); }, [refreshCore]);
  useEffect(() => {
    setSyncStatus({ kind: syncSettings.repository ? "configured" : "notConfigured" });
  }, [monitorKey, syncSettings.repository]);
  useEffect(() => { refreshDashboard(period); }, [period, monitorKey, refreshDashboard]);
  useEffect(() => {
    const onModeration = () => refreshDashboard(period);
    window.addEventListener("monitor:moderation-changed", onModeration);
    return () => window.removeEventListener("monitor:moderation-changed", onModeration);
  }, [period, refreshDashboard]);
  useEffect(() => {
    if (!syncSettings.autoSync || !syncSettings.repository.trim()) return;
    const start = window.setTimeout(() => performSync(syncSettings, true), 900);
    const interval = window.setInterval(() => performSync(syncSettings, true), syncSettings.intervalMinutes * 60_000);
    return () => { window.clearTimeout(start); window.clearInterval(interval); };
  }, [syncSettings, performSync]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); window.setTimeout(() => searchRef.current?.focus(), 0); }
      if (event.key === "Escape") { setSearchOpen(false); setWorkroomOpen(false); }
    }
    function onWorkroomCompose() { setWorkroomOpen(true); }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("monitor:workroom-compose", onWorkroomCompose);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("monitor:workroom-compose", onWorkroomCompose); };
  }, []);

  async function importBundle() {
    setError(""); setMessage("");
    const selected = await open({ multiple: false, directory: false, title: t("import.dialog"), filters: [{ name: t("import.zip"), extensions: ["zip"] }] });
    if (!selected || Array.isArray(selected)) return;
    setBusy(true);
    try {
      const result: ImportResult = await desktopApi.importBundle(selected);
      const prefix = result.status === "already_imported" ? t("import.already") : result.status === "replaced" ? t("import.replaced") : t("import.done");
      setMessage(t("import.summary", { prefix, run: result.runNumber ?? "—", pubs: result.publications, sources: result.sourcesInCoverage }));
      await Promise.all([refreshCore(), refreshDashboard(period)]);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  function saveSyncSettings(next: SyncSettings) {
    const normalized = normalizeSyncSettings(next);
    const allSettings = { ...syncSettingsByMonitor, [monitorKey]: normalized };
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(allSettings));
    void desktopApi.setSetting(SYNC_PERSIST_KEY, JSON.stringify(allSettings));
    setSyncSettingsByMonitor(allSettings); setSyncStatus({ kind: normalized.repository ? "configured" : "notConfigured" }); setMessage(t("sync.saved"));
  }
  function showArchiveForSearch(query: string) { setArchiveSeed(query); setGlobalQuery(query); setSearchOpen(false); setView("archive"); }
  function navigate(next: ViewKey) { setView(next); if (next !== "archive") setArchiveSeed(""); }
  function switchMonitor(next: MonitorKey) {
    if (next === monitorKey) return;
    desktopApi.setActiveMonitorKey(next);
    setMonitorKey(next);
    setGlobalQuery(""); setArchiveSeed(""); setView("dashboard");
    window.dispatchEvent(new Event("monitor:changed"));
  }

  const nav: Array<{ key: ViewKey; label: string; icon: string }> = [
    { key: "dashboard", label: t("nav.dashboard"), icon: "▦" },
    { key: "archive", label: t("nav.archive"), icon: "▤" },
    { key: "report", label: t("nav.report"), icon: "✎" },
    { key: "analytics", label: t("nav.analytics"), icon: "◫" },
    { key: "sources", label: t("nav.sources"), icon: "◎" },
    { key: "data", label: t("nav.data"), icon: "⇩" },
  ];
  const syncStatusText = syncStatus.kind === "upToDate" ? t("status.upToDate", { run: syncStatus.run ?? "—" })
    : syncStatus.kind === "partial" ? t("status.partial", { count: syncStatus.count ?? 0 })
    : syncStatus.kind === "notFound" ? t("status.notFound")
    : syncStatus.kind === "error" ? t("status.syncError")
    : syncStatus.kind === "configured" ? t("status.configured")
    : syncStatus.kind === "notConfigured" ? t("status.notConfigured") : "";

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => navigate("dashboard")}><span className="brand-mark">M</span><span><b>{t("brand.title")}</b><small>{t("brand.subtitle", { version: appVersion })}</small></span></button>
      <div className="global-search-wrap"><span className="search-icon">⌕</span><input ref={searchRef} value={globalQuery} onFocus={() => setSearchOpen(true)} onChange={(event) => { setGlobalQuery(event.target.value); setSearchOpen(true); }} placeholder={t("search.placeholder")} aria-label={t("search.aria")} /><kbd>Ctrl K</kbd></div>
      <div className="top-actions">
        <div className="language-switch" role="group" aria-label={t("lang.aria")}><button className={locale === "ru" ? "active" : ""} onClick={() => setLocale("ru")}>{t("lang.ru")}</button><button className={locale === "be" ? "active" : ""} onClick={() => setLocale("be")}>{t("lang.be")}</button></div>
        <div className="module-switch" role="group" aria-label="Выбор мониторинга">
          <button className={monitorKey === "social_economic" ? "active" : ""} onClick={() => switchMonitor("social_economic")}>SEP-Monitor</button>
          <button className={monitorKey === "lukashenko" ? "active" : ""} onClick={() => switchMonitor("lukashenko")}>L-Monitor</button>
        </div>
      </div>
    </header>
    <div className="layout"><aside className="sidebar"><div className="nav-label">{t("nav.label")}</div>{nav.slice(0, 5).map((item) => <button key={item.key} className={`nav-item ${view === item.key ? "active" : ""}`} onClick={() => navigate(item.key)}><span className="nav-icon">{item.icon}</span><span>{item.label}{item.key === "report" && report.pendingCount > 0 && <span className="report-count-badge">{report.pendingCount}</span>}</span></button>)}<button className={`nav-item workroom-nav ${workroomOpen ? "active" : ""}`} onClick={() => setWorkroomOpen((value) => !value)}><span className="nav-icon">◌</span><span className="workroom-nav-label">{t("nav.workroom")}</span>{workroomUnread > 0 && <span className="workroom-unread">{workroomUnread > 99 ? "99+" : workroomUnread}</span>}</button>{nav.slice(5).map((item) => <button key={item.key} className={`nav-item ${view === item.key ? "active" : ""}`} onClick={() => navigate(item.key)}><span className="nav-icon">{item.icon}</span>{item.label}</button>)}<div className="sidebar-spacer" /><button className="side-status side-status-button" onClick={() => navigate("data")} title={t("data.syncNow")}><span className={`status-dot ${syncBusy ? "pulse" : ""}`} /><div><b>{syncSettings.autoSync ? t("sync.autoLabel") : t("status.localDb")}</b><small>{syncSettings.autoSync && syncSettings.repository ? (syncStatusText || t("status.ready")) : dashboard ? t("status.stats", { docs: dashboard.publications, sources: dashboard.activeSources }) : t("status.initializing")}</small></div></button></aside>
      <main className="content">{message && <div className="notice success global-notice"><span>{message}</span><button onClick={() => setMessage("")}>×</button></div>}{error && <div className="notice error global-notice"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}{view === "dashboard" && <DashboardView key={monitorKey} monitorKey={monitorKey} data={dashboard} period={period} onPeriodChange={setPeriod} loading={dashboardLoading} onOpenArchive={() => navigate("archive")} />}{view === "archive" && <ArchiveView key={monitorKey} initialQuery={archiveSeed} />}{view === "report" && <ReportView key={monitorKey} />}{view === "analytics" && <AnalyticsView key={monitorKey} data={dashboard} period={period} onPeriodChange={setPeriod} />}{view === "sources" && <SourcesView key={monitorKey} />}{view === "data" && <DataView key={monitorKey} stats={stats} runs={runs.filter((run) => run.monitorKey === monitorKey)} busy={busy} onImport={importBundle} syncSettings={syncSettings} onSaveSyncSettings={saveSyncSettings} onSyncNow={(value) => performSync(value)} syncBusy={syncBusy} syncStatus={syncStatusText} syncErrors={syncStatus.errors ?? []} />}</main>
    </div>
    <SearchOverlay key={monitorKey} query={globalQuery} open={searchOpen} onClose={() => setSearchOpen(false)} onShowArchive={showArchiveForSearch} /><WorkroomDrawer open={workroomOpen} onClose={() => setWorkroomOpen(false)} onUnreadChange={setWorkroomUnread} />
  </div>;
}
