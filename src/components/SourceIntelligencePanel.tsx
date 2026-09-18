import type { CoverageHealthSummary, SourceDiversitySummary } from "../types";
import { useI18n } from "../i18n";

function percent(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function SourceDiversityPanel({ data }: { data: SourceDiversitySummary | null | undefined }) {
  const { t, formatLocale } = useI18n();
  if (!data || data.activeSources === 0) return <article className="panel intelligence-panel"><div className="panel-head"><div><h3>{t("analytics.diversity")}</h3><p>{t("analytics.diversityHelp")}</p></div></div><div className="chart-empty">{t("common.none")}</div></article>;
  return <article className="panel intelligence-panel">
    <div className="panel-head"><div><h3>{t("analytics.diversity")}</h3><p>{t("analytics.diversityHelp")}</p></div></div>
    <div className="source-intelligence-kpis">
      <div className="mini-kpi" title={t("analytics.activeSourcesHelp")}><strong>{data.activeSources}</strong><span>{t("analytics.activeSources")}</span></div>
      <div className="mini-kpi" title={t("analytics.topOneHelp")}><strong>{percent(data.topSourceShare)}</strong><span>{t("analytics.topOne")}</span></div>
      <div className="mini-kpi" title={t("analytics.topFiveHelp")}><strong>{percent(data.topFiveShare)}</strong><span>{t("analytics.topFive")}</span></div>
      <div className="mini-kpi" title={t("analytics.effectiveHelp")}><strong>{data.effectiveSources.toLocaleString(formatLocale, { maximumFractionDigits: 1 })}</strong><span>{t("analytics.effective")}</span></div>
    </div>
    <div className="diversity-meter" title={t("analytics.diversityIndexHelp")}>
      <div className="diversity-meter-head"><span>{t("analytics.diversityIndex")}</span><b>{percent(data.diversityIndex)}</b></div>
      <div className="diversity-track"><div className="diversity-fill" style={{ width: `${Math.max(2, Math.min(100, data.diversityIndex))}%` }} /></div>
    </div>
    {data.topSource && <div className="top-source-note"><span>{t("analytics.topSource")}</span><b>{data.topSource}</b><span>{percent(data.topSourceShare)}</span></div>}
  </article>;
}

export function CoverageHealthPanel({ data }: { data: CoverageHealthSummary | null | undefined }) {
  const { t } = useI18n();
  if (!data || data.totalSources === 0) return <article className="panel intelligence-panel"><div className="panel-head"><div><h3>{t("analytics.coverageHealth")}</h3><p>{t("analytics.coverageHealthHelp")}</p></div></div><div className="chart-empty">{t("common.none")}</div></article>;
  const rows = [
    { key: "stable", label: t("analytics.healthStable"), help: t("analytics.healthStableHelp"), value: data.stableSources },
    { key: "recovery", label: t("analytics.healthRecovery"), help: t("analytics.healthRecoveryHelp"), value: data.recoverySources },
    { key: "limited", label: t("analytics.healthLimited"), help: t("analytics.healthLimitedHelp"), value: data.limitedSources },
    { key: "attention", label: t("analytics.healthAttention"), help: t("analytics.healthAttentionHelp"), value: data.attentionSources },
  ];
  return <article className="panel intelligence-panel">
    <div className="panel-head"><div><h3>{t("analytics.coverageHealth")}</h3><p>{t("analytics.coverageHealthHelp")}</p></div><span className="badge">{t("analytics.run", { run: data.runNumber ?? "—" })}</span></div>
    <div className="health-summary-head"><strong>{data.totalSources}</strong><span>{t("analytics.coverageSources")}</span></div>
    <div className="health-rows">{rows.map(row => <div className={`health-row ${row.key}`} key={row.key} title={row.help}><span className="health-dot"/><span>{row.label}</span><b>{row.value}</b></div>)}</div>
    <p className="health-footnote">{t("analytics.healthFootnote")}</p>
  </article>;
}
