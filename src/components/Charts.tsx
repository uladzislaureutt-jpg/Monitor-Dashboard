import type { CountPoint } from "../types";

function compact(value: number) {
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function TrendChart({ data }: { data: CountPoint[] }) {
  if (!data.length) return <div className="chart-empty">Недостаточно данных для графика.</div>;
  const width = 760;
  const height = 230;
  const padX = 34;
  const padY = 24;
  const max = Math.max(1, ...data.map((point) => point.count));
  const step = data.length > 1 ? (width - padX * 2) / (data.length - 1) : 0;
  const y = (value: number) => height - padY - (value / max) * (height - padY * 2);
  const points = data.map((point, index) => `${padX + index * step},${y(point.count)}`).join(" ");
  const fillPoints = `${padX},${height - padY} ${points} ${padX + (data.length - 1) * step},${height - padY}`;
  const every = Math.max(1, Math.ceil(data.length / 7));

  return (
    <div className="trend-chart" aria-label="Динамика публикаций">
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const yy = padY + ratio * (height - padY * 2);
          const label = Math.round(max * (1 - ratio));
          return (
            <g key={ratio}>
              <line x1={padX} y1={yy} x2={width - padX} y2={yy} className="chart-grid" />
              <text x={4} y={yy + 4} className="chart-axis">{compact(label)}</text>
            </g>
          );
        })}
        <polygon points={fillPoints} className="chart-area" />
        <polyline points={points} className="chart-line" />
        {data.map((point, index) => {
          const xx = padX + index * step;
          const yy = y(point.count);
          return (
            <g key={`${point.label}-${index}`}>
              <circle cx={xx} cy={yy} r={4} className="chart-dot">
                <title>{`${point.label}: ${point.count}`}</title>
              </circle>
              {(index % every === 0 || index === data.length - 1) && (
                <text x={xx} y={height - 5} textAnchor="middle" className="chart-axis chart-x-label">
                  {point.label.length > 7 ? point.label.slice(5) : point.label}
                </text>
              )}
            </g>
          );
        })}
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
