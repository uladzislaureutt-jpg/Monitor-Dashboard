import { useEffect, useRef, useState, type FormEvent } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { eventRun, type EventRun } from "../eventTrace";
import { makeEventReport, type ReportPart } from "../eventReport";
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
  const report = run && result?.entries.length ? makeEventReport(run, locale) : null;
  const title = be ? "Падзея" : "Событие";

  function parts(items: ReportPart[]) {
    return items.map((part, index) => part.url
      ? <button key={index} className="link-button" type="button" onClick={() => {
          void desktopApi.openUrl(part.url!).catch(() => setError("open_failed"));
        }}>{part.text}</button>
      : <span key={index}>{part.text}</span>);
  }

  async function exportDocx() {
    if (!report) return;
    setError("");
    try {
      const path = await save({ defaultPath: be ? "Падзея.docx" : "Событие.docx", filters: [{ name: "Word", extensions: ["docx"] }] });
      if (path) await desktopApi.exportEventReport(path, report);
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
        <div className="event-trace-output-head"><h2>{be ? "Вынік" : "Результат"}</h2>{report &&
          <button className="secondary-button small-button" onClick={() => void exportDocx()}>{be ? "Захаваць DOCX" : "Сохранить DOCX"}</button>}</div>
        <p role="status" className="muted">{loading ? "Загрузка…" : running || submitting ?
          (run ? `${labels[run.stage]}…` : `${labels.search}…`) : run?.status === "failed" ?
          (be ? "Пошук перарваўся." : "Поиск прервался.") : run?.status === "partial" ?
          (be ? "Частковы вынік" : "Частичный результат") : !run ?
          (be ? "Тут з’явяцца крыніцы і храналогія." : "Здесь появятся источники и хронология.") : ""}</p>
        {[...new Set(warnings)].map((warning) => <p className="muted" key={warning}>{warning}</p>)}
        {report ? <article className="event-editorial-report">
          <h3 className="event-report-title">{report.title}</h3>
          <dl className="event-report-meta">{report.metadata.map(([label, value]) =>
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          {report.sections.map((section) => <section className="event-report-section" key={section.heading}>
            <h4>{section.heading}</h4>
            {section.paragraphs.map((paragraph, index) => <p key={index}>{parts(paragraph)}</p>)}
            {section.table && <div className="event-report-table-wrap">
              <table aria-label={section.heading}>
                <colgroup>{section.table.widths.map((width, index) => <col key={index} style={{ width: width + "%" }} />)}</colgroup>
                <thead><tr>{section.table.headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
                <tbody>{section.table.rows.map((row, number) => <tr key={number}>
                  {row.map((cell, index) => <td key={index}>{parts(cell)}</td>)}
                </tr>)}</tbody>
              </table>
            </div>}
          </section>)}
        </article> : result && !running && <p>{be ? "Публікацыі за гэты перыяд не знойдзеныя." : "Публикации за этот период не найдены."}</p>}
      </div>
    </div>
  </section>;
}
