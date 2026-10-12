import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import "echarts-gl";
import type { PublicationSummary, TopicTrendPoint } from "../types";
import { useI18n } from "../i18n";
import { localizeDataLabel } from "../dataLabels";
import { desktopApi } from "../api";

const TOPIC_COLORS = ["#1685D1", "#F06431", "#20AE70", "#B764D9"];

type Selection = { category: string; bucket: string };
type Preview = Selection & { x: number; y: number; items: PublicationSummary[] | null };

function interpolate(values: number[], position: number) {
  const left = Math.max(0, Math.floor(position));
  const right = Math.min(values.length - 1, Math.ceil(position));
  if (left === right) return values[left] ?? 0;
  const progress = position - left;
  return (values[left] ?? 0) + ((values[right] ?? 0) - (values[left] ?? 0)) * progress;
}

function compactCategory(value: string) {
  return value.length > 25 ? `${value.slice(0, 23)}…` : value;
}

export function TopicTrend3D({ data, onSelect }: { data: TopicTrendPoint[]; onSelect: (selection: Selection) => void }) {
  const { t, locale } = useI18n();
  const host = useRef<HTMLDivElement | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewCache = useRef(new Map<string, PublicationSummary[]>());
  const hoveredKey = useRef<string | null>(null);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
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
    let disposed = false;
    try {
      chart = echarts.init(host.current, undefined, { renderer: "canvas" });
    } catch {
      setWebglUnavailable(true);
      return;
    }

    const zMax = Math.max(1, Math.ceil(model.max * 1.16));
    const averagePlane = model.buckets.flatMap((_, bucketIndex) => model.categories.map((__, categoryIndex) => [bucketIndex, categoryIndex, model.average]));
    const categoryValues = model.categories.map((category) => model.buckets.map((bucket) => model.cells.find((point) => point.bucket === bucket && point.category === category)?.count ?? 0));
    const option = {
      backgroundColor: "#163842",
      // Карточки ниже управляются React-компонентом. Стандартный tooltip
      // ECharts выключен, чтобы он не перекрывал эти карточки.
      tooltip: { show: false },
      xAxis3D: {
        type: "value",
        min: -0.5,
        max: Math.max(0.5, model.buckets.length - 0.5),
        interval: 1,
        name: t("chart.dateAxis"),
        axisLabel: { color: "#d6e5e8", formatter: (value: number) => model.buckets[Math.round(value)]?.slice(5) ?? "" },
        axisLine: { lineStyle: { color: "#9ab8c0" } },
        splitLine: { lineStyle: { color: "#456871", opacity: 0.72 } },
      },
      yAxis3D: {
        type: "value",
        min: -0.5,
        max: Math.max(0.5, model.categories.length - 0.5),
        interval: 1,
        name: t("chart.topicAxis"),
        axisLabel: { color: "#d6e5e8", formatter: (value: number) => compactCategory(localizeDataLabel(model.categories[Math.round(value)] ?? "", locale, "category")) },
        axisLine: { lineStyle: { color: "#9ab8c0" } },
        splitLine: { lineStyle: { color: "#456871", opacity: 0.72 } },
      },
      zAxis3D: {
        type: "value",
        min: 0,
        max: zMax,
        name: t("chart.publications"),
        axisLabel: { color: "#d6e5e8" },
        axisLine: { lineStyle: { color: "#9ab8c0" } },
        splitLine: { lineStyle: { color: "#456871", opacity: 0.72 } },
      },
      grid3D: {
        boxWidth: Math.max(100, model.buckets.length * 12),
        boxDepth: Math.max(78, model.categories.length * 26),
        boxHeight: 102,
        environment: "#163842",
        viewControl: {
          projection: "perspective",
          alpha: 24,
          beta: 38,
          distance: 165,
          minDistance: 90,
          maxDistance: 285,
          rotateSensitivity: 1,
          zoomSensitivity: 1,
          panSensitivity: 0,
        },
        light: { main: { intensity: 1.22, shadow: true }, ambient: { intensity: 0.64 } },
      },
      series: [
        {
          name: t("chart.averagePlane"),
          type: "surface",
          silent: true,
          shading: "color",
          data: averagePlane,
          itemStyle: { color: "#F3B455", opacity: 0.12 },
          wireframe: { show: false },
        },
        ...model.categories.flatMap((category, categoryIndex) => {
          const values = categoryValues[categoryIndex];
          const color = TOPIC_COLORS[categoryIndex % TOPIC_COLORS.length];
          return [
            {
              name: category,
              type: "surface",
              parametric: true,
              silent: true,
              shading: "color",
              parametricEquation: {
                u: { min: 0, max: Math.max(0, model.buckets.length - 1), step: 0.1 },
                v: { min: 0, max: 1, step: 1 },
                x: (u: number) => u,
                y: () => categoryIndex,
                z: (u: number, v: number) => interpolate(values, u) * v,
              },
              itemStyle: { color, opacity: 0.2 },
              wireframe: { show: false },
            },
            {
              name: category,
              type: "line3D",
              silent: true,
              lineStyle: { color, width: 4, opacity: 1 },
              data: values.map((count, bucketIndex) => [bucketIndex, categoryIndex, count]),
            },
            {
              name: category,
              type: "scatter3D",
              symbolSize: 9,
              itemStyle: { color, opacity: 1 },
              data: values.map((count, bucketIndex) => ({
                value: [bucketIndex, categoryIndex, count],
                bucket: model.buckets[bucketIndex],
                category,
                count,
              })),
            },
          ];
        }),
      ],
    };
    chart.setOption(option as never);
    const selectionFrom = (params: { seriesType?: string; data?: unknown }): (Selection & { count: number }) | null => {
      const point = params.data as { bucket?: string; category?: string } | null;
      const count = Number((point as { count?: number } | null)?.count ?? 0);
      if (params.seriesType !== "scatter3D" || !point?.bucket || !point.category || count <= 0) return null;
      return { bucket: point.bucket, category: point.category, count };
    };
    const clearPreviewTimer = () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    };
    const previewPosition = (event: unknown) => {
      const pointer = event as { offsetX?: number; offsetY?: number } | undefined;
      const width = host.current?.clientWidth ?? 0;
      const height = host.current?.clientHeight ?? 0;
      const x = pointer?.offsetX ?? width * 0.54;
      const y = pointer?.offsetY ?? height * 0.42;
      return { x: Math.max(12, Math.min(x + 14, Math.max(12, width - 328))), y: Math.max(42, Math.min(y + 14, Math.max(42, height - 210))) };
    };
    const schedulePreview = (selection: Selection, position: { x: number; y: number }) => {
      clearPreviewTimer();
      const key = `${selection.bucket}\u0000${selection.category}`;
      hoveredKey.current = key;
      previewTimer.current = window.setTimeout(() => {
        const cached = previewCache.current.get(key);
        if (cached) {
          setPreview({ ...selection, ...position, items: cached });
          return;
        }
        setPreview({ ...selection, ...position, items: null });
        desktopApi.topicBucketPublications(selection.category, selection.bucket, 3)
          .then((items) => {
            previewCache.current.set(key, items);
            if (!disposed && hoveredKey.current === key) setPreview({ ...selection, ...position, items });
          })
          .catch(() => {
            if (!disposed && hoveredKey.current === key) setPreview({ ...selection, ...position, items: [] });
          });
      }, 260);
    };
    chart.on("click", (params) => {
      const selection = selectionFrom(params);
      if (selection) onSelect(selection);
    });
    chart.on("mouseover", (params) => {
      const selection = selectionFrom(params);
      if (selection) schedulePreview(selection, previewPosition(params.event));
    });
    chart.on("mouseout", (params) => {
      if (params.seriesType !== "scatter3D") return;
      clearPreviewTimer();
      hoveredKey.current = null;
      setPreview(null);
    });
    chart.on("globalout", () => {
      clearPreviewTimer();
      hoveredKey.current = null;
      setPreview(null);
    });
    const resize = () => chart.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    return () => { disposed = true; clearPreviewTimer(); observer.disconnect(); chart.dispose(); };
  }, [locale, model, onSelect, t]);

  if (!data.length) return <div className="chart-empty">{t("common.notEnough")}</div>;
  if (webglUnavailable) return <div className="chart-empty">{t("chart.webglUnavailable")}</div>;
  return <div className="topic-3d-wrap">
    <div className="topic-3d-help">{t("chart.topic3dHelp")}</div>
    <div className="topic-3d-legend">{model.categories.map((category, index) => <span key={category}><i style={{ background: TOPIC_COLORS[index % TOPIC_COLORS.length] }} />{localizeDataLabel(category, locale, "category")}</span>)}</div>
    <div className="topic-3d-average"><i />{t("chart.averagePlane")}: <b>{model.average.toFixed(1)}</b></div>
    <div ref={host} className="topic-3d-chart" role="img" aria-label={t("chart.topic3d")} />
    {preview && <aside className="topic-3d-preview" style={{ left: preview.x, top: preview.y }} aria-live="polite">
      <div className="topic-3d-preview-head"><b>{localizeDataLabel(preview.category, locale, "category")}</b><span>{preview.bucket}</span></div>
      {preview.items === null
        ? <div className="topic-3d-preview-status">{t("chart.hoverPreviewLoading")}</div>
        : preview.items.length
          ? <div className="topic-3d-preview-list">{preview.items.map((item) => <article key={item.id} className="topic-3d-preview-card"><span>{item.source}</span><strong>{item.title}</strong></article>)}</div>
          : <div className="topic-3d-preview-status">{t("chart.noPointPublications")}</div>}
      <div className="topic-3d-preview-foot">{t("chart.hoverPreviewHint")}</div>
    </aside>}
  </div>;
}
