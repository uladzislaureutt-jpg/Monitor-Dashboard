import type { DashboardOverview, PeriodDays } from "../types";
import { useI18n } from "../i18n";
import { PeriodSelector } from "../components/PeriodSelector";
import { TrendColumns } from "../components/Charts";
import { BreakdownPanel } from "../components/BreakdownPanel";

export function AnalyticsView({ data, period, onPeriodChange }: { data: DashboardOverview | null; period: PeriodDays; onPeriodChange: (value: PeriodDays) => void }) {
  const { t } = useI18n();
  return (
    <div className="view-stack">
      <section className="view-heading">
        <div><div className="eyebrow dark">{t("analytics.eyebrow")}</div><h2>{t("analytics.title")}</h2><p>{t("analytics.subtitle")}</p></div>
        <PeriodSelector value={period} onChange={onPeriodChange} />
      </section>
      <section className="panel chart-panel analytics-trend"><div className="panel-head"><div><h3>{t("analytics.intensity")}</h3><p>{t("analytics.intensityHelp")}</p></div></div><TrendColumns data={data?.trend ?? []} /></section>
      <section className="analytics-grid">
        <BreakdownPanel title={t("analytics.categories")} subtitle={t("analytics.categoriesHelp")} data={data?.categoryBreakdown ?? []} maxItems={12} labelKind="category" />
        <BreakdownPanel title={t("analytics.regions")} subtitle={t("analytics.regionsHelp")} data={data?.regionBreakdown ?? []} maxItems={12} allowMap labelKind="region" />
        <BreakdownPanel title={t("analytics.sources")} subtitle={t("analytics.sourcesHelp")} data={data?.sourceBreakdown ?? []} maxItems={16} className="span-two" />
      </section>
      <section className="panel roadmap-card"><b>{t("analytics.next")}</b><p>{t("analytics.nextText")}</p></section>
    </div>
  );
}
