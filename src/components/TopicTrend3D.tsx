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
  const view = useRef({ yaw: 0.16, pitch: 0.42, zoom: 1 });
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
      const base = Math.min(width * 0.29, height * 0.54) * zoom;
      const centerX = width * 0.56;
      const centerY = height * 0.69;

      return (x: number, y: number, z: number) => {
        const rx = x * cosY - y * sinY;
        const ry = x * sinY + y * cosY;
        const py = ry * cosP - z * sinP;
        const depth = ry * sinP + z * cosP;
        const perspective = 1 / Math.max(0.84, 1 + depth * 0.055);
        return {
          x: centerX + rx * base * perspective,
          y: centerY + py * base * perspective,
          depth,
        };
      };
    };

    const normalizedX = (index: number) => model.buckets.length <= 1 ? 0 : -1.48 + (index / (model.buckets.length - 1)) * 2.96;
    const normalizedY = (index: number) => model.categories.length <= 1 ? 0 : -0.78 + (index / (model.categories.length - 1)) * 1.56;
    const normalizedZ = (value: number) => (value / model.max) * 1.02;

    const smoothPath = (points: Array<{ x: number; y: number }>) => {
      if (!points.length) return;
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      if (points.length === 1) return;
      for (let index = 0; index < points.length - 1; index += 1) {
        const current = points[index];
        const next = points[index + 1];
        const midX = (current.x + next.x) / 2;
        const midY = (current.y + next.y) / 2;
        context.quadraticCurveTo(current.x, current.y, midX, midY);
      }
      const last = points[points.length - 1];
      context.lineTo(last.x, last.y);
    };

    const draw = () => {
      if (disposed) return;
      const { width, height } = resizeCanvas();
      const project = projectFactory(width, height);
      context.clearRect(0, 0, width, height);
      screenPoints.current = [];

      const floorZ = 0;

      // Calm floor grid: fewer guide lines, low contrast.
      context.save();
      context.lineWidth = 1;
      context.strokeStyle = "rgba(130, 176, 184, 0.17)";
      const gridEvery = Math.max(1, Math.ceil(model.buckets.length / 10));
      for (let i = 0; i < model.buckets.length; i += gridEvery) {
        const a = project(normalizedX(i), -0.92, floorZ);
        const b = project(normalizedX(i), 0.92, floorZ);
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
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
        const laneY = normalizedY(categoryIndex);
        const linePoints = values.map((count, bucketIndex) => project(normalizedX(bucketIndex), laneY, normalizedZ(count)));
        const floorPoints = values.map((_, bucketIndex) => project(normalizedX(bucketIndex), laneY, 0));

        // Translucent ribbon ("curtain") gives each topic a distinct 3D plane.
        context.save();
        const gradient = context.createLinearGradient(0, Math.min(...linePoints.map((p) => p.y)), 0, Math.max(...floorPoints.map((p) => p.y)));
        gradient.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.28)`);
        gradient.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.045)`);
        context.fillStyle = gradient;
        context.beginPath();
        context.moveTo(linePoints[0].x, linePoints[0].y);
        for (let index = 0; index < linePoints.length - 1; index += 1) {
          const current = linePoints[index];
          const next = linePoints[index + 1];
          const midX = (current.x + next.x) / 2;
          const midY = (current.y + next.y) / 2;
          context.quadraticCurveTo(current.x, current.y, midX, midY);
        }
        const lastLine = linePoints[linePoints.length - 1];
        context.lineTo(lastLine.x, lastLine.y);
        for (let index = floorPoints.length - 1; index >= 0; index -= 1) context.lineTo(floorPoints[index].x, floorPoints[index].y);
        context.closePath();
        context.fill();
        context.restore();

        // Lane baseline.
        const laneStart = project(normalizedX(0), laneY, 0);
        const laneEnd = project(normalizedX(Math.max(0, model.buckets.length - 1)), laneY, 0);
        context.save();
        context.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.24)`;
        context.lineWidth = 1;
        context.beginPath(); context.moveTo(laneStart.x, laneStart.y); context.lineTo(laneEnd.x, laneEnd.y); context.stroke();
        context.restore();

        // Average guide only once per lane, subtle and behind the main curve.
        const avgStart = project(normalizedX(0), laneY, normalizedZ(model.average));
        const avgEnd = project(normalizedX(Math.max(0, model.buckets.length - 1)), laneY, normalizedZ(model.average));
        context.save();
        context.strokeStyle = "rgba(243, 180, 85, 0.38)";
        context.lineWidth = 1.1;
        context.setLineDash([6, 7]);
        context.beginPath(); context.moveTo(avgStart.x, avgStart.y); context.lineTo(avgEnd.x, avgEnd.y); context.stroke();
        context.restore();

        // Smooth main curve.
        context.save();
        context.strokeStyle = color;
        context.lineWidth = 3;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`;
        context.shadowBlur = 8;
        smoothPath(linePoints);
        context.stroke();
        context.restore();

        // Show only meaningful markers to reduce clutter; all points remain interactive.
        values.forEach((count, bucketIndex) => {
          const p = linePoints[bucketIndex];
          const point: ScreenPoint = { x: p.x, y: p.y, category, bucket: model.buckets[bucketIndex], count };
          screenPoints.current.push(point);
          const prev = bucketIndex > 0 ? values[bucketIndex - 1] : count;
          const next = bucketIndex < values.length - 1 ? values[bucketIndex + 1] : count;
          const localPeak = count > 0 && count >= prev && count >= next;
          const endpoint = bucketIndex === 0 || bucketIndex === values.length - 1;
          if (!localPeak && !endpoint) return;
          context.save();
          context.fillStyle = "#f8fbfc";
          context.strokeStyle = color;
          context.lineWidth = 2;
          context.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.32)`;
          context.shadowBlur = 6;
          context.beginPath(); context.arc(p.x, p.y, 4.2, 0, Math.PI * 2); context.fill(); context.stroke();
          context.restore();
        });

        // Topic label as a pill attached to the lane.
        const labelPoint = project(normalizedX(0) - 0.1, laneY, 0);
        const label = compactCategory(localizeDataLabel(category, locale, "category"));
        context.save();
        context.font = "600 9px sans-serif";
        context.textAlign = "right";
        const labelWidth = Math.min(190, context.measureText(label).width + 16);
        const left = labelPoint.x - labelWidth - 10;
        const top = labelPoint.y - 10;
        context.fillStyle = "rgba(10, 42, 50, 0.72)";
        context.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.48)`;
        context.lineWidth = 1;
        context.beginPath();
        context.roundRect(left, top, labelWidth, 20, 7);
        context.fill(); context.stroke();
        context.fillStyle = "#e6f0f2";
        context.fillText(label, labelPoint.x - 18, labelPoint.y + 3);
        context.fillStyle = color;
        context.beginPath(); context.arc(labelPoint.x - 9, labelPoint.y, 3, 0, Math.PI * 2); context.fill();
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
        view.current.yaw = Math.max(-0.12, Math.min(0.38, view.current.yaw + dx * 0.0035));
        view.current.pitch = Math.max(0.30, Math.min(0.58, view.current.pitch + dy * 0.003));
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
