import type { CountPoint } from "../types";

function compact(value: number) {
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function TrendColumns({ data }: { data: CountPoint[] }) {
  if (!data.length) return <div className="chart-empty">Недостаточно данных для графика.</div>;
  const width = 760;
  const height = 245;
  const padX = 40;
  const padTop = 24;
  const padBottom = 34;
  const plotHeight = height - padTop - padBottom;
  const max = Math.max(1, ...data.map((point) => point.count));
  const average = data.reduce((sum, point) => sum + point.count, 0) / data.length;
  const band = (width - padX * 2) / Math.max(1, data.length);
  const barWidth = Math.max(3, Math.min(38, band * 0.62));
  const y = (value: number) => padTop + plotHeight - (value / max) * plotHeight;
  const every = Math.max(1, Math.ceil(data.length / 8));
  const avgY = y(average);

  return (
    <div className="trend-chart" aria-label="Динамика публикаций">
      <div className="trend-summary"><span>Среднее за период</span><b>{average.toFixed(1)}</b></div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const yy = padTop + ratio * plotHeight;
          const label = Math.round(max * (1 - ratio));
          return (
            <g key={ratio}>
              <line x1={padX} y1={yy} x2={width - padX} y2={yy} className="chart-grid" />
              <text x={5} y={yy + 4} className="chart-axis">{compact(label)}</text>
            </g>
          );
        })}
        {data.map((point, index) => {
          const x = padX + index * band + (band - barWidth) / 2;
          const top = y(point.count);
          const h = padTop + plotHeight - top;
          return (
            <g key={`${point.label}-${index}`}>
              <rect x={x} y={top} width={barWidth} height={Math.max(1, h)} rx={Math.min(4, barWidth / 4)} className="trend-bar">
                <title>{`${point.label}: ${point.count}`}</title>
              </rect>
              {(index % every === 0 || index === data.length - 1) && (
                <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" className="chart-axis chart-x-label">
                  {point.label.length > 7 ? point.label.slice(5) : point.label}
                </text>
              )}
            </g>
          );
        })}
        <line x1={padX} y1={avgY} x2={width - padX} y2={avgY} className="average-line" />
        <text x={width - padX - 4} y={Math.max(13, avgY - 6)} textAnchor="end" className="average-label">среднее {average.toFixed(1)}</text>
      </svg>
    </div>
  );
}

export function RankBars({ data, maxItems = 8 }: { data: CountPoint[]; maxItems?: number }) {
  const sliced = data.slice(0, maxItems);
  const max = Math.max(1, ...sliced.map((item) => item.count));
  if (!sliced.length) return <div className="chart-empty">Нет данных.</div>;
  return (
    <div className="rank-bars">
      {sliced.map((item, index) => (
        <div className="rank-row" key={`${item.label}-${index}`}>
          <div className="rank-label" title={item.label}>{item.label}</div>
          <div className="rank-track"><div className="rank-fill" style={{ width: `${Math.max(3, (item.count / max) * 100)}%` }} /></div>
          <div className="rank-value">{item.count}</div>
        </div>
      ))}
    </div>
  );
}

const PIE_COLORS = ["#2f6f98", "#5c92b2", "#8bb3c8", "#d29a55", "#9b7b67", "#6f9b83", "#a6a55e", "#8c7fa7"];

function pieData(data: CountPoint[], maxItems: number): CountPoint[] {
  if (data.length <= maxItems) return data;
  const head = data.slice(0, maxItems - 1);
  const other = data.slice(maxItems - 1).reduce((sum, item) => sum + item.count, 0);
  return [...head, { label: "Остальные", count: other }];
}

