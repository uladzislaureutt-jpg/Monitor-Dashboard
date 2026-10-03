import type { CountPoint, TopicTrendPoint } from "../types";
import { useI18n } from "../i18n";
import { localizeDataLabel } from "../dataLabels";

function compact(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function TrendColumns({ data }: { data: CountPoint[] }) {
  const { t, formatLocale } = useI18n();
  if (!data.length) return <div className="chart-empty">{t("common.notEnough")}</div>;
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
    <div className="trend-chart" aria-label={t("dashboard.trend")}>
      <div className="trend-summary"><span>{t("chart.average")}</span><b>{average.toFixed(1)}</b></div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const yy = padTop + ratio * plotHeight;
          const label = Math.round(max * (1 - ratio));
          return <g key={ratio}><line x1={padX} y1={yy} x2={width - padX} y2={yy} className="chart-grid" /><text x={5} y={yy + 4} className="chart-axis">{compact(label, formatLocale)}</text></g>;
        })}
        {data.map((point, index) => {
          const x = padX + index * band + (band - barWidth) / 2;
          const top = y(point.count);
          const h = padTop + plotHeight - top;
          return <g key={`${point.label}-${index}`}>
            <rect x={x} y={top} width={barWidth} height={Math.max(1, h)} rx={Math.min(4, barWidth / 4)} className="trend-bar"><title>{`${point.label}: ${point.count}`}</title></rect>
            {(index % every === 0 || index === data.length - 1) && <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" className="chart-axis chart-x-label">{point.label.length > 7 ? point.label.slice(5) : point.label}</text>}
          </g>;
        })}
        <line x1={padX} y1={avgY} x2={width - padX} y2={avgY} className="average-line" />
        <text x={width - padX - 4} y={Math.max(13, avgY - 6)} textAnchor="end" className="average-label">{t("chart.averageShort", { value: average.toFixed(1) })}</text>
      </svg>
    </div>
  );
}

function pathFor(values: number[], width: number, height: number, padX: number, padTop: number, padBottom: number, max: number) {
  const plotHeight = height - padTop - padBottom; const step = values.length > 1 ? (width - padX * 2) / (values.length - 1) : 0; const y = (value: number) => padTop + plotHeight - (value / Math.max(1, max)) * plotHeight; return values.map((value, index) => `${index === 0 ? "M" : "L"} ${padX + index * step} ${y(value)}`).join(" ");
}
function movingAverage(values: number[], windowSize = 3) { return values.map((_, index) => { const start = Math.max(0, index-windowSize+1); const slice=values.slice(start,index+1); return slice.reduce((sum,value)=>sum+value,0)/slice.length; }); }

export function TrendLine({ data }: { data: CountPoint[] }) {
  const { t, formatLocale } = useI18n(); if(!data.length) return <div className="chart-empty">{t("common.notEnough")}</div>;
  const width=760,height=245,padX=40,padTop=24,padBottom=34,plotHeight=height-padTop-padBottom; const values=data.map(p=>p.count), smooth=movingAverage(values,3), max=Math.max(1,...values,...smooth), step=data.length>1?(width-padX*2)/(data.length-1):0, y=(v:number)=>padTop+plotHeight-(v/max)*plotHeight, every=Math.max(1,Math.ceil(data.length/8));
  return <div className="trend-chart" aria-label={t("dashboard.trend")}><div className="trend-legend compact"><span className="legend-line total" />{t("chart.total")}<span className="legend-line moving" />{t("chart.movingAverage")}</div><svg viewBox={`0 0 ${width} ${height}`} role="img">{[0,.25,.5,.75,1].map(r=>{const yy=padTop+r*plotHeight,label=Math.round(max*(1-r));return <g key={r}><line x1={padX} y1={yy} x2={width-padX} y2={yy} className="chart-grid"/><text x={5} y={yy+4} className="chart-axis">{compact(label,formatLocale)}</text></g>})}<path d={pathFor(values,width,height,padX,padTop,padBottom,max)} className="trend-line-total"/><path d={pathFor(smooth,width,height,padX,padTop,padBottom,max)} className="trend-line-moving"/>{data.map((point,index)=><g key={`${point.label}-${index}`}><circle cx={padX+index*step} cy={y(point.count)} r="3.2" className="trend-line-point"><title>{`${point.label}: ${point.count}`}</title></circle>{(index%every===0||index===data.length-1)&&<text x={padX+index*step} y={height-8} textAnchor="middle" className="chart-axis chart-x-label">{point.label.length>7?point.label.slice(5):point.label}</text>}</g>)}</svg></div>;
}

