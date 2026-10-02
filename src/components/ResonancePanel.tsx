import type { PeriodDays, PublicationSummary, StorySummary } from "../types";
import { desktopApi } from "../api";
import { useI18n } from "../i18n";
import { PeriodSelector } from "./PeriodSelector";
import { PublicationCard } from "./PublicationCard";

export function ResonancePanel({
  title,
  subtitle,
  items,
  stories,
  fallback,
  period,
  onPeriodChange,
}: {
  title?: string;
  subtitle?: string;
  items: PublicationSummary[];
  stories?: StorySummary[];
  fallback: boolean;
  period: PeriodDays;
  onPeriodChange: (value: PeriodDays) => void;
}) {
  const { t, locale } = useI18n();
  const storyMode = stories !== undefined;
  return (
    <article className="panel resonance-panel">
      <div className="panel-head chart-head-with-mode">
        <div>
          <h3>{title ?? t("dashboard.resonance")}</h3>
          <p>{fallback ? t("dashboard.resonanceFallback") : (subtitle ?? t("dashboard.resonanceHelp"))}</p>
        </div>
        <PeriodSelector value={period} onChange={onPeriodChange} compact />
      </div>
      {storyMode ? <div className="story-list">
        {stories.length === 0
          ? <div className="empty-state">{t("common.noData")}</div>
          : stories.map((story, storyIndex) => {
            const related = story.publications.filter((item) => item.id !== story.representative.id);
            return <article className="story-card" key={`${story.representative.id}-${storyIndex}`}>
              <div className="story-primary-meta"><b>{story.representative.source}</b>{story.representative.region && <span>{story.representative.region}</span>}</div>
              <button className="story-title" onClick={() => desktopApi.openUrl(story.representative.url).catch(() => undefined)}>{story.title}</button>
              {related.length > 0 && <div className="story-related">
                <strong>{locale === "be" ? "Таксама апублікавалі" : "Также опубликовали"}</strong>
                {related.map((item) => <button key={item.id} onClick={() => desktopApi.openUrl(item.url).catch(() => undefined)}><span>{item.source}</span><b>{item.title}</b></button>)}
              </div>}
            </article>;
          })}
      </div> : <div className="resonance-list">
        {items.length === 0
          ? <div className="empty-state">{t("common.noData")}</div>
          : items.map((item) => <PublicationCard item={item} compact key={item.id} />)}
      </div>}
    </article>
  );
}
