import { useState } from "react";
import type { CountPoint, PeriodDays } from "../types";
import { useI18n } from "../i18n";
import { localizeBreakdown, type DataLabelKind } from "../dataLabels";
import { BelarusRegionTreemap, CountryTreemap, PieChart, RankBars } from "./Charts";
import { PeriodSelector } from "./PeriodSelector";

type Mode = "bars" | "pie" | "map";
type Scheme = "belarus_regions" | "source_countries";

export function BreakdownPanel({ title, subtitle, data, maxItems = 8, allowMap = false, scheme, initialMode = "bars", className = "", controlsClassName = "", period, onPeriodChange, labelKind, sourceIcons = false, }: { title: string; subtitle: string; data: CountPoint[]; maxItems?: number; allowMap?: boolean; scheme?: Scheme; initialMode?: Mode; className?: string; controlsClassName?: string; period?: PeriodDays; onPeriodChange?: (value: PeriodDays) => void; labelKind?: DataLabelKind; sourceIcons?: boolean; }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const { t, locale } = useI18n();
  const localized = labelKind ? localizeBreakdown(data, locale, labelKind) : data;
  const activeScheme = scheme ?? (allowMap ? "belarus_regions" : undefined);
  const displayData = activeScheme === "belarus_regions" ? localized.map((item) => item.label.trim().toLocaleLowerCase(locale === "be" ? "be-BY" : "ru-RU").startsWith(locale === "be" ? "не вызнач" : "не определ") ? { ...item, label: t("geo.allBelarus") } : item) : localized;
  const persistentCountryScheme = activeScheme === "source_countries";
  const modes: Array<{ key: Mode; label: string }> = persistentCountryScheme
    ? [{ key: "bars", label: t("chart.columns") }, { key: "pie", label: t("chart.sectors") }]
    : activeScheme
      ? [{ key: "bars", label: t("chart.columns") }, { key: "pie", label: t("chart.sectors") }, { key: "map", label: t("chart.scheme") }]
      : [{ key: "bars", label: t("chart.columns") }, { key: "pie", label: t("chart.sectors") }];
  return <article className={`panel chart-panel ${className}`.trim()}><div className="panel-head chart-head-with-mode"><div><h3>{title}</h3><p>{subtitle}</p></div><div className={`panel-control-stack ${controlsClassName}`.trim()}>{period !== undefined && onPeriodChange && <PeriodSelector value={period} onChange={onPeriodChange} compact />}<div className="chart-mode-switch" aria-label={t("chart.kind", { title })}>{modes.map((item) => <button key={item.key} className={mode === item.key ? "active" : ""} onClick={() => setMode(item.key)}>{item.label}</button>)}</div></div></div>{mode === "bars" && <RankBars data={displayData} maxItems={maxItems} withIcons={sourceIcons} />}{mode === "pie" && <PieChart data={displayData} maxItems={maxItems} />}{mode === "map" && activeScheme === "belarus_regions" && <BelarusRegionTreemap data={data} />}{persistentCountryScheme && <div className="persistent-country-scheme"><CountryTreemap data={displayData} /></div>}</article>;
}
