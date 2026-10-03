import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { DashboardOverview, PeriodDays, PublicationSummary } from "../types";
import { useI18n } from "../i18n";
import { PeriodSelector } from "../components/PeriodSelector";
import { TopicTrendLines, TrendColumns, TrendLine } from "../components/Charts";
import { TopicTrend3D } from "../components/TopicTrend3D";
import { BreakdownPanel } from "../components/BreakdownPanel";
import { ResonancePanel } from "../components/ResonancePanel";
import { PublicationCard } from "../components/PublicationCard";
import { VisualStories } from "../components/VisualStories";
import { localizeDataLabel } from "../dataLabels";

type TrendMode = "volume" | "line" | "topics" | "topics3d";
type MonitorKey = "social_economic" | "lukashenko";
type TopicPoint = { category: string; bucket: string };

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
  monitorKey,
  data,
  period,
  onPeriodChange,
  loading,
  onOpenArchive,
}: {
  monitorKey: MonitorKey;
  data: DashboardOverview | null;
  period: PeriodDays;
  onPeriodChange: (value: PeriodDays) => void;
  loading: boolean;
  onOpenArchive: () => void;
}) {
  const { t, locale } = useI18n();
  const isLMonitor = monitorKey === "lukashenko";
  const [trendMode, setTrendMode] = useState<TrendMode>(isLMonitor ? "topics" : "volume");
  const [selectedTopicPoint, setSelectedTopicPoint] = useState<TopicPoint | null>(null);
  const [topicPointItems, setTopicPointItems] = useState<PublicationSummary[]>([]);
  const [topicPointLoading, setTopicPointLoading] = useState(false);
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
  const selectTopicPoint = useCallback((point: TopicPoint) => setSelectedTopicPoint(point), []);

  useEffect(() => {
    if (!selectedTopicPoint) return;
    let cancelled = false;
    setTopicPointLoading(true);
    setTopicPointItems([]);
    desktopApi.topicBucketPublications(selectedTopicPoint.category, selectedTopicPoint.bucket)
      .then((items) => { if (!cancelled) setTopicPointItems(items); })
      .catch(() => { if (!cancelled) setTopicPointItems([]); })
      .finally(() => { if (!cancelled) setTopicPointLoading(false); });
    return () => { cancelled = true; };
  }, [selectedTopicPoint]);

  return <div className="view-stack">
    <section className="view-heading dashboard-heading">
      <div>
        <div className="eyebrow dark">{isLMonitor ? "L-MONITOR" : t("dashboard.eyebrow")}</div>
        <h2>{isLMonitor ? (locale === "be" ? "Маніторынг Аляксандра Лукашэнкі" : "Мониторинг Александра Лукашенко") : t("dashboard.title")}</h2>
        <p>{isLMonitor ? (locale === "be" ? "Міжнародны інфармацыйны паток: унутраная і знешнепалітычная павестка, сюжэты, краіны і крыніцы." : "Международный информационный поток: внутренняя и внешнеполитическая повестка, сюжеты, страны и источники.") : t("dashboard.subtitle")}</p>
      </div>
    </section>

    <section className="dashboard-summary">
      <div className="dashboard-summary-controls">
        <PeriodSelector value={summaryPeriod} onChange={setSummaryPeriod} compact />
      </div>
      <div className={`kpi-grid dashboard-kpis ${isLMonitor ? "l-monitor-kpis" : ""}`}>
        <article className="kpi"><strong>{summaryLoading ? "…" : summaryData?.publications ?? 0}</strong><span>{t("dashboard.publications")}</span></article>
        <article className="kpi"><strong>{summaryLoading ? "…" : summaryData?.activeSources ?? 0}</strong><span>{t("dashboard.activeSources")}</span></article>
        <article className="kpi"><strong>{summaryLoading ? "…" : summaryData?.regions ?? 0}</strong><span>{isLMonitor ? (locale === "be" ? "краін паходжання крыніц" : "стран происхождения источников") : t("dashboard.regions")}</span></article>
        <article className="kpi"><strong>{summaryLoading ? "…" : summaryData?.categories ?? 0}</strong><span>{isLMonitor ? (locale === "be" ? "напрамкі парадку дня" : "направления повестки") : t("dashboard.categories")}</span></article>
        {!isLMonitor && <article className="kpi info-kpi" title={t("dashboard.responsesHelp")}><strong>{summaryLoading ? "…" : summaryData?.officialResponses ?? 0}</strong><span>{t("dashboard.responses")} <i className="info-dot">i</i></span></article>}
      </div>
    </section>

    <section className="dashboard-grid">
      <article className="panel chart-panel span-two">
        <div className="panel-head chart-head-with-mode">
          <div><h3>{t("dashboard.trend")}</h3><p>{isLMonitor ? (locale === "be" ? "Два патокі: унутраная павестка і знешняя палітыка." : "Два потока: внутренняя повестка и внешняя политика.") : t("dashboard.trendHelp")}</p></div>
          <div className="panel-control-stack trend-controls">
            <PeriodSelector value={period} onChange={onPeriodChange} compact />
            <div className="chart-mode-switch">
              <button className={trendMode === "volume" ? "active" : ""} onClick={() => setTrendMode("volume")}>{t("chart.volume")}</button>
              <button className={trendMode === "line" ? "active" : ""} onClick={() => setTrendMode("line")}>{t("chart.line")}</button>
              <button className={trendMode === "topics" ? "active" : ""} onClick={() => setTrendMode("topics")}>{t("chart.topicLines")}</button>
              <button className={trendMode === "topics3d" ? "active" : ""} onClick={() => setTrendMode("topics3d")}>{t("chart.topic3d")}</button>
            </div>
          </div>
        </div>
        {trendMode === "volume" && <TrendColumns data={data?.trend ?? []} />}
        {trendMode === "line" && <TrendLine data={data?.trend ?? []} />}
        {trendMode === "topics" && <TopicTrendLines data={data?.topicTrend ?? []} />}
        {trendMode === "topics3d" && <>
          <TopicTrend3D data={data?.topicTrend ?? []} onSelect={selectTopicPoint} />
          {selectedTopicPoint && <section className="topic-point-results" aria-live="polite">
            <div className="topic-point-results-head">
              <div>
                <h4>{t("chart.selectedPublications", { category: localizeDataLabel(selectedTopicPoint.category, locale, "category"), bucket: selectedTopicPoint.bucket })}</h4>
                <p>{t("chart.selectedPublicationsHelp")}</p>
              </div>
            </div>
            {topicPointLoading
              ? <div className="chart-empty">{t("chart.loadingPublications")}</div>
              : topicPointItems.length
                ? <div className="topic-point-publications">{topicPointItems.map((item) => <PublicationCard item={item} compact key={item.id} />)}</div>
                : <div className="chart-empty">{t("chart.noPointPublications")}</div>}
          </section>}
        </>}
      </article>
{isLMonitor ? <>
        <ResonancePanel title={locale === "be" ? "Сюжэты" : "Сюжеты"} subtitle={locale === "be" ? "Асноўная публікацыя і спіс іншых крыніц, якія асвятлялі той жа сюжэт." : "Основная публикация и список других источников, освещавших тот же сюжет."} items={[]} stories={resonanceData?.stories ?? []} fallback={false} period={resonancePeriod} onPeriodChange={setResonancePeriod} />
        <BreakdownPanel title={locale === "be" ? "Краіны паходжання крыніц" : "Страны происхождения источников"} subtitle={locale === "be" ? "Странавая прыналежнасць выданняў, якія апублікавалі матэрыялы. Схема паказвае маштаб кожнай краіны." : "Страновая принадлежность изданий, опубликовавших материалы. Схема показывает масштаб каждой страны."} data={geoData?.regionBreakdown ?? []} scheme="source_countries" initialMode="bars" controlsClassName="source-country-controls" period={geoPeriod} onPeriodChange={setGeoPeriod} />
        <BreakdownPanel className="span-two" title={t("dashboard.sources")} subtitle={t("dashboard.sourcesHelp")} data={sourcesData?.sourceBreakdown ?? []} period={sourcesPeriod} onPeriodChange={setSourcesPeriod} />
      </> : <>
        <BreakdownPanel title={t("dashboard.topics")} subtitle={t("dashboard.topicsHelp")} data={topicsData?.categoryBreakdown ?? []} period={topicsPeriod} onPeriodChange={setTopicsPeriod} labelKind="category" />
        <BreakdownPanel title={t("dashboard.geography")} subtitle={t("dashboard.geographyHelp")} data={geoData?.regionBreakdown ?? []} allowMap period={geoPeriod} onPeriodChange={setGeoPeriod} labelKind="region" />
        <BreakdownPanel title={t("dashboard.sources")} subtitle={t("dashboard.sourcesHelp")} data={sourcesData?.sourceBreakdown ?? []} period={sourcesPeriod} onPeriodChange={setSourcesPeriod} />
        <ResonancePanel items={resonanceData?.resonanceItems ?? []} fallback={resonanceData?.resonanceFallback ?? false} period={resonancePeriod} onPeriodChange={setResonancePeriod} />
      </>}
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
