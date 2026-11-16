import { useEffect, useMemo, useState } from "react";
import { desktopApi } from "../api";
import { useI18n } from "../i18n";
import type { RunPublication, RunSummary } from "../types";

export function RunSourcePublications({ run }: { run?: RunSummary }) {
  const { locale } = useI18n();
  const be = locale === "be";
  const [items, setItems] = useState<RunPublication[]>([]);
  const [loading, setLoading] = useState(Boolean(run));
  const [error, setError] = useState("");
  const [linkError, setLinkError] = useState("");
  const runId = run?.id;
  const importedAt = run?.importedAt;

  useEffect(() => {
    const id = runId;
    if (id === undefined) return;
    let revision = 0;
    function reload() {
      const request = ++revision;
      setLoading(true);
      setError("");
      void desktopApi.lMonitorRunPublications(id).then((next) => {
        if (request === revision) setItems(next);
      }).catch((reason) => {
        if (request === revision) setError(String(reason));
      }).finally(() => {
        if (request === revision) setLoading(false);
      });
    }
    reload();
    window.addEventListener("monitor:moderation-changed", reload);
    return () => {
      revision += 1;
      window.removeEventListener("monitor:moderation-changed", reload);
    };
  }, [runId, importedAt]);

  const sources = useMemo(() => {
    const groups = new Map<string, RunPublication[]>();
    for (const item of items) {
      const source = item.source ?? (be ? "Невядомая крыніца" : "Неизвестный источник");
      const group = groups.get(source);
      if (group) group.push(item);
      else groups.set(source, [item]);
    }
    return [...groups].sort(([left, a], [right, b]) => b.length - a.length || left.localeCompare(right, locale));
  }, [items, be, locale]);
  const runDate = run ? new Date(run.startedAt ?? run.importedAt) : null;
  const dateLabel = runDate && Number.isFinite(runDate.valueOf()) ? runDate.toLocaleDateString(be ? "be-BY" : "ru-RU") : "";
  const runLabel = [be ? "Апошні запуск" : "Последний прогон",
    run?.runNumber == null ? "" : `№${run.runNumber}`,
  ].filter(Boolean).join(" ");

  return <section className="panel run-source-panel" aria-labelledby="run-source-heading" aria-busy={loading}>
    <div className="panel-head">
      <div>
        <h3 id="run-source-heading">{be ? "Публікацыі ў крыніцах" : "Публикации в источниках"}</h3>
        {run && <p>{[runLabel, dateLabel].filter(Boolean).join(" · ")}</p>}
      </div>
    </div>
    {linkError && <div className="notice error" role="alert">{linkError}</div>}
    {loading ? <div className="chart-empty">{be ? "Загрузка публікацый…" : "Загрузка публикаций…"}</div>
      : error ? <div className="notice error" role="alert">{error}</div>
        : !sources.length ? <div className="chart-empty">{run
          ? (be ? "У гэтым запуску няма публікацый" : "В этом прогоне нет публикаций")
          : (be ? "Запускаў пакуль няма" : "Прогоны ещё не загружены")}</div>
          : <div className="run-source-list">{sources.map(([source, publications]) => <details key={source}>
            <summary><span aria-hidden="true" className="run-source-chevron">›</span><strong>{source}</strong><span className="run-source-count">{publications.length}</span></summary>
            <ul>{publications.map((item) => <li key={item.id}>
              {/^https?:\/\//i.test(item.url) ? <a href={item.url} onClick={(event) => {
                event.preventDefault();
                setLinkError("");
                void desktopApi.openUrl(item.url).catch((reason) => setLinkError(String(reason)));
              }}>{item.title} <span aria-hidden="true">↗</span></a> : item.title}
            </li>)}</ul>
          </details>)}</div>}
  </section>;
}
