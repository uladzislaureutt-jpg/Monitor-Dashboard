import { useCallback, useEffect, useRef, useState } from "react";
import { useMonitorAccess } from "../access";
import type { RunSummary } from "../types";
import { loadWorkroomConfig } from "../workroom";

type Run = {
  id: string;
  number: number;
  status: string;
  to_at: string;
  revision?: number;
  settings?: { country_scope?: string[] };
  counters: Record<string, number>;
  warnings: string[];
};

type Snapshot = {
  settings: { enabled: boolean; lookback_hours: number };
  runs: Run[];
  providers: { provider: string; info: Record<string, any>; updated_at?: string }[];
  country_names?: Record<string, string>;
  sources: { country: string; baseline: boolean; coverage: Record<string, unknown> }[];
  newscatcher_usage?: { days: number; credits: number; assistant: number; event: number; diagnostic: number; unconfirmed: number };
};

const active = (run: Run) => ["queued", "discovering", "processing"].includes(run.status);
const labels: Record<string, string> = {
  queued: "В очереди", discovering: "Поиск", processing: "Извлечение и перевод",
  completed: "Завершён", partial: "Завершён с замечаниями", failed: "Ошибка", cancelled: "Остановлен",
};

function warningText(code: string) {
  if (code === "gdelt_search_429") {
    return "GDELT не вернул выдачу: сервис ограничил частоту запросов (HTTP 429).";
  }
  return code;
}

