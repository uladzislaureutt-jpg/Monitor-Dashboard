import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "./api";
import type { DatabaseStats, DashboardOverview, ImportResult, PeriodDays, RunSummary, ViewKey } from "./types";
import { SearchOverlay } from "./components/SearchOverlay";
import { TeamDrawer } from "./components/TeamDrawer";
import { DashboardView } from "./views/DashboardView";
import { ArchiveView } from "./views/ArchiveView";
import { AnalyticsView } from "./views/AnalyticsView";
import { SourcesView } from "./views/SourcesView";
import { DataView } from "./views/DataView";

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
  const [teamOpen, setTeamOpen] = useState(false);
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

  useEffect(() => {
    refreshCore().catch((reason) => setError(String(reason)));
  }, [refreshCore]);

  useEffect(() => {
    refreshDashboard(period);
  }, [period, refreshDashboard]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setTeamOpen(false);
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate("dashboard")}>
          <span className="brand-mark">M</span>
          <span><b>Monitor Dashboard</b><small>Соц-экон · Desktop 0.4</small></span>
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
          <span className="module-pill">Соц-экон</span>
          <button className={`team-button ${teamOpen ? "active" : ""}`} onClick={() => setTeamOpen((value) => !value)}><span>◌</span> Команда</button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="nav-label">Навигация</div>
          {nav.map((item) => (
            <button key={item.key} className={`nav-item ${view === item.key ? "active" : ""}`} onClick={() => navigate(item.key)}>
              <span className="nav-icon">{item.icon}</span>{item.label}
            </button>
          ))}
          <div className="sidebar-spacer" />
          <div className="side-status">
            <span className="status-dot" />
            <div><b>Локальная база</b><small>{stats ? `${stats.documents} публикаций · ${stats.sources} источников` : "инициализация…"}</small></div>
          </div>
        </aside>

        <main className="content">
          {message && <div className="notice success global-notice">{message}</div>}
          {error && <div className="notice error global-notice"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
          {view === "dashboard" && <DashboardView data={dashboard} period={period} onPeriodChange={setPeriod} loading={dashboardLoading} onOpenArchive={() => navigate("archive")} />}
          {view === "archive" && <ArchiveView initialQuery={archiveSeed} />}
          {view === "analytics" && <AnalyticsView data={dashboard} period={period} onPeriodChange={setPeriod} />}
          {view === "sources" && <SourcesView />}
          {view === "data" && <DataView stats={stats} runs={runs} busy={busy} onImport={importBundle} />}
        </main>
      </div>

      <SearchOverlay query={globalQuery} open={searchOpen} onClose={() => setSearchOpen(false)} onShowArchive={showArchiveForSearch} />
      <TeamDrawer open={teamOpen} onClose={() => setTeamOpen(false)} />
    </div>
  );
}
