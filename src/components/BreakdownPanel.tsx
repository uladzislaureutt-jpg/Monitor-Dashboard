import { useState } from "react";
import type { CountPoint, PeriodDays } from "../types";
import { useI18n } from "../i18n";
import { BelarusRegionTreemap, PieChart, RankBars } from "./Charts";
import { PeriodSelector } from "./PeriodSelector";

type Mode = "bars" | "pie" | "map";

export function BreakdownPanel({
  title,
  subtitle,
  data,
  maxItems = 8,
  allowMap = false,
  className = "",
  period,
  onPeriodChange,
}: {
  title: string;
  subtitle: string;
  data: CountPoint[];
  maxItems?: number;
  allowMap?: boolean;
  className?: string;
  period?: PeriodDays;
  onPeriodChange?: (value: PeriodDays) => void;
}) {
  const [mode, setMode] = useState<Mode>("bars");
  const { t } = useI18n();
  const displayData = allowMap
    ? data.map((item) => item.label.trim().toLocaleLowerCase("ru-RU").startsWith("не определ") || item.label.trim().toLocaleLowerCase("be-BY").startsWith("не вызнач")
      ? { ...item, label: t("geo.allBelarus") }
      : item)
    : data;
  const modes: Array<{ key: Mode; label: string }> = allowMap
    ? [{ key: "bars", label: t("chart.columns") }, { key: "pie", label: t("chart.sectors") }, { key: "map", label: t("chart.scheme") }]
    : [{ key: "bars", label: t("chart.columns") }, { key: "pie", label: t("chart.sectors") }];

  return <article className={`panel chart-panel ${className}`.trim()}>
    <div className="panel-head chart-head-with-mode">
      <div><h3>{title}</h3><p>{subtitle}</p></div>
      <div className="panel-control-stack">
        {period !== undefined && onPeriodChange && <PeriodSelector value={period} onChange={onPeriodChange} compact />}
        <div className="chart-mode-switch" aria-label={t("chart.kind", { title })}>
          {modes.map((item) => <button key={item.key} className={mode === item.key ? "active" : ""} onClick={() => setMode(item.key)}>{item.label}</button>)}
        </div>
      </div>
    </div>
    {mode === "bars" && <RankBars data={displayData} maxItems={maxItems} />}
    {mode === "pie" && <PieChart data={displayData} maxItems={maxItems} />}
    {mode === "map" && <BelarusRegionTreemap data={data} />}
  </article>;
}