export function LNewsAssistant({
  importedRuns,
  onSync,
  syncBusy,
}: {
  importedRuns: RunSummary[];
  onSync: () => void;
  syncBusy: boolean;
}) {
  const { session } = useMonitorAccess();
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draftHours, setDraftHours] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [countries, setCountries] = useState<string[]>([]);
  const token = session.accessToken;
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  const revisionRef = useRef("");

  const call = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const config = loadWorkroomConfig();
    const response = await fetch(`${config.url.replace(/\/+$/, "")}/functions/v1/l-news-collector`, {
      method: "POST",
      headers: { apikey: config.anonKey, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }, [token]);

  const refresh = useCallback(async () => {
    const snapshot: Snapshot = await call("status");
    setData(snapshot);
    setError("");
    const signature = snapshot.runs.map(run => `${run.id}:${run.revision ?? run.counters.ready ?? 0}`).join("|");
    if (revisionRef.current && signature !== revisionRef.current) onSyncRef.current();
    revisionRef.current = signature;
  }, [call]);

  useEffect(() => {
    let stopped = false;
    const poll = () => {
      void refresh().catch(reason => { if (!stopped) setError(String(reason)); });
    };
    poll();
    const timer = setInterval(poll, 20000);
    return () => { stopped = true; clearInterval(timer); };
  }, [refresh]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      const result = await call(action, extra);
      await refresh();
      if (action === "settings" && "lookback_hours" in extra) setDraftHours(null);
      setNotice(action === "quota" ? "Проверка остатка поставлена в очередь; поисковые запросы не расходуются."
        : action === "start" ? "Сбор поставлен в очередь."
        : action === "retry_failed" ? `Возвращено в очередь: ${result.retried}.`
        : "Настройки сохранены.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const perigon = data?.providers.find(provider => provider.provider === "perigon")?.info;
  const newscatcher = data?.providers.find(provider => provider.provider === "newscatcher");
  const newsBalance = newscatcher?.info.subscription?.credits_balance ?? newscatcher?.info.balance;
  const newsUsage = data?.newscatcher_usage;
  const limits = perigon?.limits || {};
  const latest = data?.runs[0];
  const eligibleCountries = [...new Set(data?.sources.map(source => source.country))]
    .map(code => ({ code, label: data?.country_names?.[code] ?? code }))
    .sort((left, right) => left.label.localeCompare(right.label, "ru"));
  const selectedCountries = eligibleCountries.filter(({ code }) => countries.includes(code)).map(({ code }) => code);
  const savedHours = data?.settings.lookback_hours ?? 26;
  const hours = draftHours ?? String(savedHours);
  const validHours = Number.isInteger(Number(hours)) && Number(hours) >= 1 && Number(hours) <= 168;
  const coverage = data?.sources.filter(source => Object.values(source.coverage || {}).some(value =>
    typeof value === "object" && value !== null && "status" in value && value.status === "indexed_article_seen",
  )).length ?? 0;
  const perigonTotal = data?.runs.reduce((sum, run) => sum + (run.counters.perigon_requests || 0), 0);
  const imported = new Map(importedRuns.filter(run => run.collector === "api_assistant")
    .map(run => [run.collectorRunId, run]));

  return <section className="panel l-news-assistant">
    <div className="panel-head">
      <div><h3>Помощник L-Monitor · пилот</h3><p>Ежедневно в 15:07 по Минску · окно {savedHours} часов · карточки на русском</p></div>
      {data && <span className="badge">{data.settings.enabled ? "Расписание включено" : "Расписание выключено"}</span>}
    </div>
    {error && <p role="alert" className="error-text">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="kpi-grid">
      <article className="kpi"><strong>{data?.sources.length ?? "—"}</strong><span>Каталог · {new Set(data?.sources.map(source => source.country)).size} стран</span></article>
      <article className="kpi"><strong>{coverage}</strong><span>Источники с фактической выдачей API</span></article>
      <article className="kpi"><strong>{limits.requestsUsed ?? "—"} / {limits.requestLimit ?? 150}</strong><span>Perigon: использовано за расчётный месяц</span></article>
      <article className="kpi"><strong>{newsBalance ?? "—"}</strong><span>Newscatcher: остаток по данным сервиса</span>
        {newscatcher?.updated_at && newsBalance != null && <small>Проверено {new Date(newscatcher.updated_at).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" })} по Минску</small>}
      </article>
    </div>
    <p>Perigon: одна страница — один запрос, до {limits.maxPageSize ?? 100} результатов. Лимит пилота — до 4 поисковых запросов в день, резерв — 10 в месяц. Сброс: {limits.resetAt ? new Date(limits.resetAt).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" }) : "—"}.</p>
    <p>Perigon за последние {data?.runs.length ?? 0} сборов — {perigonTotal ?? 0} запросов.</p>
    {newsUsage && <p>Newscatcher за последние {newsUsage.days} дней — <strong>{newsUsage.credits} кр.</strong> · Помощник {newsUsage.assistant} кр. · Событие {newsUsage.event} кр.
      {newsUsage.diagnostic > 0 && <> · Диагностика {newsUsage.diagnostic} кр.</>}
      {newsUsage.unconfirmed > 0 && <> · Списание уточняется для {newsUsage.unconfirmed} зап.</>}</p>}
    <div className="sync-form">
      <label>Глубина, часов <input type="number" min={1} max={168} value={hours} onChange={event => setDraftHours(event.target.value)} /></label>
      <button className="secondary-button" disabled={busy || !data || !validHours || Number(hours) === savedHours}
        onClick={() => void act("settings", { lookback_hours: Number(hours) })}>Сохранить глубину</button>
      <button className="secondary-button" disabled={busy || !data}
        onClick={() => void act("settings", { enabled: !data?.settings.enabled })}>{data?.settings.enabled ? "Приостановить расписание" : "Включить расписание"}</button>
      <button className="primary-button" disabled={busy || !data || Boolean(latest && active(latest))}
        onClick={() => void act("start", selectedCountries.length ? { countries: selectedCountries } : {})}>Собрать сейчас</button>
      <button className="secondary-button" disabled={busy} onClick={() => void act("quota")}>Проверить остатки</button>
      <button className="secondary-button" disabled={busy} onClick={() => void act("retry_failed")}>Повторить ошибки обработки</button>
      <button className="secondary-button" disabled={syncBusy} onClick={onSync}>Получить карточки</button>
    </div>
    <details className="sync-note">
      <summary>Страны для ручного сбора · {selectedCountries.length ? selectedCountries.map(code => data?.country_names?.[code] ?? code).join(", ") : "все страны"}</summary>
      {selectedCountries.length > 0 && <button type="button" className="secondary-button small-button" onClick={() => setCountries([])}>Все страны</button>}
      <div className="l-news-country-picker">
        {eligibleCountries.map(({ code, label }) => <label key={code}>
          <input type="checkbox" checked={countries.includes(code)} onChange={event => {
            const checked = event.target.checked;
            setCountries(previous => checked ? [...previous, code] : previous.filter(country => country !== code));
          }} /> {label}
        </label>)}
      </div>
    </details>
    <p className="sync-note">Глубина от 1 до 168 часов действует для следующих ручных и плановых сборов. Ручной сбор использует общие лимиты API.</p>
    <div className="table-wrap"><table>
      <thead><tr><th>Сбор</th><th>Состояние</th><th>Карточки в приложении / полные тексты</th><th>Источники по странам</th><th>Повторы</th><th>Расход</th></tr></thead>
      <tbody>{data?.runs.slice(0, 10).map(run => {
        const localRun = imported.get(run.id);
        const countries = localRun?.collectorCountries ?? [];
        const countryLabels = countries.map(item => `${item.country} — ${item.sources}`);
        return <tr key={run.id}>
          <td>Помощник #{run.number}<small>{new Date(run.to_at).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" })}</small>{run.settings?.country_scope && <small>{run.settings.country_scope.map(code => data?.country_names?.[code] ?? code).join(", ")}</small>}</td>
          <td>{labels[run.status] || run.status}
            {active(run) && <small>В очереди: {run.counters.jobs_pending || 0}</small>}
            {!!run.warnings?.length && <details><summary>Показать замечания ({run.warnings.length})</summary>
              <ul>{run.warnings.map(warning => <li key={warning}>{warningText(warning)}</li>)}</ul>
            </details>}
          </td>
          <td>{localRun ? `${localRun.publications} / ${localRun.fullTextPublications}` : "—"}</td>
          <td>
            {countryLabels.slice(0, 6).join(" · ") || (!localRun && run.counters.ready > 0 ? "Пакет ещё не получен" : "—")}
            {countryLabels.length > 6 && <details><summary>Другие страны ({countryLabels.length - 6})</summary>
              {countryLabels.slice(6).join(" · ")}
            </details>}
          </td>
          <td>{(run.counters.already_known ?? 0) + (localRun?.crossCollectorDuplicates ?? 0)}</td>
          <td>Perigon {run.counters.perigon_requests || 0}<small>Newscatcher {run.counters.newscatcher_credits || 0} кр.</small></td>
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}
