import { useState } from "react";
import type { CountPoint, PeriodDays } from "../types";
import { useI18n } from "../i18n";
import { RankBars } from "./Charts";
import { PeriodSelector } from "./PeriodSelector";
type InsightMode = "concepts" | "people";
export function InsightsPanel({ concepts, people, period, onPeriodChange }: { concepts: CountPoint[]; people: CountPoint[]; period: PeriodDays; onPeriodChange: (value: PeriodDays) => void; }) {
  const { t } = useI18n(); const [mode, setMode] = useState<InsightMode>("concepts"); const data = mode === "concepts" ? concepts : people;
  return <article className="panel chart-panel insights-panel"><div className="panel-head chart-head-with-mode"><div><h3>{t("dashboard.insights")}</h3><p>{t("dashboard.insightsHelp")}</p></div><div className="panel-control-stack"><PeriodSelector value={period} onChange={onPeriodChange} compact /><div className="chart-mode-switch" aria-label={t("dashboard.insights")}><button className={mode === "concepts" ? "active" : ""} onClick={() => setMode("concepts")}>{t("dashboard.concepts")}</button><button className={mode === "people" ? "active" : ""} onClick={() => setMode("people")}>{t("dashboard.people")}</button></div></div></div><RankBars data={data} maxItems={8} /></article>;
}