function polar(cx: number, cy: number, radius: number, angle: number) {
  const radians = (angle - 90) * Math.PI / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function sectorPath(cx: number, cy: number, radius: number, start: number, end: number) {
  const startPoint = polar(cx, cy, radius, end);
  const endPoint = polar(cx, cy, radius, start);
  const largeArc = end - start <= 180 ? 0 : 1;
  return [`M ${cx} ${cy}`, `L ${startPoint.x} ${startPoint.y}`, `A ${radius} ${radius} 0 ${largeArc} 0 ${endPoint.x} ${endPoint.y}`, "Z"].join(" ");
}

export function PieChart({ data, maxItems = 8 }: { data: CountPoint[]; maxItems?: number }) {
  const items = pieData(data.filter((item) => item.count > 0), maxItems);
  const total = items.reduce((sum, item) => sum + item.count, 0);
  if (!items.length || total === 0) return <div className="chart-empty">Нет данных.</div>;
  let cursor = 0;
  return (
    <div className="pie-layout">
      <svg viewBox="0 0 240 220" className="pie-svg" role="img" aria-label="Секторальная диаграмма">
        {items.map((item, index) => {
          const sweep = item.count / total * 360;
          const start = cursor;
          const end = cursor + sweep;
          cursor = end;
          return <path key={`${item.label}-${index}`} d={sectorPath(120, 108, 82, start, end)} fill={PIE_COLORS[index % PIE_COLORS.length]} className="pie-sector"><title>{`${item.label}: ${item.count} (${Math.round(item.count / total * 100)}%)`}</title></path>;
        })}
        <circle cx="120" cy="108" r="41" className="pie-hole" />
        <text x="120" y="104" textAnchor="middle" className="pie-total">{total}</text>
        <text x="120" y="121" textAnchor="middle" className="pie-total-label">публикаций</text>
      </svg>
      <div className="pie-legend">
        {items.map((item, index) => <div className="pie-legend-row" key={`${item.label}-${index}`}><span className="legend-dot" style={{ background: PIE_COLORS[index % PIE_COLORS.length] }} /><span title={item.label}>{item.label}</span><b>{item.count}</b></div>)}
      </div>
    </div>
  );
}

type MapRegion = { key: string; label: string; aliases: string[]; points: string; labelX: number; labelY: number };
const MAP_REGIONS: MapRegion[] = [
  { key: "grodno", label: "Гродненская", aliases: ["гродненская область"], points: "72,108 190,68 284,112 276,207 164,232 78,190", labelX: 168, labelY: 151 },
  { key: "brest", label: "Брестская", aliases: ["брестская область"], points: "78,190 164,232 276,207 300,330 203,383 72,333 48,252", labelX: 165, labelY: 292 },
  { key: "vitebsk", label: "Витебская", aliases: ["витебская область"], points: "284,112 302,78 450,44 610,101 590,190 450,220 342,181", labelX: 453, labelY: 125 },
  { key: "minsk", label: "Минская", aliases: ["минская область"], points: "284,112 342,181 450,220 430,310 300,330 276,207", labelX: 356, labelY: 245 },
  { key: "mogilev", label: "Могилёвская", aliases: ["могилёвская область", "могилевская область"], points: "450,220 590,190 642,260 560,332 430,310", labelX: 535, labelY: 267 },
  { key: "gomel", label: "Гомельская", aliases: ["гомельская область"], points: "300,330 430,310 560,332 622,391 470,421 340,390", labelX: 466, labelY: 365 },
];

function normalizedLabel(value: string) { return value.trim().toLocaleLowerCase("ru-RU"); }

export function BelarusRegionMap({ data }: { data: CountPoint[] }) {
  const values = new Map(data.map((item) => [normalizedLabel(item.label), item.count]));
  const counts = MAP_REGIONS.map((region) => region.aliases.reduce((best, alias) => Math.max(best, values.get(alias) ?? 0), 0));
  const minskCity = Math.max(values.get("минск") ?? 0, values.get("г. минск") ?? 0);
  const max = Math.max(1, minskCity, ...counts);
  const unknown = data.find((item) => normalizedLabel(item.label).startsWith("не определ"))?.count ?? 0;
  const opacityFor = (count: number) => count === 0 ? 0.12 : 0.30 + (count / max) * 0.65;

  return (
    <div className="belarus-map-wrap">
      <svg viewBox="0 0 690 455" className="belarus-map" role="img" aria-label="Карта-схема Беларуси по регионам событий">
        {MAP_REGIONS.map((region, index) => {
          const count = counts[index];
          return <g key={region.key}>
            <polygon points={region.points} className="map-region" style={{ fillOpacity: opacityFor(count) }}><title>{`${region.label} область: ${count}`}</title></polygon>
            <text x={region.labelX} y={region.labelY} textAnchor="middle" className="map-label">{region.label}</text>
            <text x={region.labelX} y={region.labelY + 17} textAnchor="middle" className="map-value">{count}</text>
          </g>;
        })}
        <circle cx="365" cy="247" r={minskCity > 0 ? 13 : 8} className="minsk-city" style={{ fillOpacity: opacityFor(minskCity) }}><title>{`Минск: ${minskCity}`}</title></circle>
        <text x="365" y="276" textAnchor="middle" className="map-city-label">Минск · {minskCity}</text>
      </svg>
      <div className="map-footer"><span><i className="map-scale low" />меньше</span><span><i className="map-scale high" />больше</span>{unknown > 0 && <b>Не определено: {unknown}</b>}</div>
    </div>
  );
}
