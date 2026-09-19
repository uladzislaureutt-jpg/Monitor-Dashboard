import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { DashboardOverview, PeriodDays } from "../types";
import { useI18n } from "../i18n";
import { PeriodSelector } from "../components/PeriodSelector";
import { TopicTrendLines, TrendColumns, TrendLine } from "../components/Charts";
import { BreakdownPanel } from "../components/BreakdownPanel";
import { ResonancePanel } from "../components/ResonancePanel";
import { PublicationCard } from "../components/PublicationCard";
import { VisualStories } from "../components/VisualStories";

type TrendMode = "volume" | "line" | "topics";

function useSectionOverview(period: PeriodDays, basePeriod: PeriodDays, baseData: DashboardOverview | null) {
  const [data, setData] = useState<DashboardOverview | null>(baseData);
  useEffect(() => {
    let cancelled = false;
    if (period === basePeriod && baseData) {
      setData(baseData);
      return () => { cancelled = true; };
    }
    desktopApi.dashboard(period).then((next) => {
      if (!cancelled) setData(next);
    }).catch(() => undefined);
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
  const [trendMode, setTrendMode] = useState<TrendMode>("volume");
  const [summaryPeriod, setSummaryPeriod] = useState<PeriodDays>(30);
  const [topicsPeriod, setTopicsPeriod] = useState<PeriodDays>(30);
  const [geoPeriod, setGeoPeriod] = useState<PeriodDays>(30);
  const [sourcesPeriod, setSourcesPeriod] = useState<PeriodDays>(30);
  const [resonancePeriod, setResonancePeriod] = useState<PeriodDays>(30);

  const summaryData = useSectionOverview(summaryPeriod, period, data);
  const topicsData = useSectionOverview(topicsPeriod, period, data);
  const geoData = useSectionOverview(geoPeriod, period, data);
  const sourcesData = useSectionOverview(sourcesPeriod, period, data);
  const resonanceData = useSectionOverview(resonancePeriod, period, data);

  const summaryLoading = loading && summaryPeriod === period;

  return <div className="view-stack">
    <section className="view-heading dashboard-heading">
      <div>
        <div className="eyebrow dark">{t("dashboard.eyebrow")}</div>
        <h2>{t("dashboard.title")}</h2>
        <p>{t("dashboard.subtitle")}</p>
      </div>
    </section>

    <section className="dashboard-summary">
      <div className="dashboard-summary-controls">
        <PeriodSelector value={summaryPeriod} onChange={setSummaryPeriod} compact />
      </div>
      <div className="kpi-grid dashboard-kpis">
        <article className="kpi"><strong>{summaryLoading ? "…" : summaryData?.publications ?? 0}</strong><span>{t("dashboard.publications")}</span></article>
        <article className="kpi"><strong>{summaryLoading ? "…" : summaryData?.activeSources ?? 0}</strong><span>{t("dashboard.activeSources")}</span></article>
        <article className="kpi"><strong>{summaryLoading ? "…" : summaryData?.regions ?? 0}</strong><span>{t("dashboard.regions")}</span></article>
        <article className="kpi"><strong>{summaryLoading ? "…" : summaryData?.categories ?? 0}</strong><span>{t("dashboard.categories")}</span></article>
        <article className="kpi info-kpi" title={t("dashboard.responsesHelp")}><strong>{summaryLoading ? "…" : summaryData?.officialResponses ?? 0}</strong><span>{t("dashboard.responses")} <i className="info-dot">i</i></span></article>
      </div>
    </section>

    <section className="dashboard-grid">
      <article className="panel chart-panel span-two">
        <div className="panel-head chart-head-with-mode">
          <div><h3>{t("dashboard.trend")}</h3><p>{t("dashboard.trendHelp")}</p></div>
          <div className="panel-control-stack trend-controls">
            <PeriodSelector value={period} onChange={onPeriodChange} compact />
            <div className="chart-mode-switch">
              <button className={trendMode === "volume" ? "active" : ""} onClick={() => setTrendMode("volume")}>{t("chart.volume")}</button>
              <button className={trendMode === "line" ? "active" : ""} onClick={() => setTrendMode("line")}>{t("chart.line")}</button>
              <button className={trendMode === "topics" ? "active" : ""} onClick={() => setTrendMode("topics")}>{t("chart.topicLines")}</button>
            </div>
          </div>
        </div>
        {trendMode === "volume" && <TrendColumns data={data?.trend ?? []} />}
        {trendMode === "line" && <TrendLine data={data?.trend ?? []} />}
        {trendMode === "topics" && <TopicTrendLines data={data?.topicTrend ?? []} />}
      </article>
      <BreakdownPanel title={t("dashboard.topics")} subtitle={t("dashboard.topicsHelp")} data={topicsData?.categoryBreakdown ?? []} period={topicsPeriod} onPeriodChange={setTopicsPeriod} labelKind="category" />
      <BreakdownPanel title={t("dashboard.geography")} subtitle={t("dashboard.geographyHelp")} data={geoData?.regionBreakdown ?? []} allowMap period={geoPeriod} onPeriodChange={setGeoPeriod} labelKind="region" />
      <BreakdownPanel title={t("dashboard.sources")} subtitle={t("dashboard.sourcesHelp")} data={sourcesData?.sourceBreakdown ?? []} period={sourcesPeriod} onPeriodChange={setSourcesPeriod} />
      <ResonancePanel items={resonanceData?.resonanceItems ?? []} fallback={resonanceData?.resonanceFallback ?? false} period={resonancePeriod} onPeriodChange={setResonancePeriod} />
    </section>

    <VisualStories items={data?.visuals ?? []} />
    <section className="panel recent-panel">
      <div className="panel-head"><div><h3>{t("dashboard.recent")}</h3><p>{t("dashboard.recentHelp")}</p></div><button className="secondary-button" onClick={onOpenArchive}>{t("dashboard.openArchive")}</button></div>
      <div className="recent-list">
        {(data?.recent ?? []).length === 0
          ? <div className="empty-state">{t("common.noData")}</div>
          : (data?.recent ?? []).map((item) => <PublicationCard item={item} compact key={item.id} />)}
      </div>
    </section>
  </div>;
}
