import { useEffect, useMemo, useState } from "react";
import { desktopApi } from "../api";
import type { SourceSummary } from "../types";
import { useI18n } from "../i18n";

export function SourcesView() {
  const { t } = useI18n();
  const [items, setItems] = useState<SourceSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { desktopApi.sources().then(setItems).catch((reason) => setError(String(reason))); }, []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ru-RU");
    if (!needle) return items;
    return items.filter((item) => [item.name, item.domain ?? "", item.region ?? "", item.locality ?? "", item.sourceType ?? ""].some((value) => value.toLocaleLowerCase("ru-RU").includes(needle)));
  }, [items, query]);

  return <div className="view-stack">
    <section className="view-heading"><div><div className="eyebrow dark">{t("sources.eyebrow")}</div><h2>{t("sources.title")}</h2><p>{t("sources.subtitle")}</p></div><div className="compact-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("sources.search")} /></div></section>
    {error && <div className="notice error">{error}</div>}
    <section className="panel source-table-panel"><div className="panel-head"><div><h3>{t("sources.count", { count: filtered.length })}</h3><p>{t("sources.help")}</p></div></div><div className="table-wrap sources-table-wrap"><table className="sources-table"><thead><tr><th>{t("sources.source")}</th><th>{t("sources.type")}</th><th>{t("sources.priority")}</th><th>{t("sources.region")}</th><th>{t("sources.publications")}</th><th>{t("sources.runResults")}</th><th>{t("sources.access")}</th><th>{t("sources.admission")}</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><b>{item.name}</b><small>{item.domain ?? "—"}</small></td><td>{item.sourceType ?? "—"}</td><td>{item.priority ?? "—"}</td><td>{item.region ?? "—"}{item.locality && item.locality !== item.region ? <small>{item.locality}</small> : null}</td><td>{item.publications}</td><td>{item.totalResults}</td><td><span className="status-pill">{item.accessStatus ?? "—"}</span></td><td><span className="status-pill muted">{item.admissionStatus ?? "—"}</span></td></tr>)}</tbody></table></div></section>
  </div>;
}
