import { desktopApi } from "../api";
import type { PublicationSummary } from "../types";
import { useI18n } from "../i18n";

export function PublicationCard({ item, compact = false }: { item: PublicationSummary; compact?: boolean }) {
  const { t, formatLocale } = useI18n();
  const formatDate = (value: string | null) => {
    if (!value) return t("publication.dateUnknown");
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(formatLocale, { dateStyle: "medium", timeStyle: "short" });
  };
  async function openOriginal() { try { await desktopApi.openUrl(item.url); } catch (error) { console.error(error); } }
  return <article className={`publication-card ${compact ? "compact" : ""}`}>
    <div className="publication-meta"><span className="source-chip">{item.source}</span><span>{formatDate(item.publishedAt)}</span>{item.region && <span>{item.region}{item.locality && item.locality !== item.region ? ` · ${item.locality}` : ""}</span>}</div>
    <button className="publication-title" onClick={openOriginal}>{item.title}</button>
    {!compact && item.excerpt && <p className="publication-excerpt">{item.excerpt}</p>}
    <div className="publication-footer"><div className="tag-row">{item.category && <span className="tag">{item.category}</span>}{item.eventObject && <span className="tag subtle">{item.eventObject}</span>}{item.eventProblem && <span className="tag subtle">{item.eventProblem}</span>}</div><div className="publication-actions">{item.seenInRuns > 1 && <span className="seen-count">{t("publication.inRuns", { count: item.seenInRuns })}</span>}<button className="link-button" onClick={openOriginal}>{t("publication.open")}</button></div></div>
  </article>;
}
