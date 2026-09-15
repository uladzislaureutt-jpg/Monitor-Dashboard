import { useEffect, useMemo, useState } from "react";
import { desktopApi } from "../api";
import type { SourceSummary } from "../types";

export function SourcesView() {
  const [items, setItems] = useState<SourceSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { desktopApi.sources().then(setItems).catch((reason) => setError(String(reason))); }, []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ru-RU");
    if (!needle) return items;
    return items.filter((item) => [item.name, item.domain ?? "", item.region ?? "", item.locality ?? "", item.sourceType ?? ""].some((value) => value.toLocaleLowerCase("ru-RU").includes(needle)));
  }, [items, query]);

  return (
    <div className="view-stack">
      <section className="view-heading"><div><div className="eyebrow dark">ИСТОЧНИКИ</div><h2>Каталог мониторинга</h2><p>Все источники из coverage, включая те, которые не дали публикаций в последнем запуске.</p></div><div className="compact-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти источник…" /></div></section>
      {error && <div className="notice error">{error}</div>}
      <section className="panel source-table-panel">
        <div className="panel-head"><div><h3>{filtered.length} источников</h3><p>Публикации — число уникальных материалов в локальной базе.</p></div></div>
        <div className="table-wrap sources-table-wrap"><table className="sources-table"><thead><tr><th>Источник</th><th>Тип</th><th>Приоритет</th><th>Регион источника</th><th>Публикации</th><th>Результаты runs</th><th>Access</th><th>Admission</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><b>{item.name}</b><small>{item.domain ?? "—"}</small></td><td>{item.sourceType ?? "—"}</td><td>{item.priority ?? "—"}</td><td>{item.region ?? "—"}{item.locality && item.locality !== item.region ? <small>{item.locality}</small> : null}</td><td>{item.publications}</td><td>{item.totalResults}</td><td><span className="status-pill">{item.accessStatus ?? "—"}</span></td><td><span className="status-pill muted">{item.admissionStatus ?? "—"}</span></td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}
