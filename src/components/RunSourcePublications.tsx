import { useEffect, useMemo, useState } from "react";
import { desktopApi } from "../api";
import { useI18n } from "../i18n";
import type { RunPublication, RunSummary } from "../types";

type Feed = "both" | "github" | "assistant";

export function RunSourcePublications({ github, assistant }: { github?: RunSummary; assistant?: RunSummary }) {
  const { locale } = useI18n();
  const be = locale === "be";
  const [feed, setFeed] = useState<Feed>("both");
  const hasBoth = Boolean(github && assistant);
  const selected = hasBoth ? feed : "both";
  const githubId = selected !== "assistant" ? github?.id : undefined;
  const assistantId = selected !== "github" ? assistant?.id : undefined;
  const githubRevision = selected !== "assistant" ? github?.importedAt : undefined;
  const assistantRevision = selected !== "github" ? assistant?.importedAt : undefined;
  const [items, setItems] = useState<RunPublication[]>([]);
  const [loading, setLoading] = useState(Boolean(github || assistant));
  const [error, setError] = useState("");
  const [linkError, setLinkError] = useState("");

  useEffect(() => {
    const ids = [githubId, assistantId].filter((id): id is number => id !== undefined);
    if (!ids.length) {
      setItems([]);
      setLoading(false);
      return;
    }
    let revision = 0;
    const reload = () => {
      const request = ++revision;
      setLoading(true);
      setError("");
      void Promise.all(ids.map((id) => desktopApi.lMonitorRunPublications(id))).then((next) => {
        if (request === revision) setItems([...new Map(next.flat().map((item) => [item.id, item])).values()]);
      }).catch((reason) => {
        if (request === revision) setError(String(reason));
      }).finally(() => {
        if (request === revision) setLoading(false);
      });
    };
    reload();
    window.addEventListener("monitor:moderation-changed", reload);
    return () => {
      revision += 1;
      window.removeEventListener("monitor:moderation-changed", reload);
    };
  }, [githubId, assistantId, githubRevision, assistantRevision]);

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
  const run = selected === "github" ? github : selected === "assistant" ? assistant : hasBoth ? undefined : github ?? assistant;
  const runDate = run ? new Date(run.startedAt ?? run.importedAt) : null;
  const dateLabel = runDate && Number.isFinite(runDate.valueOf()) ? runDate.toLocaleDateString(be ? "be-BY" : "ru-RU") : "";
  const githubLabel = github?.runNumber == null ? "GitHub" : `GitHub №${github.runNumber}`;
  const assistantLabel = [be ? "Памочнік" : "Помощник",
    assistant?.collectorNumber == null ? "" : `№${assistant.collectorNumber}`].filter(Boolean).join(" ");
  const runLabel = run?.collector ? assistantLabel : githubLabel;

  return <section className="panel run-source-panel" aria-labelledby="run-source-heading" aria-busy={loading}>
    <div className="panel-head">
      <div>
        <h3 id="run-source-heading">{be ? "Публікацыі ў крыніцах" : "Публикации в источниках"}</h3>
        {run && <p>{[runLabel, dateLabel].filter(Boolean).join(" · ")}</p>}
        {hasBoth && selected === "both" && <p>{githubLabel} · {assistantLabel}</p>}
      </div>
      {hasBoth && <select aria-label={be ? "Паток публікацый" : "Поток публикаций"} value={selected}
        onChange={(event) => setFeed(event.target.value as Feed)}>
        <option value="both">{be ? "Абодва патокі" : "Оба потока"}</option>
        <option value="github">{githubLabel}</option>
        <option value="assistant">{assistantLabel}</option>
      </select>}
    </div>
    {linkError && <div className="notice error" role="alert">{linkError}</div>}
    {loading ? <div className="chart-empty">{be ? "Загрузка публікацый…" : "Загрузка публикаций…"}</div>
      : error ? <div className="notice error" role="alert">{error}</div>
        : !sources.length ? <div className="chart-empty">{github || assistant
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
