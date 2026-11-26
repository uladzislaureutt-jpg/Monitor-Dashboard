import { useCallback, useEffect, useState } from "react";
import { useMonitorAccess } from "../access";
import type { RunSummary } from "../types";
import { loadWorkroomConfig } from "../workroom";

type Run = {
  id: string;
  number: number;
  assistant_number?: number;
  status: string;
  to_at: string;
  revision?: number;
  settings?: { country_scope?: string[] };
  counters: Record<string, number>;
  warnings: string[];
};

type Snapshot = {
  settings: { enabled: boolean; lookback_hours: number; countries?: string[]; local_time?: string; [key: string]: any };
  runs: Run[];
  providers: { provider: string; info: Record<string, any>; updated_at?: string }[];
  country_names?: Record<string, string>;
  cloro_search?: {countries:string[];priority_countries:string[];default_countries:string[]};
  sources: { country: string; baseline: boolean; coverage: Record<string, unknown> }[];
  terminal_run_id?: string;
  terminal?: { id: number; label: string; state: string; at: string; error?: string; returned?: number; kept?: number; new_to_index?: number; ready?: boolean; capped?: boolean }[];
  usage_limits?: Record<string, { today_units: number; period_units: number }>;
  diagnostic_usage?: { days: number; cloro_credits: number; currents_requests: number; thenews_requests: number };
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

type Props = { importedRuns: RunSummary[]; onSync: () => void; syncBusy: boolean };

export function LNewsAssistant(props: Props) {
  const [selected, setSelected] = useState(1);
  return <><div className="assistant-tabs" role="tablist" aria-label="Помощники L-Monitor">{[1, 2].map(id => <button key={id} role="tab" aria-selected={selected === id} className={selected === id ? "primary-button" : "secondary-button"} onClick={() => setSelected(id)}>Помощник {id}</button>)}</div><AssistantPanel key={selected} {...props} assistantId={selected} /></>;
}

function AssistantPanel({
  assistantId,
  importedRuns,
  onSync,
  syncBusy,
}: {
  assistantId: number;
  importedRuns: RunSummary[];
  onSync: () => void;
  syncBusy: boolean;
}) {
  const { session, profile } = useMonitorAccess();
  const admin = profile.isAdmin;
  const second = assistantId === 2;
  const [terminalId, setTerminalId] = useState<string | undefined>();
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draftHours, setDraftHours] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [countries, setCountries] = useState<string[]>([]);
  const token = session.accessToken;
  // Automatic assistant synchronization is handled by the application-wide
  // five-minute scheduler, not by each 20-second status refresh.

  const call = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const config = loadWorkroomConfig();
    const response = await fetch(`${config.url.replace(/\/+$/, "")}/functions/v1/l-news-collector`, {
      method: "POST",
      headers: { apikey: config.anonKey, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action, assistant_id: assistantId, ...extra }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }, [token, assistantId]);

  const refresh = useCallback(async () => {
    const snapshot: Snapshot = await call("status", { terminal_run_id: terminalId });
    setData(snapshot);
    setError("");
    // Status polling only updates the table. Do not trigger expensive GitHub +
    // assistant imports every time a live run increments its revision.
    // The manual "Получить карточки" action remains available.
  }, [call, terminalId]);

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
        : action === "cancel" ? "Сбор остановлен; уже начатая обработка может завершиться."
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
  const cloro = data?.providers.find(provider => provider.provider === "cloro");
  const currents = data?.providers.find(provider => provider.provider === "currents");
  const thenews = data?.providers.find(provider => provider.provider === "thenews");
  const latest = data?.runs[0];
  const catalogCountries = [...new Set(data?.sources.map(source => source.country))]
    .map(code => ({ code, label: data?.country_names?.[code] ?? code }))
    .sort((left, right) => left.label.localeCompare(right.label, "ru"));
  const eligibleCountries = catalogCountries.filter(({ code }) => !data?.settings.countries || data.settings.countries.includes(code));
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
      <div><h3>Помощник {assistantId} · L-Monitor</h3><p>{second ? "Newscatcher + Cloro · Currents + The News API" : "Newscatcher + Perigon"} · ежедневно в {data?.settings.local_time ?? "15:07"} по Минску · окно {savedHours} часов</p></div>
      {data && <span className="badge">{data.settings.enabled ? "Расписание включено" : "Расписание выключено"}</span>}
    </div>
    {error && <p role="alert" className="error-text">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="kpi-grid">
      <article className="kpi"><strong>{data?.sources.length ?? "—"}</strong><span>Каталог · {new Set(data?.sources.map(source => source.country)).size} стран</span></article>
      <article className="kpi"><strong>{coverage}</strong><span>Источники с фактической выдачей API</span></article>
      {!second && <article className="kpi"><strong>{limits.requestsUsed ?? "—"} / {limits.requestLimit ?? 150}</strong><span>Perigon: использовано за расчётный месяц</span></article>}
      <article className="kpi"><strong>{newsBalance ?? "—"}</strong><span>Newscatcher: общий остаток аккаунта</span>
        {newscatcher?.updated_at && newsBalance != null && <small>Проверено {new Date(newscatcher.updated_at).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" })} по Минску</small>}
      </article>
      {second && <><article className="kpi"><strong>{cloro?.info.balance?.remaining ?? "—"}</strong><span>Cloro: остаток кредитов</span><small>{cloro?.updated_at ? `Проверено ${new Date(cloro.updated_at).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" })}` : "Остаток ещё не проверен"}</small></article>
      <article className="kpi"><strong>{currents?.info.limits?.remaining ?? "—"} / {currents?.info.limits?.limit ?? 250}</strong><span>Currents: остаток суточной квоты</span><small>{currents?.updated_at ? new Date(currents.updated_at).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" }) : "Будет известен после первого запроса"}</small></article>
      <article className="kpi"><strong>{thenews?.info.limits?.remaining ?? "—"} / {thenews?.info.limits?.limit ?? 100}</strong><span>The News API: остаток суточной квоты</span><small>{thenews?.updated_at ? new Date(thenews.updated_at).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" }) : "Будет известен после первого запроса"}</small></article></>}
    </div>
    {!second && <><p>Perigon: одна страница — один запрос, до {limits.maxPageSize ?? 100} результатов. Лимит — до {data?.settings.perigon_per_run ?? 8} запросов на сбор и 16 в сутки по Минску, резерв — 10 в месяц. Сброс: {limits.resetAt ? new Date(limits.resetAt).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" }) : "—"}.</p>
    <p>Perigon за последние {data?.runs.length ?? 0} сборов — {perigonTotal ?? 0} запросов.</p></>}
    {newsUsage && <p>Newscatcher за последние {newsUsage.days} дней — <strong>{newsUsage.credits} кр.</strong> · Оба помощника {newsUsage.assistant} кр. · Событие {newsUsage.event} кр.
      {newsUsage.diagnostic > 0 && <> · Диагностика {newsUsage.diagnostic} кр.</>}
      {newsUsage.unconfirmed > 0 && <> · Списание уточняется для {newsUsage.unconfirmed} зап.</>}</p>}
    {second && data?.diagnostic_usage && <p>Сравнительные проверки за {data.diagnostic_usage.days} дней: Cloro — <strong>{data.diagnostic_usage.cloro_credits} кр.</strong>, Currents — <strong>{data.diagnostic_usage.currents_requests} зап.</strong>, The News API — <strong>{data.diagnostic_usage.thenews_requests} зап.</strong> Проверочный сбор готового помощника учтён в его запусках.</p>}
    {second && <p className="sync-note">Currents: 250 запросов в сутки, сброс в 03:00 по Минску. Cloro Free: 500 кредитов на календарный месяц; точную дату пополнения аккаунта сервис пока не передал. The News API: на текущем ключе до 100 запросов в сутки, по 3 статьи за запрос; остаток обновляется по заголовкам поискового ответа.</p>}
    {second && data && <Assistant2Settings key={data.settings.updated_at} settings={data.settings} usage={data.usage_limits} cloroSearch={data.cloro_search} countries={catalogCountries} disabled={busy || !admin} onSave={patch => void act("settings", patch)} />}
    <div className="sync-form">
      <label>Глубина, часов <input type="number" min={1} max={168} value={hours} onChange={event => setDraftHours(event.target.value)} /></label>
      <button className="secondary-button" disabled={!admin || busy || !data || !validHours || Number(hours) === savedHours}
        onClick={() => void act("settings", { lookback_hours: Number(hours) })}>Сохранить глубину</button>
      <button className="secondary-button" disabled={!admin || busy || !data}
        onClick={() => void act("settings", { enabled: !data?.settings.enabled })}>{data?.settings.enabled ? "Приостановить расписание" : "Включить расписание"}</button>
      <button className="primary-button" disabled={!admin || busy || !data || Boolean(latest && active(latest))}
        onClick={() => void act("start", selectedCountries.length ? { countries: selectedCountries } : {})}>Собрать сейчас</button>
      <button className="secondary-button" disabled={!admin || busy} onClick={() => void act("quota")}>Проверить остатки</button>
      <button className="secondary-button" disabled={!admin || busy} onClick={() => void act("retry_failed")}>Повторить ошибки обработки</button>
      {latest && active(latest) && <button className="secondary-button" disabled={!admin || busy} onClick={() => void act("cancel", { run_id: latest.id })}>Остановить сбор</button>}
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
      <tbody>{data?.runs.slice(0, 5).map(run => {
        const localRun = imported.get(run.id);
        const countries = localRun?.collectorCountries ?? [];
        const countryLabels = countries.map(item => `${item.country} — ${item.sources}`);
        return <tr key={run.id}>
          <td><button className="assistant-run-link" onClick={() => setTerminalId(run.id)}>Помощник {assistantId} #{run.assistant_number ?? run.number}</button><small>{new Date(run.to_at).toLocaleString("ru-RU", { timeZone: "Europe/Minsk" })}</small>{run.settings?.country_scope && <small>{run.settings.country_scope.map(code => data?.country_names?.[code] ?? code).join(", ")}</small>}</td>
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
          <td>{second ? <>Cloro {run.counters.cloro_credits || 0} кр.<small>Currents {run.counters.currents_requests || 0} зап.</small><small>The News API {run.counters.thenews_requests || 0} зап.</small></> : <>Perigon {run.counters.perigon_requests || 0}</>}<small>Newscatcher {run.counters.newscatcher_credits || 0} кр.</small></td>
        </tr>;
      })}{data?.runs.length === 0 && <tr><td colSpan={6}>Запусков пока нет. Можно начать ручной сбор.</td></tr>}</tbody>
    </table></div>
    <details className="assistant-terminal" open><summary>Терминал · Помощник {assistantId}{data?.runs.find(run => run.id === data.terminal_run_id) ? ` #${data.runs.find(run => run.id === data.terminal_run_id)?.assistant_number ?? data.runs.find(run => run.id === data.terminal_run_id)?.number}` : ""}</summary>
      <pre role="log" aria-label={`Терминал помощника ${assistantId}`}>{data?.terminal?.length ? [...data.terminal].reverse().map(event => `${new Date(event.at).toLocaleTimeString("ru-RU", { timeZone: "Europe/Minsk" })}  ${event.label} · ${{waiting:"в очереди", leased:"выполняется", done:"готово", failed:"ошибка"}[event.state] ?? event.state}${event.returned != null ? ` · найдено ${event.returned}` : ""}${event.new_to_index != null ? ` · новых ссылок ${event.new_to_index}` : ""}${event.kept != null ? ` · на обработку ${event.kept}` : ""}${event.ready ? " · карточка готова" : ""}${event.capped ? " · достигнут лимит" : ""}${event.error ? ` · ${event.error}` : ""}`).join("\n") : "Ожидание запуска."}</pre>
    </details>
    <p className="sync-note">Показаны последние 5 запусков этого помощника. Архив и ранее полученные карточки сохранены.</p>
  </section>;
}

function Assistant2Settings({ settings, usage, cloroSearch, countries, disabled, onSave }: {
  settings: Snapshot["settings"]; usage?: Snapshot["usage_limits"]; cloroSearch?: Snapshot["cloro_search"];
  countries: { code: string; label: string }[]; disabled: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState({ ...settings });
  const [dirty, setDirty] = useState(false);
  const change = (key: string, value: unknown) => { setDirty(true); setDraft(previous => ({ ...previous, [key]: value })); };
  const numeric = (key: string, label: string, max: number) => <label key={key}>{label}<input type="number" min={0} max={max} disabled={disabled} value={draft[key] ?? 0} onChange={event => change(key, event.target.value === "" ? "" : Number(event.target.value))} /></label>;
  const pick = (key: string, options: { code: string; label: string }[]) => <div className="l-news-country-picker">{options.map(option => <label key={option.code}><input type="checkbox" disabled={disabled} checked={(draft[key] ?? []).includes(option.code)} onChange={event => change(key, event.target.checked ? [...(draft[key] ?? []), option.code] : (draft[key] ?? []).filter((code: string) => code !== option.code))} /> {option.label}</label>)}</div>;
  const cloroCountries = countries.filter(country => cloroSearch?.countries.includes(country.code));
  const priority = (cloroSearch?.priority_countries ?? []).map(code => countries.find(country => country.code === code)?.label ?? code);
  const rotations = (draft.cloro_countries ?? []).filter((code:string) => cloroSearch?.countries.includes(code) && !cloroSearch.priority_countries.includes(code) && (draft.countries ?? []).includes(code));
  const valid = Object.entries(draft).every(([key, value]) => typeof settings[key] !== "number" || (typeof value === "number" && Number.isInteger(value) && value >= 0)) && /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.local_time ?? "") && (draft.countries?.length ?? 0) > 0;
  return <details className="assistant-settings"><summary>Настройки поиска и расходов помощника 2</summary>
    <div className="sync-form"><label>Время по Минску<input type="time" disabled={disabled} value={draft.local_time} onChange={event => change("local_time", event.target.value)} /></label>
      {numeric("candidate_limit", "Кандидатов на сбор", 3000)}{numeric("paid_extractions_per_run", "Платных извлечений на сбор", 10)}</div>
    {([ ["newscatcher", "Newscatcher", "кредитов", 100, 2000, 20000, 10000], ["cloro", "Cloro", "кредитов", 20, 300, 10000, 500], ["currents", "Currents", "запросов", 150, 250, 7500, 100], ["thenews", "The News API", "запросов", 100, 100, 3000, 100] ] as const).map(([provider, label, unit, runMax, dayMax, monthMax, reserveMax]) => {
      const dailyKey = `${provider}_daily_${["currents", "thenews"].includes(provider) ? "requests" : "credits"}`;
      const monthlyKey = `${provider}_monthly_${["currents", "thenews"].includes(provider) ? "requests" : "credits"}`;
      return <fieldset key={provider}><legend><label><input type="checkbox" disabled={disabled} checked={Boolean(draft[`${provider}_enabled`])} onChange={event => change(`${provider}_enabled`, event.target.checked)} /> {label}</label></legend>
        <p className="sync-note">Расход помощника 2: сегодня {usage?.[provider]?.today_units ?? 0} / {settings[dailyKey]} {unit}; за 30 дней {usage?.[provider]?.period_units ?? 0} / {settings[monthlyKey]} {unit}.</p>
        <div className="assistant-budget-grid">{numeric(`${provider}_per_run`, "Запросов на сбор", runMax)}{numeric(dailyKey, `${unit} в сутки`, dayMax)}{numeric(monthlyKey, `${unit} за 30 дней`, monthMax)}{numeric(`${provider}_reserve`, "Неприкосновенный остаток", reserveMax)}{["currents", "thenews"].includes(provider) && <label>Страниц на направление<input type="number" min={1} max={10} disabled={disabled} value={draft[`${provider}_pages_per_query`] ?? (provider === "currents" ? 5 : 3)} onChange={event => change(`${provider}_pages_per_query`, Number(event.target.value))} /></label>}</div>
      </fieldset>;
    })}
    <p className="sync-note">Newscatcher — 5 кредитов за страницу, Cloro — 3 за поиск; ожидание результата Cloro повторно не оплачивается. Дневные лимиты считаются по Минску, период — скользящие 30 дней. Нулевой лимит отключает расход. Остаток Newscatcher общий с помощником 1 и другими инструментами.</p>
    <details><summary>Страны для планового поиска ({draft.countries?.length ?? 0})</summary>{pick("countries", countries)}</details>
    <details className="cloro-country-settings"><summary>Cloro: страны дополнительного поиска ({cloroCountries.length})</summary>
      <p className="sync-note">Постоянные направления — {priority.join(", ") || "загрузка настроек"}. Они выполняются, если отмечены ниже и входят в страны сбора. Остальные выбранные страны чередуются в пределах лимита запросов.</p>
      <p className="sync-note">Показаны страны с явно настроенным языком и местными написаниями фамилии. Добавление флажка включает страну в очередь; общий лимит расходов сохраняется.</p>
      {Number(draft.cloro_per_run) === 4 && cloroSearch?.priority_countries.every(code => (draft.cloro_countries ?? []).includes(code) && (draft.countries ?? []).includes(code)) && <p className="sync-note">Три постоянных направления и одно по очереди из {rotations.length} стран в каждом полном сборе.</p>}
      {cloroCountries.length ? pick("cloro_countries", cloroCountries) : <p className="sync-note">Список настроенных стран Cloro ещё не загружен.</p>}
    </details>
    <details><summary>Currents: выбранные языки</summary><p className="sync-note">Поиск запускается только на выбранных языках, если в сборе есть соответствующие страны. По умолчанию — 31 язык каталога. Если выдача пуста, проверяется другое написание фамилии; для китайского проверяются также традиционные иероглифы. Английский поиск охватывает также международные издания. Вторая полная страница проверяется всегда, более глубокие — пока появляются новые кандидаты. Общий предел определяется лимитами выше.</p>{pick("currents_languages", [{code:"en",label:"Английский"},{code:"ru",label:"Русский"},{code:"uk",label:"Украинский"},{code:"pl",label:"Польский"},{code:"de",label:"Немецкий"},{code:"fr",label:"Французский"},{code:"it",label:"Итальянский"},{code:"es",label:"Испанский"},{code:"pt",label:"Португальский"},{code:"tr",label:"Турецкий"},{code:"zh",label:"Китайский"},{code:"ja",label:"Японский"},{code:"ko",label:"Корейский"},{code:"ar",label:"Арабский"},{code:"he",label:"Иврит"},{code:"cs",label:"Чешский"},{code:"ro",label:"Румынский"},{code:"nl",label:"Нидерландский"},{code:"sv",label:"Шведский"},{code:"fi",label:"Финский"},{code:"hu",label:"Венгерский"},{code:"sr",label:"Сербский"},{code:"lt",label:"Литовский"},{code:"da",label:"Датский"},{code:"no",label:"Норвежский"},{code:"el",label:"Греческий"},{code:"hi",label:"Хинди"},{code:"ur",label:"Урду"},{code:"vi",label:"Вьетнамский"},{code:"ca",label:"Каталанский"},{code:"hr",label:"Хорватский"},{code:"id",label:"Индонезийский"},{code:"ms",label:"Малайский"},{code:"th",label:"Тайский"}])}</details>
    <p className="sync-note">The News API ищет отдельно в группах до 40 доменов каталога. При полной выдаче проверяет следующую страницу; после второй продолжает только направления с новыми находками. Если бюджет меньше числа групп, группы чередуются между запусками.</p>
    <button className="secondary-button" disabled={disabled || !dirty || !valid} onClick={() => { const { lookback_hours, enabled, ...patch } = draft; onSave(patch); }}>Сохранить настройки помощника 2</button>
  </details>;
}
