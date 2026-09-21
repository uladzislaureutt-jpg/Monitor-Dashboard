import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import "echarts-gl";
import type { TopicTrendPoint } from "../types";
import { useI18n } from "../i18n";
import { localizeDataLabel } from "../dataLabels";

const TOPIC_COLORS = ["#2f6f98", "#a35b46", "#6c8c58", "#8a6b9c"];

type Selection = { category: string; bucket: string };

function tooltipText(value: string) {
  return value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[character] ?? character));
}

export function TopicTrend3D({ data, onSelect }: { data: TopicTrendPoint[]; onSelect: (selection: Selection) => void }) {
  const { t, locale } = useI18n();
  const host = useRef<HTMLDivElement | null>(null);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const model = useMemo(() => {
    const buckets = Array.from(new Set(data.map((point) => point.bucket))).sort();
    const categories = Array.from(new Set(data.map((point) => point.category))).slice(0, 4);
    const counts = new Map(data.map((point) => [`${point.bucket}\u0000${point.category}`, point.count]));
    const cells = buckets.flatMap((bucket, bucketIndex) => categories.map((category, categoryIndex) => ({
      bucket,
      bucketIndex,
      category,
      categoryIndex,
      count: counts.get(`${bucket}\u0000${category}`) ?? 0,
    })));
    const average = cells.length ? cells.reduce((sum, point) => sum + point.count, 0) / cells.length : 0;
    return { buckets, categories, cells, average, max: Math.max(1, ...cells.map((point) => point.count), average) };
  }, [data]);

  useEffect(() => {
    if (!host.current || !model.cells.length) return;
    if (!window.WebGLRenderingContext) {
      setWebglUnavailable(true);
      return;
    }
    let chart: echarts.ECharts;
    try {
      chart = echarts.init(host.current, undefined, { renderer: "canvas" });
    } catch {
      setWebglUnavailable(true);
      return;
    }

    const zMax = Math.max(1, Math.ceil(model.max * 1.18));
    const plane = model.buckets.flatMap((_, bucketIndex) => model.categories.map((__, categoryIndex) => [bucketIndex, categoryIndex, model.average]));
    const option = {
      backgroundColor: "transparent",
      tooltip: {
        formatter: (params: { seriesName?: string; data?: { bucket?: string; category?: string; count?: number } }) => {
          if (params.seriesName === t("chart.averagePlane")) {
            return `${t("chart.average")}: <b>${model.average.toFixed(1)}</b>`;
          }
          const point = params.data;
          if (!point?.bucket || !point.category) return "";
          return `<b>${tooltipText(point.bucket)}</b><br/>${tooltipText(localizeDataLabel(point.category, locale, "category"))}: <b>${point.count ?? 0}</b> ${t("chart.publications")}`;
        },
      },
      xAxis3D: {
        type: "value",
        min: -0.5,
        max: Math.max(0.5, model.buckets.length - 0.5),
        interval: 1,
        name: t("chart.dateAxis"),
        axisLabel: { formatter: (value: number) => model.buckets[Math.round(value)]?.slice(5) ?? "" },
        axisLine: { lineStyle: { color: "#9aa9b2" } },
      },
      yAxis3D: {
        type: "value",
        min: -0.5,
        max: Math.max(0.5, model.categories.length - 0.5),
        interval: 1,
        name: t("chart.topicAxis"),
        axisLabel: { formatter: (value: number) => localizeDataLabel(model.categories[Math.round(value)] ?? "", locale, "category") },
        axisLine: { lineStyle: { color: "#9aa9b2" } },
      },
      zAxis3D: {
        type: "value",
        min: 0,
        max: zMax,
        name: t("chart.publications"),
        axisLine: { lineStyle: { color: "#9aa9b2" } },
      },
      grid3D: {
        boxWidth: Math.max(90, model.buckets.length * 12),
        boxDepth: Math.max(68, model.categories.length * 23),
        boxHeight: 95,
        environment: "#fbf8f3",
        viewControl: {
          projection: "perspective",
          alpha: 22,
          beta: 32,
          distance: 155,
          minDistance: 90,
          maxDistance: 260,
          rotateSensitivity: 1,
          zoomSensitivity: 1,
          panSensitivity: 0,
        },
        light: { main: { intensity: 1.15, shadow: true }, ambient: { intensity: 0.55 } },
      },
      series: [
        {
          name: t("chart.averagePlane"),
          type: "surface",
          silent: true,
          shading: "color",
          data: plane,
          itemStyle: { color: "#d6a975", opacity: 0.24 },
          wireframe: { show: false },
        },
        {
          name: t("chart.topicLines"),
          type: "bar3D",
          shading: "lambert",
          bevelSize: 0.25,
          data: model.cells.map((point) => ({
            value: [point.bucketIndex, point.categoryIndex, point.count],
            bucket: point.bucket,
            category: point.category,
            count: point.count,
            itemStyle: { color: TOPIC_COLORS[point.categoryIndex % TOPIC_COLORS.length], opacity: point.count === 0 ? 0.12 : 0.92 },
          })),
        },
      ],
    };
    chart.setOption(option as never);
    chart.on("click", (params) => {
      const point = params.data as { bucket?: string; category?: string } | null;
      if (params.seriesType !== "bar3D" || !point?.bucket || !point.category) return;
      onSelect({ bucket: point.bucket, category: point.category });
    });
    const resize = () => chart.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [locale, model, onSelect, t]);

  if (!data.length) return <div className="chart-empty">{t("common.notEnough")}</div>;
  if (webglUnavailable) return <div className="chart-empty">{t("chart.webglUnavailable")}</div>;
  return <div className="topic-3d-wrap">
    <div className="topic-3d-help">{t("chart.topic3dHelp")}</div>
    <div className="topic-3d-average"><i />{t("chart.averagePlane")}: <b>{model.average.toFixed(1)}</b></div>
    <div ref={host} className="topic-3d-chart" role="img" aria-label={t("chart.topic3d")} />
  </div>;
}
