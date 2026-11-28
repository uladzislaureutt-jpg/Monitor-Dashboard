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
import { WReviewView } from "./views/WReviewView";
import { EventTraceView } from "./views/EventTraceView";
import { TranscriptionView } from "./views/TranscriptionView";
import { NetworksView, type NetworkPage, type NetworkPlatform } from "./views/NetworksView";
import { useReportWorkspace } from "./reportWorkspace";
import { useMonitorAccess } from "./access";
import { getRuntimeConfig, loadWorkroomConfig } from "./workroom";
import { invalidateOverview, loadOverview, peekOverview } from "./overviewCache";
import { invalidateArchiveCache } from "./archiveCache";
import { coreFresh, invalidateCore, peekCore, saveCore } from "./coreCache";

const SYNC_STORAGE_KEY = "monitor-dashboard-github-sync-v2";
const SYNC_PERSIST_KEY = "github.sync.v2";
const FIRST_SYNC_PREFIX = "monitor.first-sync.v1";
const DEFAULT_SYNC: SyncSettings = { repository: "", token: "", autoSync: false, intervalMinutes: 30 };
const DEFAULT_L_SYNC: SyncSettings = { repository: "vladreuth-cmd/M-Trouble", token: "", autoSync: false, intervalMinutes: 30 };

type MonitorKey = "social_economic" | "lukashenko";
type MonitorSyncSettings = Record<MonitorKey, SyncSettings>;
type SyncUiStatus = { kind: "none" | "notConfigured" | "configured" | "notFound" | "upToDate"; run?: number };