const TOPIC_LINE_COLORS=["#2f6f98","#a35b46","#6c8c58","#8a6b9c"];
export function TopicTrendLines({ data }: { data: TopicTrendPoint[] }) {
  const { t, locale, formatLocale }=useI18n(); if(!data.length) return <div className="chart-empty">{t("common.notEnough")}</div>; const buckets=Array.from(new Set(data.map(i=>i.bucket))).sort(); const rawCategories=Array.from(new Set(data.map(i=>i.category))).slice(0,4); const categories=rawCategories.map(category=>({raw:category,label:localizeDataLabel(category,locale,"category")})); const table=new Map(data.map(i=>[`${i.bucket}\u0000${i.category}`,i.count])); const series=categories.map(c=>({...c,values:buckets.map(bucket=>table.get(`${bucket}\u0000${c.raw}`)??0)})); const width=760,height=245,padX=40,padTop=28,padBottom=34,plotHeight=height-padTop-padBottom,max=Math.max(1,...series.flatMap(i=>i.values)),step=buckets.length>1?(width-padX*2)/(buckets.length-1):0,every=Math.max(1,Math.ceil(buckets.length/8));
  return <div className="trend-chart" aria-label={t("chart.topicLines")}><div className="trend-topic-legend">{series.map((item,index)=><span key={item.raw}><i style={{background:TOPIC_LINE_COLORS[index]}}/>{item.label}</span>)}</div><svg viewBox={`0 0 ${width} ${height}`} role="img">{[0,.25,.5,.75,1].map(r=>{const yy=padTop+r*plotHeight,label=Math.round(max*(1-r));return <g key={r}><line x1={padX} y1={yy} x2={width-padX} y2={yy} className="chart-grid"/><text x={5} y={yy+4} className="chart-axis">{compact(label,formatLocale)}</text></g>})}{series.map((item,index)=><path key={item.raw} d={pathFor(item.values,width,height,padX,padTop,padBottom,max)} fill="none" stroke={TOPIC_LINE_COLORS[index]} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round"/>)}{buckets.map((bucket,index)=>(index%every===0||index===buckets.length-1)?<text key={bucket} x={padX+index*step} y={height-8} textAnchor="middle" className="chart-axis chart-x-label">{bucket.length>7?bucket.slice(5):bucket}</text>:null)}{series.flatMap((item,si)=>item.values.map((value,index)=>value>0?<circle key={`${item.raw}-${buckets[index]}`} cx={padX+index*step} cy={padTop+plotHeight-(value/max)*plotHeight} r="2.8" fill={TOPIC_LINE_COLORS[si]}><title>{`${buckets[index]} · ${item.label}: ${value}`}</title></circle>:null))}</svg></div>;
}

const SOURCE_ICON_ALIASES: Array<{ match: RegExp; path: string }> = [
  { match: /^(bbc|bbc russian|би-би-си)/i, path: "/media-icons/bbc.svg" },
  { match: /(the guardian|guardian)/i, path: "/media-icons/theguardian.svg" },
  { match: /(deutsche welle|\bdw\b)/i, path: "/media-icons/deutschewelle.svg" },
  { match: /reuters|рейтер/i, path: "/media-icons/reuters.svg" },
  { match: /коммерсант|kommersant/i, path: "/media-icons/kommersant.svg" },
];

function sourceMark(label: string) {
  const cleaned = label.trim();
  if (!cleaned) return "•";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

function SourceIcon({ label }: { label: string }) {
  const found = SOURCE_ICON_ALIASES.find((item) => item.match.test(label));
  if (found) return <span className="source-logo"><img src={found.path} alt="" loading="lazy" /></span>;
  return <i className="source-mark" aria-hidden="true">{sourceMark(label)}</i>;
}

export function RankBars({ data, maxItems = 8, withIcons = false }: { data: CountPoint[]; maxItems?: number; withIcons?: boolean }) {
  const { t } = useI18n();
  const sliced = data.slice(0, maxItems);
  const max = Math.max(1, ...sliced.map((item) => item.count));
  if (!sliced.length) return <div className="chart-empty">{t("common.none")}</div>;
  return <div className="rank-bars">{sliced.map((item, index) => <div className="rank-row" key={`${item.label}-${index}`}><div className="rank-label" title={item.label}>{withIcons && <SourceIcon label={item.label} />}<span>{item.label}</span></div><div className="rank-track"><div className="rank-fill" style={{ width: `${Math.max(3, (item.count / max) * 100)}%` }} /></div><div className="rank-value">{item.count}</div></div>)}</div>;
}

const PIE_COLORS = ["#2f6f98", "#5c92b2", "#8bb3c8", "#d29a55", "#9b7b67", "#6f9b83", "#a6a55e", "#8c7fa7"];

function pieData(data: CountPoint[], maxItems: number, otherLabel: string): CountPoint[] {
  if (data.length <= maxItems) return data;
  const head = data.slice(0, maxItems - 1);
  const other = data.slice(maxItems - 1).reduce((sum, item) => sum + item.count, 0);
  return [...head, { label: otherLabel, count: other }];
}
function polar(cx: number, cy: number, radius: number, angle: number) { const radians = (angle - 90) * Math.PI / 180; return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) }; }
function sectorPath(cx: number, cy: number, radius: number, start: number, end: number) { const startPoint = polar(cx, cy, radius, end); const endPoint = polar(cx, cy, radius, start); const largeArc = end - start <= 180 ? 0 : 1; return [`M ${cx} ${cy}`, `L ${startPoint.x} ${startPoint.y}`, `A ${radius} ${radius} 0 ${largeArc} 0 ${endPoint.x} ${endPoint.y}`, "Z"].join(" "); }

export function PieChart({ data, maxItems = 8 }: { data: CountPoint[]; maxItems?: number }) {
  const { t } = useI18n();
  const items = pieData(data.filter((item) => item.count > 0), maxItems, t("chart.others"));
  const total = items.reduce((sum, item) => sum + item.count, 0);
  if (!items.length || total === 0) return <div className="chart-empty">{t("common.none")}</div>;
  let cursor = 0;
  return <div className="pie-layout"><svg viewBox="0 0 240 220" className="pie-svg" role="img" aria-label={t("chart.sectors")}>
    {items.map((item, index) => { const sweep = item.count / total * 360; const start = cursor; const end = cursor + sweep; cursor = end; return <path key={`${item.label}-${index}`} d={sectorPath(120, 108, 82, start, end)} fill={PIE_COLORS[index % PIE_COLORS.length]} className="pie-sector"><title>{`${item.label}: ${item.count} (${Math.round(item.count / total * 100)}%)`}</title></path>; })}
    <circle cx="120" cy="108" r="41" className="pie-hole" /><text x="120" y="104" textAnchor="middle" className="pie-total">{total}</text><text x="120" y="121" textAnchor="middle" className="pie-total-label">{t("chart.publications")}</text>
  </svg><div className="pie-legend">{items.map((item, index) => <div className="pie-legend-row" key={`${item.label}-${index}`}><span className="legend-dot" style={{ background: PIE_COLORS[index % PIE_COLORS.length] }} /><span title={item.label}>{item.label}</span><b>{item.count}</b></div>)}</div></div>;
}

type GeoItem = { key: string; label: string; aliases: string[]; count: number };
type Rect = { x: number; y: number; w: number; h: number };
type Tile = GeoItem & Rect;

function normalizedLabel(value: string) { return value.trim().toLocaleLowerCase("ru-RU"); }

function binaryTreemap(items: GeoItem[], rect: Rect): Tile[] {
  if (!items.length) return [];
  if (items.length === 1) return [{ ...items[0], ...rect }];
  const weights = items.map((item) => Math.max(item.count, 0.18));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let acc = 0;
  let split = 1;
  let best = Infinity;
  for (let i = 1; i < items.length; i += 1) {
    acc += weights[i - 1];
    const diff = Math.abs(total / 2 - acc);
    if (diff < best) { best = diff; split = i; }
  }
  const first = items.slice(0, split);
  const second = items.slice(split);
  const firstWeight = weights.slice(0, split).reduce((sum, value) => sum + value, 0);
  const ratio = firstWeight / total;
  if (rect.w >= rect.h) {
    const w1 = rect.w * ratio;
    return [...binaryTreemap(first, { x: rect.x, y: rect.y, w: w1, h: rect.h }), ...binaryTreemap(second, { x: rect.x + w1, y: rect.y, w: rect.w - w1, h: rect.h })];
  }
  const h1 = rect.h * ratio;
  return [...binaryTreemap(first, { x: rect.x, y: rect.y, w: rect.w, h: h1 }), ...binaryTreemap(second, { x: rect.x, y: rect.y + h1, w: rect.w, h: rect.h - h1 })];
}

export function BelarusRegionTreemap({ data }: { data: CountPoint[] }) {
  const { t } = useI18n();
  const values = new Map(data.map((item) => [normalizedLabel(item.label), item.count]));
  const find = (aliases: string[]) => aliases.reduce((best, alias) => Math.max(best, values.get(normalizedLabel(alias)) ?? 0), 0);
  const items = [
    { key: "vitebsk", label: t("geo.vitebsk"), aliases: ["Витебская область","Віцебская вобласць"], x: 135, y: 18, w: 105, h: 58 },
    { key: "grodno", label: t("geo.grodno"), aliases: ["Гродненская область","Гродзенская вобласць"], x: 18, y: 76, w: 92, h: 70 },
    { key: "minsk-region", label: t("geo.minskRegion"), aliases: ["Минская область","Мінская вобласць"], x: 103, y: 72, w: 110, h: 82 },
    { key: "mogilev", label: t("geo.mogilev"), aliases: ["Могилёвская область","Могилевская область","Магілёўская вобласць"], x: 205, y: 80, w: 84, h: 72 },
    { key: "brest", label: t("geo.brest"), aliases: ["Брестская область","Брэсцкая вобласць"], x: 28, y: 145, w: 102, h: 64 },
    { key: "gomel", label: t("geo.gomel"), aliases: ["Гомельская область","Гомельская вобласць"], x: 170, y: 148, w: 108, h: 68 },
    { key: "minsk", label: t("geo.minsk"), aliases: ["Минск","г. Минск","Мінск","г. Мінск"], x: 142, y: 108, w: 42, h: 36 },
  ].map((item) => ({ ...item, count: find(item.aliases) }));
  const max = Math.max(1, ...items.map((item) => item.count));
  return <div className="belarus-map-wrap" role="img" aria-label={t("dashboard.geography")}>
    <svg className="belarus-region-map" viewBox="0 0 310 230">
      <path className="belarus-map-outline" d="M21 86 50 52 103 50 125 20 204 17 239 42 278 77 287 124 269 177 229 211 165 214 123 201 72 209 31 177 15 130Z" />
      {items.map((item) => {
        const alpha=.16 + (item.count/max)*.72;
        return <g key={item.key}>
          <rect x={item.x} y={item.y} width={item.w} height={item.h} rx="18" fill={`rgba(47,111,152,${alpha})`} className="belarus-region-cell" />
          <text x={item.x+item.w/2} y={item.y+item.h/2-3} textAnchor="middle" className="belarus-region-label">{item.label}</text>
          <text x={item.x+item.w/2} y={item.y+item.h/2+13} textAnchor="middle" className="belarus-region-count">{item.count}</text>
        </g>;
      })}
    </svg>
    <div className="map-footer"><span><i className="map-scale belarus-scale low" />{t("geo.less")}</span><span><i className="map-scale belarus-scale high" />{t("geo.more")}</span></div>
  </div>;
}

const COUNTRY_COORDS: Record<string, [number,number]> = {
  "россия":[73,30], "russia":[73,30], "беларусь":[58,29], "belarus":[58,29], "украина":[59,34], "ukraine":[59,34],
  "азербайджан":[64,38], "azerbaijan":[64,38], "армения":[62,39], "armenia":[62,39], "испания":[46,38], "spain":[46,38],
  "казахстан":[70,37], "kazakhstan":[70,37], "литва":[57,27], "lithuania":[57,27], "польша":[55,30], "poland":[55,30],
  "германия":[52,29], "germany":[52,29], "франция":[49,31], "france":[49,31], "сша":[20,34], "usa":[20,34], "united states":[20,34],
  "китай":[79,42], "china":[79,42], "турция":[61,42], "turkey":[61,42], "великобритания":[48,26], "united kingdom":[48,26],
  "италия":[54,39], "italy":[54,39], "грузия":[63,36], "georgia":[63,36], "латвия":[58,25], "latvia":[58,25],
};

export function WorldSourceMap({ data }: { data: CountPoint[] }) {
  const { locale } = useI18n();
  const normalized = data.filter((item)=>item.count>0).map((item)=>({ ...item, key: normalizedLabel(item.label), coord: COUNTRY_COORDS[normalizedLabel(item.label)] })).filter((item)=>item.coord);
  const max=Math.max(1,...normalized.map((item)=>item.count));
  const title=locale==="be"?"Карта краін паходжання крыніц":"Карта стран происхождения источников";
  return <div className="world-source-map" role="img" aria-label={title}>
    <svg viewBox="0 0 1000 430" preserveAspectRatio="none">
      <g className="world-land">
        <path d="M73 111 122 72 190 67 229 96 252 142 220 165 181 159 149 184 98 163Z" />
        <path d="M227 206 261 227 282 282 267 346 239 394 218 336 210 274Z" />
        <path d="M433 83 505 67 566 84 602 117 684 99 764 118 839 153 886 196 839 219 768 200 707 217 645 197 591 209 545 173 498 177 458 149Z" />
        <path d="M491 196 548 205 585 253 574 329 540 387 495 368 469 307 462 244Z" />
        <path d="M829 279 871 262 913 284 918 323 881 347 842 330Z" />
        <path d="M914 167 944 157 965 180 946 198Z" />
      </g>
      {normalized.map((item)=>{
        const [x,y]=item.coord as [number,number]; const r=5+Math.sqrt(item.count/max)*18;
        return <g key={item.label}><circle cx={x*10} cy={y*10} r={r} className="world-country-dot" style={{opacity:.32+(item.count/max)*.68}}><title>{item.label}: {item.count}</title></circle></g>;
      })}
    </svg>
  </div>;
}

export function CountryTreemap({ data }: { data: CountPoint[] }) {
  const { t, locale } = useI18n();
  const items: GeoItem[] = data
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map((item, index) => ({ key: `${item.label}-${index}`, label: item.label, aliases: [], count: item.count }));
  if (!items.length) return <div className="chart-empty">{t("common.none")}</div>;
  const max = Math.max(1, ...items.map((item) => item.count));
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const tiles = binaryTreemap(items, { x: 0, y: 0, w: 100, h: 100 });
  const opacity = (count: number) => 0.15 + (count / max) * 0.75;
  const ariaLabel = locale === "be" ? "Краіны паходжання СМІ" : "Страны происхождения СМИ";
  const smallTiles = tiles.filter((tile) => tile.w * tile.h < 240 || tile.w < 14 || tile.h < 11);
  return <div className="geo-treemap-wrap">
    <div className="geo-treemap country-treemap" role="img" aria-label={ariaLabel}>
      {tiles.map((tile) => {
        const strength = tile.count / max;
        const percent = total ? Math.round(tile.count / total * 100) : 0;
        const small = smallTiles.some((item) => item.key === tile.key);
        return <div key={tile.key} className={`geo-tile ${strength >= 0.48 ? "dense" : "light"} ${small ? "small-country-tile" : ""}`} style={{ left: `${tile.x}%`, top: `${tile.y}%`, width: `${tile.w}%`, height: `${tile.h}%`, background: `rgba(174, 34, 34, ${opacity(tile.count)})` }} title={`${tile.label}: ${tile.count} (${percent}%)`}>
          <span>{tile.label}</span><b>{tile.count}</b>
        </div>;
      })}
    </div>
    {smallTiles.length > 0 && <div className="country-small-legend" aria-label={locale === "be" ? "Малыя краіны на схеме" : "Малые страны на схеме"}>
      {smallTiles.map((tile) => <span key={`legend-${tile.key}`}><b>{tile.label}</b> {tile.count}</span>)}
    </div>}
    <div className="map-footer"><span><i className="map-scale country-scale low" />{t("geo.less")}</span><span><i className="map-scale country-scale high" />{t("geo.more")}</span></div>
  </div>;
}
