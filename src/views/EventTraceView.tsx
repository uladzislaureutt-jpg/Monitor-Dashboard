import { useEffect, useRef, useState, type FormEvent } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { eventDate, eventRun, type EventEntry, type EventRun } from "../eventTrace";
import { useI18n } from "../i18n";

const LIMIT = 500;

export function EventTraceView() {
  const { locale } = useI18n();
  const be = locale === "be";
  const [task, setTask] = useState("");
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [run, setRun] = useState<EventRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submitGuard = useRef(false);
  const retryId = useRef<{ fingerprint: string; id: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void eventRun({ action: "latest" }, controller.signal).then((value) => {
      if (!value || controller.signal.aborted) return;
      setRun(value);
      setTask(value.task);
      setFrom(value.options.from || "");
      setThrough(value.options.through || "");
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(String(reason.message || "read_failed"));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const runId = run?.id;
  const running = run?.status === "running";
  useEffect(() => {
    if (!runId || !running) return;
    const controller = new AbortController();
    let timer = 0;
    async function update() {
      try {
        const value = await eventRun({ action: "status", id: runId! }, controller.signal);
        if (controller.signal.aborted) return;
        if (value) setRun(value);
        setError("");
        if (value?.status !== "running") return;
      } catch (reason) {
        if (controller.signal.aborted) return;
        const code = reason instanceof Error ? reason.message : "read_failed";
        setError(code);
        if (code === "unauthorized" || code === "access_denied") return;
      }
      if (!controller.signal.aborted) timer = window.setTimeout(update, 3000);
    }
    timer = window.setTimeout(update, 2600);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [runId, running]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitGuard.current || !task.trim() || loading || running || (from && through && from > through)) return;
    submitGuard.current = true;
    setSubmitting(true);
    setError("");
    const fingerprint = JSON.stringify([task.trim(), from, through, locale]);
    if (retryId.current?.fingerprint !== fingerprint) retryId.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const next = await eventRun({ action: "start", id: retryId.current.id, task, from, through, locale });
      if (!next) throw new Error("start_failed");
      setRun(next);
      retryId.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "start_failed"); }
    finally { setSubmitting(false); submitGuard.current = false; }
  }

  const result = run?.result;
  const entries = result?.entries || [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const earliest = result?.earliestId ? byId.get(result.earliestId) : undefined;
  const cited = new Set(result?.citedSourceIds);
  const sameDayUncertain = Boolean(earliest && entries.some((entry) => entry.id !== earliest.id &&
    !entry.outsideWindow && entry.published && eventDate(entry.published, locale).split(",")[0].trim() ===
    eventDate(earliest.published, locale).split(",")[0].trim() &&
    (entry.published.length === 10 || earliest.published?.length === 10)));
  const title = be ? "Падзея" : "Событие";
  const timelineTitle = be ? "Храналогія публікацый" : "Хронология публикаций";
  const earliestTitle = be ? "Самая ранняя з датаваных публікацый" : "Самая ранняя из датированных публикаций";
  const uncertainty = be ? "Для некаторых публікацый за гэты дзень час невядомы." : "Для части публикаций за этот день точное время неизвестно.";
  const dateRange = run?.options.from || run?.options.through ?
    `${run.options.from ? eventDate(run.options.from, locale) : "…"} — ${run.options.through ? eventDate(run.options.through, locale) : "…"}`
    : be ? "паводле запыту, без жорсткага фільтра" : "по запросу, без жёсткого фильтра";

  const roles = (entry: EventEntry) => [
    cited.has(entry.id) ? (be ? "На яе спасылаюцца" : "На неё ссылаются") : "",
    entry.citations.length ? (be ? "Спасылаецца на крыніцы" : "Ссылается на источники") : "",
    entry.outsideWindow ? (be ? "Па-за перыядам" : "Вне периода") : "",
  ].filter(Boolean).join(" · ");
  const access = (entry: EventEntry) => entry.access === "readable" ? "" : entry.access === "lead"
    ? (be ? "Загаловак і лід" : "Заголовок и лид") : (be ? "Толькі метаданыя" : "Только метаданные");

  function openSource(entry: EventEntry) {
    void desktopApi.openUrl(entry.url).catch(() => setError("open_failed"));
  }

  async function exportDocx() {
    if (!run || !entries.length) return;
    setError("");
    try {
      const path = await save({ defaultPath: be ? "Падзея.docx" : "Событие.docx", filters: [{ name: "Word", extensions: ["docx"] }] });
      if (!path) return;
      const names = entries.map((entry) => `${entry.publisher.replace(/[«»]/g, "").trim()} [${entry.id}]`);
      const nameById = new Map(entries.map((entry, index) => [entry.id, names[index]]));
      const asLink = (entry: EventEntry) => `«${nameById.get(entry.id)}»`;
      const output = [
        title, run.task, `${be ? "Перыяд" : "Период"} · ${dateRange}`,
        result?.summary ? [result.summary, ...(result.summarySources || []).flatMap((id) => {
          const source = byId.get(id);
          return source ? [asLink(source)] : [];
        })].join(" ") : "",
        earliest ? `${earliestTitle} · ${asLink(earliest)} · ${eventDate(earliest.published, locale)}` : "",
        sameDayUncertain ? uncertainty : "",
        run.status === "partial" ? (be ? "Частковы вынік" : "Частичный результат") : "",
        timelineTitle,
        ...entries.map((entry) => {
          const facts = [eventDate(entry.published, locale), asLink(entry), entry.title, roles(entry), access(entry)].filter(Boolean);
          if (entry.updated && entry.updated !== entry.published) facts.push(`${be ? "абноўлена" : "обновлено"} ${eventDate(entry.updated, locale)}`);
          const references = entry.citations.flatMap((citation) => {
            const source = byId.get(citation.sourceId);
            return source ? [`${be ? "Спасылка на" : "Ссылка на"} ${asLink(source)} · ${citation.evidence}`] : [];
          });
          return [facts.join(" · "), ...references].join("\n\n");
        }),
      ].filter(Boolean);
      await desktopApi.exportWReview(path, output.join("\n\n"), names, [title, timelineTitle], [],
        entries.map((entry, index) => ({ name: names[index], url: entry.url })));
    } catch { setError("export_failed"); }
  }

  const labels = {
    search: be ? "Пошук публікацый" : "Поиск публикаций",
    sources: be ? "Праверка старонак і спасылак" : "Проверка страниц и ссылок",
    reserve: be ? "Дадатковы пошук" : "Дополнительный поиск",
    summary: be ? "Фарміраванне выніку" : "Формирование результата",
    done: be ? "Гатова" : "Готово",
  };
  const errors: Record<string, string> = {
    unauthorized: be ? "Увайдзіце ў свой уліковы запіс." : "Войдите в свою учётную запись.",
    access_denied: be ? "Для вашага ўліковага запісу няма доступу да гэтай укладкі." : "У вашей учётной записи нет доступа к этой вкладке.",
    export_failed: be ? "Не ўдалося захаваць DOCX." : "Не удалось сохранить DOCX.",
    open_failed: be ? "Не ўдалося адкрыць спасылку." : "Не удалось открыть ссылку.",
  };
  const warnings = (result?.warnings || []).map((warning) => {
    if (warning === "deadline") return be ? "Час пошуку скончыўся. Паказаны сабраныя матэрыялы." : "Время поиска истекло. Показаны собранные материалы.";
    if (warning === "summary_unavailable") return be ? "Рэзюмэ недаступнае. Храналогія захаваная." : "Резюме недоступно. Хронология сохранена.";
    if (warning === "bright_unavailable") return be ? "Рэзервовы пошук Bright Data спрацаваў часткова." : "Резервный поиск Bright Data сработал частично.";
    return be ? "Частка запытаў да Tavily не выкананая." : "Часть запросов Tavily не выполнена.";
  });

  return <section className="event-trace-view">
    <h1>{title}</h1>
    {error && <div role="alert" className="notice error">{errors[error] || (be ? "Не ўдалося атрымаць вынік. Паспрабуйце яшчэ раз." : "Не удалось получить результат. Попробуйте ещё раз.")}</div>}
    <div className="event-trace-columns">
      <form className="panel event-trace-input" onSubmit={start}>
        <label htmlFor="event-task"><b>{be ? "Заданне" : "Задача"}</b></label>
        <textarea id="event-task" rows={6} maxLength={LIMIT} value={task} disabled={loading || submitting || running} onChange={(event) => setTask(event.target.value)}
          placeholder={be ? "Што адбылося і якую інфармацыю трэба прасачыць? Можна ўставіць спасылку." : "Что произошло и какую информацию нужно проследить? Можно вставить ссылку."} />
        <small className="muted event-trace-count">{task.length} / {LIMIT}</small>
        <fieldset disabled={loading || submitting || running}>
          <legend>{be ? "Перыяд публікацый (неабавязкова)" : "Период публикаций (необязательно)"}</legend>
          <div className="event-trace-dates">
            <label>{be ? "Ад" : "С"}<input type="date" value={from} max={through || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>{be ? "Па" : "По"}<input type="date" value={through} min={from || undefined} onChange={(event) => setThrough(event.target.value)} /></label>
          </div>
        </fieldset>
        <button className="primary-button" disabled={!task.trim() || submitting || running || loading || Boolean(from && through && from > through)}>{be ? "Прасачыць" : "Проследить"}</button>
      </form>
      <div className="panel event-trace-output">
        <div className="event-trace-output-head"><h2>{be ? "Вынік" : "Результат"}</h2>{entries.length > 0 &&
          <button className="secondary-button small-button" onClick={() => void exportDocx()}>{be ? "Захаваць DOCX" : "Сохранить DOCX"}</button>}</div>
        <p role="status" className="muted">{loading ? "Загрузка…" : running || submitting ?
          (run ? `${labels[run.stage]}…` : `${labels.search}…`) : run?.status === "failed" ?
          (be ? "Пошук перарваўся." : "Поиск прервался.") : run?.status === "partial" ?
          (be ? "Частковы вынік" : "Частичный результат") : !run ?
          (be ? "Тут з’явяцца крыніцы і храналогія." : "Здесь появятся источники и хронология.") : ""}</p>
        {run && <p className="muted">{be ? "Перыяд" : "Период"} · {dateRange}</p>}
        {[...new Set(warnings)].map((warning) => <p className="muted" key={warning}>{warning}</p>)}
        {result?.summary && <div><p>{result.summary}</p><div className="event-trace-links">{(result.summarySources || []).map((id) => {
          const source = byId.get(id);
          return source && <button className="link-button" key={id} onClick={() => openSource(source)}>{source.publisher} · {id}</button>;
        })}</div></div>}
        {earliest ? <div className="event-trace-earliest"><b>{earliestTitle}</b>
          <button className="link-button" onClick={() => openSource(earliest)}>{earliest.title}</button>
          <small>{earliest.publisher} · {eventDate(earliest.published, locale)}</small>
          {sameDayUncertain && <small>{uncertainty}</small>}
        </div> : result && !running && <p>{be ? "Публікацыі з пацверджанай датай за гэты перыяд не знойдзеныя." : "Публикации с подтверждённой датой за этот период не найдены."}</p>}
        {entries.length > 0 && <div className="event-trace-timeline">
          <h3>{timelineTitle}</h3>
          <p className="muted">{be ? "Час па Мінску" : "Время по Минску"} · {be ? "Праверана старонак" : "Проверено страниц"} {result?.checked}</p>
          <ol>{entries.map((entry) => <li key={entry.id}>
            <small>{entry.publisher} · {eventDate(entry.published, locale)}</small>
            <button className="link-button event-trace-article" onClick={() => openSource(entry)}>{entry.title}</button>
            {(roles(entry) || access(entry)) && <small>{[roles(entry), access(entry)].filter(Boolean).join(" · ")}</small>}
            {entry.updated && entry.updated !== entry.published && <small>{be ? "Абноўлена" : "Обновлено"} · {eventDate(entry.updated, locale)}</small>}
            {entry.citations.map((citation) => {
              const source = byId.get(citation.sourceId);
              return source && <div key={source.id} className="event-trace-citation">
                <button className="link-button" onClick={() => openSource(source)}>{be ? "Спасылка на" : "Ссылка на"} {source.publisher} · {source.id}</button>
                <small>{citation.evidence}</small>
              </div>;
            })}
          </li>)}</ol>
        </div>}
      </div>
    </div>
  </section>;
}
