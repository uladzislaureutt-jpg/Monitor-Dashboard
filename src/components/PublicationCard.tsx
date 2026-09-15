import { desktopApi } from "../api";
import type { PublicationSummary } from "../types";

function formatDate(value: string | null) {
  if (!value) return "Дата не определена";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

export function PublicationCard({ item, compact = false }: { item: PublicationSummary; compact?: boolean }) {
  async function openOriginal() {
    try {
      await desktopApi.openUrl(item.url);
    } catch (error) {
      console.error(error);
    }
  }

  return (
    <article className={`publication-card ${compact ? "compact" : ""}`}>
      <div className="publication-meta">
        <span className="source-chip">{item.source}</span>
        <span>{formatDate(item.publishedAt)}</span>
        {item.region && <span>{item.region}{item.locality && item.locality !== item.region ? ` · ${item.locality}` : ""}</span>}
      </div>
      <button className="publication-title" onClick={openOriginal}>{item.title}</button>
      {!compact && item.excerpt && <p className="publication-excerpt">{item.excerpt}</p>}
      <div className="publication-footer">
        <div className="tag-row">
          {item.category && <span className="tag">{item.category}</span>}
          {item.eventObject && <span className="tag subtle">{item.eventObject}</span>}
          {item.eventProblem && <span className="tag subtle">{item.eventProblem}</span>}
        </div>
        <div className="publication-actions">
          {item.seenInRuns > 1 && <span className="seen-count">в {item.seenInRuns} запусках</span>}
          <button className="link-button" onClick={openOriginal}>Открыть ↗</button>
        </div>
      </div>
    </article>
  );
}
