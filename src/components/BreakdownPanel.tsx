import { useState } from "react";
import type { CountPoint } from "../types";
import { BelarusRegionMap, PieChart, RankBars } from "./Charts";

type Mode = "bars" | "pie" | "map";

export function BreakdownPanel({
  title,
  subtitle,
  data,
  maxItems = 8,
  allowMap = false,
  className = "",
}: {
  title: string;
  subtitle: string;
  data: CountPoint[];
  maxItems?: number;
  allowMap?: boolean;
  className?: string;
}) {
  const [mode, setMode] = useState<Mode>("bars");
  const modes: Array<{ key: Mode; label: string }> = allowMap
    ? [{ key: "bars", label: "Столбцы" }, { key: "pie", label: "Сектора" }, { key: "map", label: "Карта" }]
    : [{ key: "bars", label: "Столбцы" }, { key: "pie", label: "Сектора" }];

  return <article className={`panel chart-panel ${className}`.trim()}>
    <div className="panel-head chart-head-with-mode">
      <div><h3>{title}</h3><p>{subtitle}</p></div>
      <div className="chart-mode-switch" aria-label={`Вид диаграммы: ${title}`}>
        {modes.map((item) => <button key={item.key} className={mode === item.key ? "active" : ""} onClick={() => setMode(item.key)}>{item.label}</button>)}
      </div>
    </div>
    {mode === "bars" && <RankBars data={data} maxItems={maxItems} />}
    {mode === "pie" && <PieChart data={data} maxItems={maxItems} />}
    {mode === "map" && <BelarusRegionMap data={data} />}
  </article>;
}
