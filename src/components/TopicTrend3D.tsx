import { useEffect, useMemo, useRef, useState } from "react";
import type { PublicationSummary, TopicTrendPoint } from "../types";
import { useI18n } from "../i18n";
import { localizeDataLabel } from "../dataLabels";
import { desktopApi } from "../api";

const TOPIC_COLORS = ["#1685D1", "#F06431", "#20AE70", "#B764D9"];

type Selection = { category: string; bucket: string };
type Preview = Selection & { x: number; y: number; items: PublicationSummary[] | null };
type ScreenPoint = Selection & { x: number; y: number; count: number };

function compactCategory(value: string) {
  return value.length > 25 ? `${value.slice(0, 23)}…` : value;
}

function parseHex(hex: string) {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

export function TopicTrend3D({ data, onSelect }: { data: TopicTrendPoint[]; onSelect: (selection: Selection) => void }) {
  const { t, locale } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewCache = useRef(new Map<string, PublicationSummary[]>());
  const hoveredKey = useRef<string | null>(null);
  const screenPoints = useRef<ScreenPoint[]>([]);
  const view = useRef({ yaw: 0.5, pitch: 0.58, zoom: 1 });
  const drag = useRef<{ active: boolean; x: number; y: number } | null>(null);
  const redrawRef = useRef<() => void>(() => undefined);
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
    const canvas = canvasRef.current;
    if (!canvas || !model.cells.length) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let disposed = false;
    const observer = new ResizeObserver(() => redrawRef.current());

    const clearPreviewTimer = () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    };

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const width = Math.max(320, Math.round(rect.width));
      const height = Math.max(280, Math.round(rect.height));
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { width, height };
    };

    const projectFactory = (width: number, height: number) => {
      const { yaw, pitch, zoom } = view.current;
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
      const base = Math.min(width, height) * 0.31 * zoom;
      const centerX = width * 0.52;
      const centerY = height * 0.58;

      return (x: number, y: number, z: number) => {
        const rx = x * cosY - y * sinY;
        const ry = x * sinY + y * cosY;
        const py = ry * cosP - z * sinP;
        const depth = ry * sinP + z * cosP;
        const perspective = 1 / Math.max(0.72, 1 + depth * 0.11);
        return {
          x: centerX + rx * base * perspective,
          y: centerY + py * base * perspective,
          depth,
        };
      };
    };

    const normalizedX = (index: number) => model.buckets.length <= 1 ? 0 : -1.25 + (index / (model.buckets.length - 1)) * 2.5;
    const normalizedY = (index: number) => model.categories.length <= 1 ? 0 : -0.82 + (index / (model.categories.length - 1)) * 1.64;
    const normalizedZ = (value: number) => (value / model.max) * 1.45;

    const draw = () => {
      if (disposed) return;
      const { width, height } = resizeCanvas();
      const project = projectFactory(width, height);
      context.clearRect(0, 0, width, height);
      screenPoints.current = [];

      const floorZ = 0;
      context.save();
      context.lineWidth = 1;
      context.strokeStyle = "rgba(118, 166, 176, 0.28)";
      for (let i = 0; i < model.buckets.length; i += 1) {
        const a = project(normalizedX(i), -0.95, floorZ);
        const b = project(normalizedX(i), 0.95, floorZ);
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
      for (let j = 0; j < model.categories.length; j += 1) {
        const a = project(-1.35, normalizedY(j), floorZ);
        const b = project(1.35, normalizedY(j), floorZ);
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
      context.restore();

      // Z axis + ticks.
      const axisBase = project(-1.38, -0.96, 0);
      const axisTop = project(-1.38, -0.96, 1.5);
      context.save();
      context.strokeStyle = "rgba(190, 218, 224, 0.72)";
      context.fillStyle = "#cfe4e8";
      context.lineWidth = 1.2;
      context.font = "9px sans-serif";
      context.beginPath(); context.moveTo(axisBase.x, axisBase.y); context.lineTo(axisTop.x, axisTop.y); context.stroke();
      for (let step = 0; step <= 4; step += 1) {
        const value = model.max * step / 4;
        const p = project(-1.38, -0.96, normalizedZ(value));
        context.beginPath(); context.moveTo(p.x - 4, p.y); context.lineTo(p.x + 4, p.y); context.stroke();
        context.fillText(String(Math.round(value)), p.x - 28, p.y + 3);
      }
      context.restore();

      const orderedCategories = model.categories.map((category, categoryIndex) => {
        const mid = project(0, normalizedY(categoryIndex), 0);
        return { category, categoryIndex, depth: mid.depth };
      }).sort((a, b) => a.depth - b.depth);

      for (const { category, categoryIndex } of orderedCategories) {
        const color = TOPIC_COLORS[categoryIndex % TOPIC_COLORS.length];
        const rgb = parseHex(color);
        const values = model.buckets.map((bucket) => model.cells.find((point) => point.bucket === bucket && point.category === category)?.count ?? 0);

        // Average reference for each topic row.
        const avgStart = project(normalizedX(0), normalizedY(categoryIndex), normalizedZ(model.average));
        const avgEnd = project(normalizedX(Math.max(0, model.buckets.length - 1)), normalizedY(categoryIndex), normalizedZ(model.average));
        context.save();
        context.strokeStyle = "rgba(243, 180, 85, 0.5)";
        context.lineWidth = 1.3;
        context.setLineDash([5, 5]);
        context.beginPath(); context.moveTo(avgStart.x, avgStart.y); context.lineTo(avgEnd.x, avgEnd.y); context.stroke();
        context.restore();

        // Main trend line.
        context.save();
        context.strokeStyle = color;
        context.lineWidth = 3.2;
        context.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.42)`;
        context.shadowBlur = 7;
        context.beginPath();
        values.forEach((count, bucketIndex) => {
          const p = project(normalizedX(bucketIndex), normalizedY(categoryIndex), normalizedZ(count));
          if (bucketIndex === 0) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y);
        });
        context.stroke();
        context.restore();

        values.forEach((count, bucketIndex) => {
          const p = project(normalizedX(bucketIndex), normalizedY(categoryIndex), normalizedZ(count));
          const point: ScreenPoint = { x: p.x, y: p.y, category, bucket: model.buckets[bucketIndex], count };
          screenPoints.current.push(point);
          context.save();
          context.fillStyle = color;
          context.strokeStyle = "rgba(255,255,255,0.82)";
          context.lineWidth = 1.3;
          context.beginPath(); context.arc(p.x, p.y, count > 0 ? 4.4 : 2.4, 0, Math.PI * 2); context.fill(); context.stroke();
          context.restore();
        });

        const labelPoint = project(normalizedX(0) - 0.1, normalizedY(categoryIndex), 0);
        context.save();
        context.font = "600 9px sans-serif";
        context.fillStyle = "#d6e5e8";
        context.textAlign = "right";
        context.fillText(compactCategory(localizeDataLabel(category, locale, "category")), labelPoint.x - 8, labelPoint.y + 3);
        context.restore();
      }

      // Date labels along X.
      const every = Math.max(1, Math.ceil(model.buckets.length / 7));
      context.save();
      context.font = "8px sans-serif";
      context.fillStyle = "#b9d0d5";
      context.textAlign = "center";
      model.buckets.forEach((bucket, index) => {
        if (index % every !== 0 && index !== model.buckets.length - 1) return;
        const p = project(normalizedX(index), 0.98, 0);
        context.fillText(bucket.slice(5), p.x, p.y + 14);
      });
      context.restore();
    };

    redrawRef.current = draw;
    observer.observe(canvas);
    draw();

    const nearestPoint = (x: number, y: number) => {
      let nearest: ScreenPoint | null = null;
      let best = 13 * 13;
      for (const point of screenPoints.current) {
        if (point.count <= 0) continue;
        const dx = point.x - x, dy = point.y - y;
        const distance = dx * dx + dy * dy;
        if (distance < best) { best = distance; nearest = point; }
      }
      return nearest;
    };

    const previewPosition = (x: number, y: number) => {
      const width = canvas.clientWidth, height = canvas.clientHeight;
      return {
        x: Math.max(12, Math.min(x + 14, Math.max(12, width - 328))),
        y: Math.max(42, Math.min(y + 14, Math.max(42, height - 210))),
      };
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
      }, 220);
    };

    const onPointerDown = (event: PointerEvent) => {
      drag.current = { active: true, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      clearPreviewTimer(); hoveredKey.current = null; setPreview(null);
    };
    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      if (drag.current?.active) {
        const dx = event.clientX - drag.current.x;
        const dy = event.clientY - drag.current.y;
        drag.current.x = event.clientX; drag.current.y = event.clientY;
        view.current.yaw += dx * 0.009;
        view.current.pitch = Math.max(0.28, Math.min(0.95, view.current.pitch + dy * 0.006));
        draw();
        return;
      }
      const point = nearestPoint(x, y);
      canvas.style.cursor = point ? "pointer" : "grab";
      if (!point) {
        clearPreviewTimer(); hoveredKey.current = null; setPreview(null);
        return;
      }
      const key = `${point.bucket}\u0000${point.category}`;
      if (hoveredKey.current === key) return;
      schedulePreview(point, previewPosition(x, y));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (drag.current) drag.current.active = false;
      try { canvas.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
    };
    const onClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const point = nearestPoint(event.clientX - rect.left, event.clientY - rect.top);
      if (point) onSelect({ category: point.category, bucket: point.bucket });
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      view.current.zoom = Math.max(0.75, Math.min(1.5, view.current.zoom * (event.deltaY > 0 ? 0.94 : 1.06)));
      draw();
    };
    const onLeave = () => {
      if (drag.current) drag.current.active = false;
      clearPreviewTimer(); hoveredKey.current = null; setPreview(null);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerleave", onLeave);

    return () => {
      disposed = true;
      clearPreviewTimer();
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [locale, model, onSelect]);

  if (!data.length) return <div className="chart-empty">{t("common.notEnough")}</div>;

  return <div className="topic-3d-wrap">
    <div className="topic-3d-help">{t("chart.topic3dHelp")}</div>
    <div className="topic-3d-legend">{model.categories.map((category, index) => <span key={category}><i style={{ background: TOPIC_COLORS[index % TOPIC_COLORS.length] }} />{localizeDataLabel(category, locale, "category")}</span>)}</div>
    <div className="topic-3d-average"><i />{t("chart.averagePlane")}: <b>{model.average.toFixed(1)}</b></div>
    <canvas ref={canvasRef} className="topic-3d-chart" role="img" aria-label={t("chart.topic3d")} />
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
