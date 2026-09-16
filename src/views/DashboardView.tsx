import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { DashboardOverview, PeriodDays } from "../types";
import { useI18n } from "../i18n";
import { PeriodSelector } from "../components/PeriodSelector";
import { TrendColumns } from "../components/Charts";
import { BreakdownPanel } from "../components/BreakdownPanel";
import { PublicationCard } from "../components/PublicationCard";

function useSectionOverview(period: PeriodDays, basePeriod: PeriodDays, baseData: DashboardOverview | null) {
  const [data, setData] = useState<DashboardOverview | null>(baseData);
  useEffect(() => {
    let cancelled = false;
    if (period === basePeriod && baseData) {
      setData(baseData);
      return () => { cancelled = true; };
    }
    desktopApi.dashboard(period).then((next) => { if (!cancelled) setData(next); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [period, basePeriod, baseData]);
  return data;
}

export function DashboardView({
  data,
  period,
  onPeriodChange,
  loading,
  onOpenArchive,
}: {
  data: DashboardOverview | null;
  period: PeriodDays;
  onPeriodChange: (value: PeriodDays) => void;
  loading: boolean;
  onOpenArchive: () => void;
}) {
  const { t } = useI18n();
  const [topicsPeriod, setTopicsPeriod] = useState<PeriodDays>(30);
  const [geoPeriod, setGeoPeriod] = useState<PeriodDays>(30);
  const [sourcesPeriod, setSourcesPeriod] = useState<PeriodDays>(30);
  const topicsData = useSectionOverview(topicsPeriod, period, data);
  const geoData = useSectionOverview(geoPeriod, period, data);
  const sourcesData = useSectionOverview(sourcesPeriod, period, data);

  return (
    <div className="view-stack">
      <section className="view-heading dashboard-heading">
        <div>
          <div className="eyebrow dark">{t("dashboard.eyebrow")}</div>
          <h2>{t("dashboard.title")}</h2>
          <p>{t("dashboard.subtitle")}</p>
        </div>
      </section>

      <section className="kpi-grid dashboard-kpis">
        <article className="kpi"><strong>{loading ? "…" : data?.publications ?? 0}</strong><span>{t("dashboard.publications")}</span></article>
        <article className="kpi"><strong>{loading ? "…" : data?.activeSources ?? 0}</strong><span>{t("dashboard.activeSources")}</span></article>
        <article className="kpi"><strong>{loading ? "…" : data?.regions ?? 0}</strong><span>{t("dashboard.regions")}</span></article>
        <article className="kpi"><strong>{loading ? "…" : data?.categories ?? 0}</strong><span>{t("dashboard.categories")}</span></article>
        <article className="kpi"><strong>{loading ? "…" : data?.officialResponses ?? 0}</strong><span>{t("dashboard.responses")}</span></article>
      </section>

      <section className="dashboard-grid">
        <article className="panel chart-panel span-two">
          <div className="panel-head chart-head-with-mode"><div><h3>{t("dashboard.trend")}</h3><p>{t("dashboard.trendHelp")}</p></div><PeriodSelector value={period} onChange={onPeriodChange} compact /></div>
          <TrendColumns data={data?.trend ?? []} />
        </article>
        <BreakdownPanel title={t("dashboard.topics")} subtitle={t("dashboard.topicsHelp")} data={topicsData?.categoryBreakdown ?? []} period={topicsPeriod} onPeriodChange={setTopicsPeriod} />
        <BreakdownPanel title={t("dashboard.geography")} subtitle={t("dashboard.geographyHelp")} data={geoData?.regionBreakdown ?? []} allowMap period={geoPeriod} onPeriodChange={setGeoPeriod} />
        <BreakdownPanel title={t("dashboard.sources")} subtitle={t("dashboard.sourcesHelp")} data={sourcesData?.sourceBreakdown ?? []} period={sourcesPeriod} onPeriodChange={setSourcesPeriod} />
      </section>

      <section className="panel recent-panel">
        <div className="panel-head">
          <div><h3>{t("dashboard.recent")}</h3><p>{t("dashboard.recentHelp")}</p></div>
          <button className="secondary-button" onClick={onOpenArchive}>{t("dashboard.openArchive")}</button>
        </div>
        <div className="recent-list">
          {(data?.recent ?? []).length === 0 ? <div className="empty-state">{t("common.noData")}</div> : (data?.recent ?? []).map((item) => <PublicationCard item={item} compact key={item.id} />)}
        </div>
      </section>
    </div>
  );
}
