import { useEffect, useState } from "react";
import type { DatabaseStats, RunSummary, SyncSettings } from "../types";
import { useI18n } from "../i18n";

export function DataView({
  stats,
  runs,
  busy,
  onImport,
  syncSettings,
  onSaveSyncSettings,
  onSyncNow,
  syncBusy,
  syncStatus,
}: {
  stats: DatabaseStats | null;
  runs: RunSummary[];
  busy: boolean;
  onImport: () => void;
  syncSettings: SyncSettings;
  onSaveSyncSettings: (value: SyncSettings) => void;
  onSyncNow: (value: SyncSettings) => void;
  syncBusy: boolean;
  syncStatus: string;
}) {
  const { t, formatLocale } = useI18n();
  const latest = runs[0] ?? null;
  const productionRuns = runs.filter((run) => run.dryRun === false).length;
  const [form, setForm] = useState(syncSettings);
  useEffect(() => setForm(syncSettings), [syncSettings]);
  const formatDate = (value: string | null) => { if (!value) return "—"; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(formatLocale); };
  const formatMode = (value: boolean | null) => value === true ? t("data.modeDry") : value === false ? t("data.modeProduction") : t("data.modeUnknown");
  return <div className="view-stack">
    <section className="hero data-hero"><div><div className="eyebrow">{t("data.eyebrow")}</div><h2>{t("data.title")}</h2><p>{t("data.subtitle")}</p></div><button className="import-button" onClick={onImport} disabled={busy}>{busy ? t("data.importing") : t("data.import")}</button></section>
    <section className="panel sync-panel">
      <div className="panel-head"><div><h3>{t("data.syncTitle")}</h3><p>{t("data.syncHelp")}</p></div><span className={`sync-state ${syncBusy ? "working" : ""}`}>{syncBusy ? t("data.syncing") : syncStatus || t("status.notConfigured")}</span></div>
      <div className="sync-form">
        <label><span>{t("data.repository")}</span><input value={form.repository} onChange={(event) => setForm({ ...form, repository: event.target.value })} placeholder="owner/SE-monitor" /></label>
        <label><span>{t("data.token")}</span><input type="password" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} placeholder="github_pat_…" autoComplete="off" /></label>
        <label className="sync-interval"><span>{t("data.interval")}</span><select value={form.intervalMinutes} onChange={(event) => setForm({ ...form, intervalMinutes: Number(event.target.value) })}><option value={15}>{t("data.minutes", { count: 15 })}</option><option value={30}>{t("data.minutes", { count: 30 })}</option><option value={60}>{t("data.minutes", { count: 60 })}</option></select></label>
        <label className="toggle-label"><input type="checkbox" checked={form.autoSync} onChange={(event) => setForm({ ...form, autoSync: event.target.checked })} /><span>{t("data.automatic")}</span></label>
        <button className="secondary-button" onClick={() => onSaveSyncSettings(form)}>{t("data.save")}</button>
        <button className="primary-button" onClick={() => { onSaveSyncSettings(form); onSyncNow(form); }} disabled={syncBusy || !form.repository.trim()}>{syncBusy ? t("data.checking") : t("data.syncNow")}</button>
      </div>
      <div className="sync-note">{t("data.syncNote")}</div>
    </section>
    <section className="kpi-grid"><article className="kpi"><strong>{stats?.runs ?? "—"}</strong><span>{t("data.importedRuns")}</span></article><article className="kpi"><strong>{stats?.documents ?? "—"}</strong><span>{t("data.uniquePublications")}</span></article><article className="kpi"><strong>{stats?.sources ?? "—"}</strong><span>{t("data.sources")}</span></article><article className="kpi"><strong>{productionRuns}</strong><span>{t("data.productionRuns")}</span></article><article className="kpi"><strong>{latest?.runNumber ?? "—"}</strong><span>{t("data.latestRun")}</span></article></section>
    <section className="panel"><div className="panel-head"><div><h3>{t("data.runsTitle")}</h3><p>{t("data.runsHelp")}</p></div><span className="badge">{t("data.contract")}</span></div><div className="table-wrap"><table><thead><tr><th>{t("data.run")}</th><th>{t("data.mode")}</th><th>{t("data.start")}</th><th>{t("data.publications")}</th><th>{t("data.sourcesCol")}</th><th>{t("data.imported")}</th></tr></thead><tbody>{runs.length === 0 ? <tr><td colSpan={6} className="empty">{t("data.noBundles")}</td></tr> : runs.map((run) => <tr key={run.id}><td><b>#{run.runNumber ?? "—"}</b><small>{run.monitorKey === "social_economic" ? t("data.monitorSocial") : run.monitorName}</small></td><td><span className={`mode mode-${run.dryRun === true ? "dry" : run.dryRun === false ? "prod" : "unknown"}`}>{formatMode(run.dryRun)}</span></td><td>{formatDate(run.startedAt)}</td><td>{run.publications}</td><td>{run.sourcesInCoverage}</td><td>{formatDate(run.importedAt)}</td></tr>)}</tbody></table></div></section>
    <section className="panel db-path"><span>{t("data.sqliteShared")}</span><code title={stats?.databasePath}>{stats?.databasePath ?? t("status.initializing")}</code></section>
  </div>;
}