function versionAtLeast(current: string, minimum: string) {
  const parse = (value: string) => value.split(".").map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  const a = parse(current), b = parse(minimum);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    const left = a[index] || 0, right = b[index] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

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
  const social = normalizeSyncSettings(hasMonitorKeys ? value.social_economic : value);
  return {
    social_economic: { ...social, repository: "", token: "" },
    lukashenko: {
      ...DEFAULT_L_SYNC,
      ...normalizeSyncSettings(hasMonitorKeys ? value.lukashenko : DEFAULT_L_SYNC),
      repository: "",
      token: "",
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
  const { t, locale } = useI18n();
  const report = useReportWorkspace();
  const access = useMonitorAccess();
  const [appVersion, setAppVersion] = useState("—");
  const [effectiveMinimumVersion, setEffectiveMinimumVersion] = useState("0.0.0");
  const [view, setView] = useState<ViewKey>("dashboard");
  const [monitorKey, setMonitorKey] = useState<MonitorKey>("social_economic");
  const [wReviewOpen, setWReviewOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [wReviewDenied, setWReviewDenied] = useState(false);
  const [wReviewSection, setWReviewSection] = useState<"review" | "style">("review");
  const [transcriptionOpen, setTranscriptionOpen] = useState(false);
  const [networksOpen, setNetworksOpen] = useState(false);
  const [networksPage, setNetworksPage] = useState<NetworkPage>("home");
  const [networksPlatform, setNetworksPlatform] = useState<NetworkPlatform>("tiktok");
  const [stats, setStats] = useState<DatabaseStats | null>(() => peekCore("social_economic")?.stats ?? null);
  const [runs, setRuns] = useState<RunSummary[]>(() => peekCore("social_economic")?.runs ?? []);
  const latestLMonitorRun = runs.find((run) => run.monitorKey === "lukashenko" && !run.collector && run.dryRun !== true);
  const latestAssistantRuns = [1, 2, 3].map(id => runs.find(run => run.monitorKey === "lukashenko" && run.collector === "api_assistant" && (run.collectorAssistantId ?? 1) === id));
  const [dashboard, setDashboard] = useState<DashboardOverview | null>(() => peekOverview("social_economic", 30)?.data ?? null);
  const [period, setPeriod] = useState<PeriodDays>(30);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
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
  const activeMonitorRef = useRef<MonitorKey>("social_economic");
  const activePeriodRef = useRef<PeriodDays>(30);
  const dashboardSeq = useRef(0);
  const coreSeq = useRef(0);
  activePeriodRef.current = period;

  // Only anonymous duration and monitor key are recorded, and only when the
  // WebView supports Chromium's Long Tasks API. Sampling is throttled to
  // avoid causing additional UI work during heavy renders.
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    let observer: PerformanceObserver | null = null;
    let lastReported = 0;
    try {
      observer = new PerformanceObserver((list) => {
        for (const task of list.getEntries()) {
          const elapsedMs = Math.round(task.duration);
          const now = performance.now();
          if (elapsedMs < 150 || now - lastReported < 2000) continue;
          lastReported = now;
          void desktopApi.recordUiLongtask(activeMonitorRef.current, elapsedMs).catch(() => {});
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch { observer?.disconnect(); return; }
    return () => observer?.disconnect();
  }, []);

  const refreshCore = useCallback(async (key: MonitorKey = activeMonitorRef.current, force = false) => {
    const request = ++coreSeq.current;
    const cached = peekCore(key);
    if (cached && key === activeMonitorRef.current) {
      setStats(cached.stats); setRuns(cached.runs);
    }
    if (!force && cached && coreFresh(key)) return;
    const [nextStats, nextRuns] = await Promise.all([desktopApi.statsFor(key), desktopApi.runsFor(key)]);
    if (request !== coreSeq.current) return;
    saveCore(key, nextStats, nextRuns);
    if (key !== activeMonitorRef.current) return;
    setStats(nextStats); setRuns(nextRuns);
  }, []);
  const refreshDashboard = useCallback(async (
    nextPeriod: PeriodDays, force = false, key: MonitorKey = activeMonitorRef.current,
  ) => {
    const request = ++dashboardSeq.current;
    const stillCurrent = () => request === dashboardSeq.current && key === activeMonitorRef.current && nextPeriod === activePeriodRef.current;
    const cached = peekOverview(key, nextPeriod);
    if (stillCurrent()) {
      if (!force) setDashboard(cached?.data ?? null);
      setDashboardLoading(!cached && !force);
    }
    try {
      const next = await loadOverview(key, nextPeriod, force);
      if (stillCurrent()) setDashboard(next);
    } catch (reason) {
      if (stillCurrent() && !cached) setError(String(reason));
    } finally {
      if (stillCurrent()) setDashboardLoading(false);
    }
  }, []);

  const performSync = useCallback(async (
    settings: SyncSettings, silent = false, syncKey: MonitorKey = activeMonitorRef.current,
  ) => {
    if (syncBusyRef.current) return;
    syncBusyRef.current = true; setSyncBusy(true);
    if (!silent) { setError(""); setSyncWarning(""); }
    try {
      const workroomConfig = loadWorkroomConfig();
      const result = await desktopApi.syncServerFor(syncKey, workroomConfig.url, workroomConfig.anonKey, access.session.accessToken);
      const latestImported = result.latestImportedRun ?? result.latestAvailableRun;
      const latestRemote = result.latestRemoteRun;
      const remoteIsSkippedDryRun = latestRemote != null && result.skippedDryRuns.includes(latestRemote);
      if (result.errors.length) {
        if (!silent) setSyncWarning(result.errors.join("\n"));
      } else if (latestRemote != null && latestImported != null && latestRemote > latestImported && !remoteIsSkippedDryRun) {
        if (!silent) setSyncWarning(locale === "be"
          ? `На GitHub даступны запуск #${latestRemote}, лакальна імпартаваны #${latestImported}.`
          : `На GitHub доступен запуск #${latestRemote}, локально импортирован #${latestImported}.`);
      }
      if (activeMonitorRef.current === syncKey) {
        if (latestImported != null && (latestRemote == null || latestImported >= latestRemote || remoteIsSkippedDryRun)) setSyncStatus({ kind: "upToDate", run: latestImported });
        else if (latestRemote != null || result.errors.length) setSyncStatus({ kind: "configured" });
        else setSyncStatus({ kind: "notFound" });
      }
      if (result.importedRuns.length || result.assistantImportedRuns) {
        invalidateOverview(syncKey);
        invalidateArchiveCache(syncKey);
        invalidateCore(syncKey);
        window.dispatchEvent(new CustomEvent("monitor:data-updated", { detail: { monitorKey: syncKey } }));
        if (activeMonitorRef.current === syncKey) {
          setMessage([result.importedRuns.length ? t("sync.added", { runs: result.importedRuns.join(", ") }) : "", result.assistantImportedRuns ? `Помощник: обновлено сборов ${result.assistantImportedRuns}` : ""].filter(Boolean).join(". "));
          await Promise.all([refreshCore(syncKey, true), refreshDashboard(activePeriodRef.current, true, syncKey)]);
        }
      }
    } catch (reason) {
      if (activeMonitorRef.current === syncKey) setSyncStatus({ kind: "configured" });
      if (!silent) setSyncWarning(String(reason));
    } finally { syncBusyRef.current = false; setSyncBusy(false); }
  }, [refreshCore, refreshDashboard, t, locale, access.session.accessToken]);

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
          setSyncStatus({ kind: "configured" });
          void desktopApi.setSetting(SYNC_PERSIST_KEY, JSON.stringify(next));
          return;
        } catch { /* fall through to local migration */ }
      }
      if (local.social_economic.repository || local.social_economic.token || local.social_economic.autoSync || local.lukashenko.repository) void desktopApi.setSetting(SYNC_PERSIST_KEY, JSON.stringify(local));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { getVersion().then(setAppVersion).catch(() => undefined); }, []);
  useEffect(() => {
    if (appVersion === "—" || !access.session?.userId) return;
    let cancelled = false;
    getRuntimeConfig(loadWorkroomConfig(), access.session).then((runtime) => {
      if (!cancelled) setEffectiveMinimumVersion(runtime.effectiveMinimumVersion);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [appVersion, access.session?.userId]);
  useEffect(() => {
    if (!syncWarning) return;
    const timer = window.setTimeout(() => setSyncWarning(""), 12_000);
    return () => window.clearTimeout(timer);
  }, [syncWarning]);
  useEffect(() => { void refreshCore(monitorKey).catch((reason) => setError(String(reason))); }, [monitorKey, refreshCore]);
  useEffect(() => {
    setSyncStatus({ kind: "configured" });
  }, [monitorKey, syncSettings.repository]);
  useEffect(() => { void refreshDashboard(period, false, monitorKey); }, [period, monitorKey, refreshDashboard]);
  useEffect(() => {
    const onModeration = () => { invalidateOverview(activeMonitorRef.current); invalidateArchiveCache(activeMonitorRef.current, true); void refreshDashboard(activePeriodRef.current, true); };
    window.addEventListener("monitor:moderation-changed", onModeration);
    return () => window.removeEventListener("monitor:moderation-changed", onModeration);
  }, [period, refreshDashboard]);
  useEffect(() => {
    if (access.profile.isAdmin || !access.session?.userId || !access.monitors.length) return;
    let cancelled = false;
    const bootstrapKey = `${FIRST_SYNC_PREFIX}:${access.session.userId}`;
    (async () => {
      const stored = await desktopApi.getSetting(bootstrapKey).catch(() => null);
      let completed: MonitorKey[] = [];
      try {
        const parsed = stored ? JSON.parse(stored) : [];
        completed = Array.isArray(parsed) ? parsed.filter((value): value is MonitorKey => value === "social_economic" || value === "lukashenko") : [];
      } catch { completed = []; }
      if (cancelled) return;

      const allowed: MonitorKey[] = (["social_economic", "lukashenko"] as MonitorKey[])
        .filter((key) => access.monitors.find((item) => item.monitorKey === key)?.enabled === true);
      const pending = allowed.filter((key) => !completed.includes(key));
      if (!pending.length) return;

      const workroomConfig = loadWorkroomConfig();
      syncBusyRef.current = true;
      setSyncBusy(true);
      setMessage(locale === "be" ? "Першасная сінхранізацыя даступных маніторынгаў…" : "Первичная синхронизация доступных мониторингов…");
      try {
        for (const key of pending) {
          if (cancelled) return;
          const result = await desktopApi.syncServerFor(key, workroomConfig.url, workroomConfig.anonKey, access.session.accessToken);
          if (result.errors.length) {
            setSyncWarning(result.errors.join("\n"));
            return;
          }
          completed = [...new Set([...completed, key])];
          await desktopApi.setSetting(bootstrapKey, JSON.stringify(completed));
        }
        if (!cancelled) {
          setMessage(locale === "be" ? "Першасная сінхранізацыя завершана." : "Первичная синхронизация завершена.");
          await Promise.all([refreshCore(activeMonitorRef.current, true), refreshDashboard(activePeriodRef.current, true)]);
        }
      } catch (reason) {
        if (!cancelled) setSyncWarning(String(reason));
      } finally {
        syncBusyRef.current = false;
        if (!cancelled) setSyncBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [access.profile.isAdmin, access.session?.userId, access.session.accessToken, access.monitors, locale, refreshCore, refreshDashboard]);

  // The independent feed checks for already collected cards without starting
  // paid searches or changing the user's GitHub auto-sync preference.
  // Assistant updates are independent of which monitor the operator is viewing.
  useEffect(() => {
    if (!access.session.accessToken) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      if (syncBusyRef.current) return;
      syncBusyRef.current = true;
      try {
        const config = loadWorkroomConfig();
        const count = await desktopApi.syncLNewsAssistant(config.url, config.anonKey, access.session.accessToken);
        if (count && !stopped) {
          invalidateOverview("lukashenko");
          invalidateArchiveCache("lukashenko");
          invalidateCore("lukashenko");
          window.dispatchEvent(new CustomEvent("monitor:data-updated", { detail: { monitorKey: "lukashenko" } }));
          if (activeMonitorRef.current === "lukashenko") {
            await Promise.all([refreshCore("lukashenko", true), refreshDashboard(activePeriodRef.current, true, "lukashenko")]);
          }
        }
      } catch (reason) { if (!stopped) setSyncWarning(`Помощник: ${String(reason)}`); }
      finally { syncBusyRef.current = false; }
    }, 5 * 60_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [access.session.accessToken, refreshCore, refreshDashboard]);

  // One background scheduler per signed-in session, never per tab switch.
  const canSyncSep = access.profile.isAdmin || access.monitors.some((m) => m.monitorKey === "social_economic" && m.enabled);
  const canSyncL = access.profile.isAdmin || access.monitors.some((m) => m.monitorKey === "lukashenko" && m.enabled);
  useEffect(() => {
    if (!access.session?.userId || !access.session.accessToken) return;
    let stopped = false;
    let ticking = false;
    const lastChecked: Partial<Record<MonitorKey, number>> = {};
    const poll = async () => {
      if (stopped || ticking || syncBusyRef.current) return;
      ticking = true;
      try {
        for (const key of ["lukashenko", "social_economic"] as MonitorKey[]) {
          if (stopped || syncBusyRef.current) break;
          const settings = syncSettingsByMonitor[key];
          if (key === "lukashenko" ? !canSyncL : !canSyncSep || !settings.autoSync) continue;
          const intervalMs = Math.max(5, key === "lukashenko" && !settings.autoSync ? 30 : settings.intervalMinutes) * 60_000;
          if (Date.now() - (lastChecked[key] || 0) < intervalMs) continue;
          lastChecked[key] = Date.now();
          await performSync(settings, true, key);
        }
      } finally { ticking = false; }
    };
    const start = window.setTimeout(() => { void poll(); }, 2500);
    const ticker = window.setInterval(() => { void poll(); }, 60_000);
    return () => { stopped = true; window.clearTimeout(start); window.clearInterval(ticker); };
  }, [access.session?.userId, access.session.accessToken, canSyncSep, canSyncL, syncSettingsByMonitor, performSync]);
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
      invalidateOverview(monitorKey);
      invalidateArchiveCache(monitorKey);
      invalidateCore(monitorKey);
      window.dispatchEvent(new CustomEvent("monitor:data-updated", { detail: { monitorKey } }));
      await Promise.all([refreshCore(activeMonitorRef.current, true), refreshDashboard(activePeriodRef.current, true)]);
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
  function navigate(next: ViewKey) {
    setWReviewDenied(false);
    if ((next === "data" || next === "sources") && !access.profile.isAdmin) return;
    setWReviewOpen(false);
    setEventOpen(false);
    setTranscriptionOpen(false);
    setNetworksOpen(false);
    setView(next);
    if (next !== "archive") setArchiveSeed("");
  }
  function switchMonitor(next: MonitorKey) {
    setWReviewDenied(false);
    const state = access.monitors.find((item) => item.monitorKey === next);
    if (!access.profile.isAdmin && state && !state.enabled) return;
    if (next === monitorKey && !wReviewOpen && !eventOpen && !transcriptionOpen && !networksOpen) return;
    setWReviewOpen(false);
    setEventOpen(false);
    setTranscriptionOpen(false);
    setNetworksOpen(false);
    activeMonitorRef.current = next;
    dashboardSeq.current++;
    coreSeq.current++;
    setDashboard(peekOverview(next, activePeriodRef.current)?.data ?? null);
    setDashboardLoading(false);
    setStats(peekCore(next)?.stats ?? null);
    setRuns(peekCore(next)?.runs ?? []);
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
  const activeMonitorAccess = access.monitors.find((item) => item.monitorKey === monitorKey);
  const wReviewAccess = access.monitors.find((item) => item.monitorKey === "w_review");
  const wReviewAllowed = access.profile.isAdmin || wReviewAccess?.enabled === true;
  const eventAllowed = access.canOpenModule("event_trace");
  const networksAllowed = access.canOpenModule("tiktok");
  const monitorBlocked = !access.profile.isAdmin && activeMonitorAccess?.enabled === false;
  useEffect(() => { if (!networksAllowed && networksOpen) setNetworksOpen(false); }, [networksAllowed, networksOpen]);
  useEffect(() => { if (!eventAllowed && eventOpen) setEventOpen(false); }, [eventAllowed, eventOpen]);
  useEffect(() => {
    if (wReviewDenied && wReviewAllowed) { setWReviewOpen(true); setWReviewDenied(false); }
  }, [wReviewDenied, wReviewAllowed]);
  const maintenanceMessage = locale === "be"
    ? activeMonitorAccess?.maintenanceMessageBe || "Тэхнічныя работы"
    : activeMonitorAccess?.maintenanceMessageRu || "Технические работы";
  const syncStatusText = syncStatus.kind === "upToDate" ? t("status.upToDate", { run: syncStatus.run ?? "—" })
    : syncStatus.kind === "notFound" ? t("status.notFound")
    : syncStatus.kind === "configured" ? t("status.configured")
    : syncStatus.kind === "notConfigured" ? t("status.notConfigured") : "";

  const standardContent = <>
    {message && <div className="notice success global-notice"><span>{message}</span><button onClick={() => setMessage("")}>×</button></div>}
    {error && <div className="notice error global-notice"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
    {syncWarning && <div className="notice error global-notice"><span>{syncWarning}</span><button onClick={() => setSyncWarning("")}>×</button></div>}
    {wReviewDenied && !wReviewAllowed ? (
      <section className="maintenance-screen panel"><h2>{locale === "be" ? "W-Review: няма доступу" : "W-Review: нет доступа"}</h2><p>{locale === "be" ? "Для гэтага ўліковага запісу пакуль няма дазволу на W-Review. Калі дазвол ужо выдадзены, абнавіце доступ." : "Для этой учётной записи пока нет разрешения на W-Review. Если разрешение уже выдано, обновите доступ."}</p><button className="primary-button" onClick={() => void access.refreshAccess()}>{locale === "be" ? "Абнавіць доступ" : "Обновить доступ"}</button></section>
    ) : monitorBlocked ? (
      <section className="maintenance-screen panel">
        <div className="brand-mark large">M</div>
        <h2>{maintenanceMessage}</h2>
        <p>{locale === "be" ? "Маніторынг часова недаступны для аператараў." : "Мониторинг временно недоступен для операторов."}</p>
      </section>
    ) : <>
      {view === "dashboard" && <DashboardView key={monitorKey} monitorKey={monitorKey} data={dashboard} period={period} onPeriodChange={setPeriod} loading={dashboardLoading} onOpenArchive={() => navigate("archive")} latestRun={latestLMonitorRun} latestAssistantRuns={latestAssistantRuns} />}
      {view === "archive" && <ArchiveView key={monitorKey} initialQuery={archiveSeed} monitorKey={monitorKey} />}
      {view === "report" && <ReportView key={monitorKey} />}
      {view === "analytics" && <AnalyticsView key={monitorKey} data={dashboard} period={period} onPeriodChange={setPeriod} />}
      {view === "sources" && access.profile.isAdmin && <SourcesView key={monitorKey} monitorKey={monitorKey} />}
      {view === "data" && access.profile.isAdmin && <DataView key={monitorKey} monitorKey={monitorKey} stats={stats} runs={runs.filter((run) => run.monitorKey === monitorKey)} busy={busy} onImport={importBundle} syncSettings={syncSettings} onSaveSyncSettings={saveSyncSettings} onSyncNow={(value) => performSync(value)} syncBusy={syncBusy} syncStatus={syncStatusText} />}
    </>}
  </>;

  if (appVersion !== "—" && !versionAtLeast(appVersion, effectiveMinimumVersion)) {
    return <div className="access-shell"><div className="access-card suspended-card"><div className="brand-mark large">M</div><h1>{locale === "be" ? "Патрабуецца абнаўленне" : "Требуется обновление"}</h1><p>{locale === "be" ? `Версія Monitor ${appVersion} больш не падтрымліваецца. Мінімальная падтрымліваемая версія: ${effectiveMinimumVersion}.` : `Версия Monitor ${appVersion} больше не поддерживается. Минимальная поддерживаемая версия: ${effectiveMinimumVersion}.`}</p><button className="primary-button" onClick={access.logout}>{locale === "be" ? "Выйсці" : "Выйти"}</button></div></div>;
  }

  const workroomButton = <button
    className={`nav-item workroom-nav ${workroomOpen ? "active" : ""} ${workroomUnread ? "has-unread" : ""}`}
    onClick={() => setWorkroomOpen((value) => !value)}
    aria-expanded={workroomOpen}
    title={workroomUnread ? t("workroom.unreadLabel", {count: workroomUnread}) : undefined}>
    <span className="nav-icon" aria-hidden="true">◌</span>
    <span className="workroom-nav-label">{t("nav.workroom")}</span>
    {workroomUnread > 0 && <span className="workroom-unread"
      aria-label={t("workroom.unreadLabel", {count: workroomUnread})}>
      {workroomUnread > 99 ? "99+" : workroomUnread}
    </span>}
  </button>;

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => navigate("dashboard")}><span className="brand-mark">M</span><span><b>{t("brand.title")}</b><small>{t("brand.subtitle", { version: appVersion })}</small></span></button>
      {!networksOpen && !eventOpen && <div className="global-search-wrap"><span className="search-icon">⌕</span><input ref={searchRef} value={globalQuery} onFocus={() => setSearchOpen(true)} onChange={(event) => { setGlobalQuery(event.target.value); setSearchOpen(true); }} placeholder={t("search.placeholder")} aria-label={t("search.aria")} /><kbd>Ctrl K</kbd></div>}
      <div className="top-actions">
        <div className="language-switch" role="group" aria-label={t("lang.aria")}><button className={locale === "ru" ? "active" : ""} onClick={() => void access.setPreferredLocale("ru")}>{t("lang.ru")}</button><button className={locale === "be" ? "active" : ""} onClick={() => void access.setPreferredLocale("be")}>{t("lang.be")}</button></div>
        <div className="module-switch" role="group" aria-label="Выбор мониторинга">
          <button disabled={!access.profile.isAdmin && access.monitors.find((item) => item.monitorKey === "social_economic")?.enabled === false} title={!access.profile.isAdmin && access.monitors.find((item) => item.monitorKey === "social_economic")?.enabled === false ? (locale === "be" ? "Тэхнічныя работы" : "Технические работы") : ""} className={monitorKey === "social_economic" && !wReviewOpen && !networksOpen && !eventOpen ? "active" : ""} onClick={() => switchMonitor("social_economic")}>SEP-Monitor</button>
          <button disabled={!access.profile.isAdmin && access.monitors.find((item) => item.monitorKey === "lukashenko")?.enabled === false} title={!access.profile.isAdmin && access.monitors.find((item) => item.monitorKey === "lukashenko")?.enabled === false ? (locale === "be" ? "Тэхнічныя работы" : "Технические работы") : ""} className={monitorKey === "lukashenko" && !wReviewOpen && !networksOpen && !eventOpen ? "active" : ""} onClick={() => switchMonitor("lukashenko")}>L-Monitor</button>
          <button
            title={!wReviewAllowed ? (locale === "be" ? "W-Review пакуль недаступны для вашага ўліковага запісу" : "W-Review пока недоступен для вашей учётной записи") : ""}
            className={wReviewOpen ? "active" : ""}
            onClick={() => { setEventOpen(false); if (!wReviewAllowed) { setWReviewDenied(true); setTranscriptionOpen(false); setNetworksOpen(false); void access.refreshAccess(); return; } setWReviewDenied(false); setWReviewOpen(true); setTranscriptionOpen(false); setNetworksOpen(false); setWReviewSection("review"); setWorkroomOpen(false); }}
          >W-Review</button>
          {eventAllowed && <button className={eventOpen ? "active" : ""} onClick={() => {
            setEventOpen(true); setWReviewOpen(false); setWReviewDenied(false); setTranscriptionOpen(false);
            setNetworksOpen(false); setWorkroomOpen(false); setSearchOpen(false);
          }}>{locale === "be" ? "Падзея" : "Событие"}</button>}
          {networksAllowed && <button className={networksOpen ? "active" : ""} onClick={() => { setEventOpen(false); setNetworksOpen(true); setWReviewOpen(false); setTranscriptionOpen(false); setWReviewDenied(false); setWorkroomOpen(false); }} title={locale === "be" ? "Сацыяльныя сеткі: TikTok і Threads" : "Социальные сети: TikTok и Threads"}>{locale === "be" ? "Сеткі" : "Сети"}</button>}
        </div>
        <button className="account-button" onClick={access.logout} title={locale === "be" ? "Выйсці" : "Выйти"}><span>{access.profile.displayName}</span><small>{access.profile.isAdmin ? (locale === "be" ? "адміністратар" : "администратор") : (locale === "be" ? "аператар" : "оператор")}</small></button>
      </div>
    </header>
    <div className={`layout${eventOpen && eventAllowed ? " event-trace-layout" : ""}`}>{!(eventOpen && eventAllowed) && <aside className="sidebar">{networksOpen && networksAllowed ? <><div className="nav-label">{locale === "be" ? "Сеткі" : "Сети"}</div>
        <button className={`nav-item ${networksPlatform === "tiktok" && networksPage === "home" ? "active" : ""}`}
          onClick={() => { setNetworksPlatform("tiktok"); setNetworksPage("home"); }}>
          <span className="nav-icon">◉</span><span>{locale === "be" ? "Агляд TikTok" : "Обзор TikTok"}</span>
        </button>
        <button className={`nav-item ${networksPlatform === "tiktok" && networksPage === "archive" ? "active" : ""}`}
          onClick={() => { setNetworksPlatform("tiktok"); setNetworksPage("archive"); }}>
          <span className="nav-icon">▤</span><span>{locale === "be" ? "Архіў" : "Архив"}</span>
        </button>
        <button className={`nav-item ${networksPlatform === "tiktok" && networksPage === "editor" ? "active" : ""}`}
          onClick={() => { setNetworksPlatform("tiktok"); setNetworksPage("editor"); }}>
          <span className="nav-icon">✎</span><span>{locale === "be" ? "Рэдактар агляду" : "Редактор обзора"}</span>
        </button>
        {workroomButton}
        <div className="sidebar-spacer" /></> : wReviewOpen && wReviewAllowed ? <><div className="nav-label">{t("nav.label")}</div>{workroomButton}<button className="nav-item" onClick={() => { setTranscriptionOpen(true); setWReviewOpen(false); setWorkroomOpen(false); }}><span className="nav-icon">◍</span><span>{locale === "be" ? "Транскрыпцыя" : "Транскрипция"}</span></button><button className={`nav-item ${wReviewSection === "style" ? "active" : ""}`} onClick={() => { setWReviewSection("style"); setWorkroomOpen(false); }}><span className="nav-icon">✦</span><span>{locale === "be" ? "Аўтарскі стыль" : "Авторский стиль"}</span></button><div className="sidebar-spacer" /></> : <><div className="nav-label">{t("nav.label")}</div>{nav.filter((item) => item.key !== "data" && (item.key !== "sources" || access.profile.isAdmin)).map((item) => <button key={item.key} className={`nav-item ${view === item.key ? "active" : ""}`} onClick={() => navigate(item.key)}><span className="nav-icon">{item.icon}</span><span>{item.label}{item.key === "report" && report.pendingCount > 0 && <span className="report-count-badge">{report.pendingCount}</span>}</span></button>)}{workroomButton}<button className={`nav-item ${transcriptionOpen ? "active" : ""}`} onClick={() => { setTranscriptionOpen(true); setWReviewOpen(false); setWorkroomOpen(false); }}><span className="nav-icon">◍</span><span>{locale === "be" ? "Транскрыпцыя" : "Транскрипция"}</span></button>{!access.profile.isAdmin && <button className="nav-item" disabled={syncBusy || monitorBlocked} onClick={() => void performSync(syncSettings)}><span className="nav-icon">↻</span><span>{syncBusy ? (locale === "be" ? "Сінхранізацыя…" : "Синхронизация…") : (locale === "be" ? "Сінхранізацыя" : "Синхронизация")}</span></button>}{access.profile.isAdmin && nav.filter((item) => item.key === "data").map((item) => <button key={item.key} className={`nav-item ${view === item.key ? "active" : ""}`} onClick={() => navigate(item.key)}><span className="nav-icon">{item.icon}</span>{item.label}</button>)}<div className="sidebar-spacer" />{access.profile.isAdmin ? <button className="side-status side-status-button" onClick={() => navigate("data")} title={t("data.syncNow")}><span className={`status-dot ${syncBusy ? "pulse" : ""}`} /><div><b>{syncSettings.autoSync ? t("sync.autoLabel") : t("status.localDb")}</b><small>{syncSettings.autoSync && syncSettings.repository ? (syncStatusText || t("status.ready")) : dashboard ? t("status.stats", { docs: dashboard.publications, sources: dashboard.activeSources }) : t("status.initializing")}</small></div></button> : <div className="side-status"><span className="status-dot" /><div><b>{t("status.localDb")}</b><small>{dashboard ? t("status.stats", { docs: dashboard.publications, sources: dashboard.activeSources }) : t("status.initializing")}</small></div></div>}</>}</aside>}
      <main className="content">{eventOpen && eventAllowed ? <EventTraceView key={access.session!.userId} /> : networksOpen && networksAllowed ? <NetworksView key={`${access.session.userId}:${access.profile.isAdmin}`} page={networksPage} platform={networksPlatform} onPlatformChange={setNetworksPlatform} /> : transcriptionOpen ? <TranscriptionView /> : wReviewOpen && wReviewAllowed ? <WReviewView key={access.session!.userId} userId={access.session!.userId} section={wReviewSection} onCloseStyle={() => setWReviewSection("review")} /> : standardContent}</main>
    </div>
    <SearchOverlay key={monitorKey} query={globalQuery} open={searchOpen} onClose={() => setSearchOpen(false)} onShowArchive={showArchiveForSearch} /><WorkroomDrawer key={access.session.userId} open={workroomOpen} onClose={() => setWorkroomOpen(false)} onUnreadChange={setWorkroomUnread} />
  </div>;
}
