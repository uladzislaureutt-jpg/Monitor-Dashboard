import { useEffect, useState } from "react";
import type { AdminSnapshot, DatabaseStats, RunSummary, SyncSettings } from "../types";
import { useI18n } from "../i18n";
import { useMonitorAccess } from "../access";
import { adminAccessAction, getAdminSnapshot, loadWorkroomConfig } from "../workroom";

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
  const { t, formatLocale, locale } = useI18n();
  const access = useMonitorAccess();
  const [adminSnapshot, setAdminSnapshot] = useState<AdminSnapshot | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");
  const be = locale === "be";
  const atx = {
    title: be ? "Карыстальнікі і доступ" : "Пользователи и доступ",
    pending: be ? "Запыты на доступ" : "Запросы на доступ",
    approve: be ? "Дазволіць" : "Разрешить",
    reject: be ? "Адхіліць" : "Отклонить",
    users: be ? "Карыстальнікі" : "Пользователи",
    access: be ? "Доступ" : "Доступ",
    admin: be ? "Адміністратар" : "Администратор",
    active: be ? "актыўны" : "активен",
    suspended: be ? "прыпынены" : "приостановлен",
    lastLogin: be ? "Апошні ўваход" : "Последний вход",
    monitors: be ? "Даступнасць маніторынгаў" : "Доступность мониторингов",
    works: be ? "Працуе" : "Работает",
    maintenance: be ? "Тэхнічныя работы" : "Технические работы",
    noRequests: be ? "Няма запытаў, якія чакаюць рашэння." : "Нет запросов, ожидающих решения.",
    refresh: be ? "Абнавіць" : "Обновить",
    delete: be ? "Выдаліць" : "Удалить",
    deleteRequestConfirm: be ? "Выдаліць гэты запыт на доступ?" : "Удалить этот запрос на доступ?",
    deleteUserConfirm: be ? "Цалкам выдаліць карыстальніка і яго ўліковы запіс? Гэта дзеянне нельга адмяніць." : "Полностью удалить пользователя и его учётную запись? Это действие нельзя отменить.",
  };
  const latest = runs[0] ?? null;
  const productionRuns = runs.filter((run) => run.dryRun === false).length;
  const [form, setForm] = useState(syncSettings);
  useEffect(() => setForm(syncSettings), [syncSettings]);
  useEffect(() => {
    if (!access.profile.isAdmin) return;
    let cancelled = false;
    getAdminSnapshot(loadWorkroomConfig(), access.session).then(({ snapshot }) => {
      if (!cancelled) setAdminSnapshot(snapshot);
    }).catch((reason) => { if (!cancelled) setAdminError(String(reason)); });
    return () => { cancelled = true; };
  }, [access.profile.isAdmin, access.session.userId]);
  const formatDate = (value: string | null) => { if (!value) return "—"; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(formatLocale); };
  const formatMode = (value: boolean | null) => value === true ? t("data.modeDry") : value === false ? t("data.modeProduction") : t("data.modeUnknown");
  async function refreshAdmin() {
    if (!access.profile.isAdmin) return;
    setAdminBusy(true); setAdminError("");
    try {
      const { snapshot } = await getAdminSnapshot(loadWorkroomConfig(), access.session);
      setAdminSnapshot(snapshot);
      await access.refreshAccess();
    } catch (reason) { setAdminError(String(reason)); }
    finally { setAdminBusy(false); }
  }
  async function adminAction(body: Record<string, unknown>) {
    setAdminBusy(true); setAdminError("");
    try {
      await adminAccessAction(loadWorkroomConfig(), access.session, body);
      await refreshAdmin();
    } catch (reason) { setAdminError(String(reason)); setAdminBusy(false); }
  }
  return <div className="view-stack">
    {access.profile.isAdmin && <section className="panel admin-access-panel">
      <div className="panel-head"><div><h3>{atx.title}</h3><p>{be ? "Одобрение новых операторов, роли и режим технических работ." : "Одобрение новых операторов, роли и режим технических работ."}</p></div><button className="secondary-button" disabled={adminBusy} onClick={refreshAdmin}>{adminBusy ? "…" : atx.refresh}</button></div>
      {adminError && <div className="notice error">{adminError}</div>}
      <div className="admin-access-grid">
        <div className="admin-access-block"><h4>{atx.pending}</h4>{(adminSnapshot?.requests.filter((item) => item.status === "pending").length ?? 0) === 0 ? <p className="muted">{atx.noRequests}</p> : adminSnapshot?.requests.filter((item) => item.status === "pending").map((item) => <div className="admin-request-row" key={item.id}><div><b>{item.displayName}</b><span>{item.email} · {item.locale.toUpperCase()}</span></div><div><button className="primary-button small-button" disabled={adminBusy} onClick={() => adminAction({ action: "review_request", request_id: item.id, decision: "approved" })}>{atx.approve}</button><button className="ghost-button small-button" disabled={adminBusy} onClick={() => adminAction({ action: "review_request", request_id: item.id, decision: "rejected" })}>{atx.reject}</button><button className="text-danger small-button" disabled={adminBusy} onClick={() => { if (window.confirm(atx.deleteRequestConfirm)) void adminAction({ action: "delete_request", request_id: item.id }); }}>{atx.delete}</button></div></div>)}</div>
        <div className="admin-access-block"><h4>{atx.monitors}</h4>{adminSnapshot?.monitors.map((item) => <div className="admin-monitor-row" key={item.monitorKey}><div><b>{item.monitorKey === "social_economic" ? "SEP-Monitor" : item.monitorKey === "lukashenko" ? "L-Monitor" : item.monitorKey === "w_review" ? "W-Review" : item.monitorKey}</b><span>{item.enabled ? atx.works : atx.maintenance}</span></div><label className="toggle-label"><input type="checkbox" checked={item.enabled} disabled={adminBusy} onChange={(e) => adminAction({ action: "set_monitor", monitor_key: item.monitorKey, enabled: e.target.checked, maintenance_message_ru: item.maintenanceMessageRu, maintenance_message_be: item.maintenanceMessageBe })} /><span>{item.enabled ? atx.works : atx.maintenance}</span></label></div>)}</div>
      </div>
      <div className="admin-user-list"><h4>{atx.users}</h4>{adminSnapshot?.users.map((item) => <div className="admin-user-row" key={item.id}><div className="admin-user-main"><b>{item.displayName}</b><span>{item.email} · {item.status === "active" ? atx.active : atx.suspended}{item.lastSignInAt ? ` · ${atx.lastLogin}: ${formatDate(item.lastSignInAt)}` : ""}</span></div><label><input type="checkbox" checked={item.status === "active"} disabled={adminBusy || item.id === access.profile.id} onChange={(e) => adminAction({ action: "set_user_access", user_id: item.id, enabled: e.target.checked })} />{atx.access}</label><label><input type="checkbox" checked={item.isAdmin} disabled={adminBusy || item.id === access.profile.id} onChange={(e) => adminAction({ action: "set_admin", user_id: item.id, is_admin: e.target.checked })} />{atx.admin}</label><button className="text-danger small-button" disabled={adminBusy || item.id === access.profile.id} onClick={() => { if (window.confirm(atx.deleteUserConfirm)) void adminAction({ action: "delete_user", user_id: item.id }); }}>{atx.delete}</button></div>)}</div>
    </section>}
    <section className="hero data-hero"><div><div className="eyebrow">{t("data.eyebrow")}</div><h2>{t("data.title")}</h2><p>{t("data.subtitle")}</p></div><button className="import-button" onClick={onImport} disabled={busy}>{busy ? t("data.importing") : t("data.import")}</button></section>
    <section className="panel sync-panel">
      <div className="panel-head"><div><h3>{t("data.syncTitle")}</h3><p>{t("data.syncHelp")}</p></div><span className={`sync-state ${syncBusy ? "working" : ""}`}>{syncBusy ? t("data.syncing") : syncStatus || t("status.notConfigured")}</span></div>
      <div className="sync-form">
        <div className="sync-server-managed"><b>{be ? "Серверная сінхранізацыя" : "Серверная синхронизация"}</b><span>{be ? "GitHub-токен захоўваецца ў Supabase і не перадаецца на гэты камп’ютар." : "GitHub-токен хранится в Supabase и не передаётся на этот компьютер."}</span></div>
        <label className="sync-interval"><span>{t("data.interval")}</span><select value={form.intervalMinutes} onChange={(event) => setForm({ ...form, intervalMinutes: Number(event.target.value) })}><option value={15}>{t("data.minutes", { count: 15 })}</option><option value={30}>{t("data.minutes", { count: 30 })}</option><option value={60}>{t("data.minutes", { count: 60 })}</option></select></label>
        <label className="toggle-label"><input type="checkbox" checked={form.autoSync} onChange={(event) => setForm({ ...form, autoSync: event.target.checked })} /><span>{t("data.automatic")}</span></label>
        <button className="secondary-button" onClick={() => onSaveSyncSettings(form)}>{t("data.save")}</button>
        <button className="primary-button" onClick={() => { onSaveSyncSettings(form); onSyncNow(form); }} disabled={syncBusy}>{syncBusy ? t("data.checking") : t("data.syncNow")}</button>
      </div>
      <div className="sync-note">{t("data.syncNote")}</div>
    </section>
    <section className="kpi-grid"><article className="kpi"><strong>{stats?.runs ?? "—"}</strong><span>{t("data.importedRuns")}</span></article><article className="kpi"><strong>{stats?.documents ?? "—"}</strong><span>{t("data.uniquePublications")}</span></article><article className="kpi"><strong>{stats?.sources ?? "—"}</strong><span>{t("data.sources")}</span></article><article className="kpi"><strong>{productionRuns}</strong><span>{t("data.productionRuns")}</span></article><article className="kpi"><strong>{latest?.runNumber ?? "—"}</strong><span>{t("data.latestRun")}</span></article></section>
    <section className="panel"><div className="panel-head"><div><h3>{t("data.runsTitle")}</h3><p>{t("data.runsHelp")}</p></div><span className="badge">{t("data.contract")}</span></div><div className="table-wrap"><table><thead><tr><th>{t("data.run")}</th><th>{t("data.mode")}</th><th>{t("data.start")}</th><th>{t("data.publications")}</th><th>{t("data.sourcesCol")}</th><th>{t("data.imported")}</th></tr></thead><tbody>{runs.length === 0 ? <tr><td colSpan={6} className="empty">{t("data.noBundles")}</td></tr> : runs.map((run) => <tr key={run.id}><td><b>#{run.runNumber ?? "—"}</b><small>{run.monitorKey === "social_economic" ? t("data.monitorSocial") : run.monitorName}</small></td><td><span className={`mode mode-${run.dryRun === true ? "dry" : run.dryRun === false ? "prod" : "unknown"}`}>{formatMode(run.dryRun)}</span></td><td>{formatDate(run.startedAt)}</td><td>{run.publications}</td><td>{run.sourcesInCoverage}</td><td>{formatDate(run.importedAt)}</td></tr>)}</tbody></table></div></section>
    <section className="panel db-path"><span>{t("data.sqliteShared")}</span><code title={stats?.databasePath}>{stats?.databasePath ?? t("status.initializing")}</code></section>
  </div>;
}
