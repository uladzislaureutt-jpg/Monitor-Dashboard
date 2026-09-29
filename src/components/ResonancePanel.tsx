import type { PeriodDays, PublicationSummary } from "../types";
import { useI18n } from "../i18n";
import { PeriodSelector } from "./PeriodSelector";
import { PublicationCard } from "./PublicationCard";

export function ResonancePanel({
  title,
  subtitle,
  items,
  fallback,
  period,
  onPeriodChange,
}: {
  title?: string;
  subtitle?: string;
  items: PublicationSummary[];
  fallback: boolean;
  period: PeriodDays;
  onPeriodChange: (value: PeriodDays) => void;
}) {
  const { t } = useI18n();
  return (
    <article className="panel resonance-panel">
      <div className="panel-head chart-head-with-mode">
        <div>
          <h3>{title ?? t("dashboard.resonance")}</h3>
          <p>{fallback ? t("dashboard.resonanceFallback") : (subtitle ?? t("dashboard.resonanceHelp"))}</p>
        </div>
        <PeriodSelector value={period} onChange={onPeriodChange} compact />
      </div>
      <div className="resonance-list">
        {items.length === 0
          ? <div className="empty-state">{t("common.noData")}</div>
          : items.map((item) => <PublicationCard item={item} compact key={item.id} />)}
      </div>
    </article>
  );
}
