import type { DatabaseStats, RunSummary } from "../types";

function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ru-RU");
}
function formatMode(value: boolean | null) { if (value === true) return "dry-run"; if (value === false) return "production"; return "не определён"; }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} Б`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`; return `${(bytes / 1024 ** 2).toFixed(1)} МБ`; }

export function DataView({ stats, runs, busy, onImport }: { stats: DatabaseStats | null; runs: RunSummary[]; busy: boolean; onImport: () => void }) {
  const latest = runs[0] ?? null;
  const productionRuns = runs.filter((run) => run.dryRun === false).length;
  return <div className="view-stack">
    <section className="hero data-hero"><div><div className="eyebrow">ДАННЫЕ</div><h2>Импорт и запуски</h2><p>Технический экран для пополнения локальной SQLite Dashboard bundle-файлами. Повторный импорт одного run идемпотентен.</p></div><button className="import-button" onClick={onImport} disabled={busy}>{busy ? "Импорт…" : "+ Импортировать bundle"}</button></section>
    <section className="kpi-grid"><article className="kpi"><strong>{stats?.runs ?? "—"}</strong><span>импортированных запусков</span></article><article className="kpi"><strong>{stats?.documents ?? "—"}</strong><span>уникальных публикаций</span></article><article className="kpi"><strong>{stats?.sources ?? "—"}</strong><span>источников</span></article><article className="kpi"><strong>{productionRuns}</strong><span>production runs</span></article><article className="kpi"><strong>{latest?.runNumber ?? "—"}</strong><span>последний run</span></article><article className="kpi"><strong>{stats ? formatBytes(stats.databaseSizeBytes) : "—"}</strong><span>размер SQLite</span></article></section>
    <section className="panel"><div className="panel-head"><div><h3>Импортированные запуски</h3><p>Режим dry-run/production берётся из manifest bundle.</p></div><span className="badge">Contract 0.x</span></div><div className="table-wrap"><table><thead><tr><th>Run</th><th>Режим</th><th>Старт</th><th>Публикации</th><th>Источники</th><th>Импорт</th></tr></thead><tbody>{runs.length === 0 ? <tr><td colSpan={6} className="empty">Пока нет импортированных bundle.</td></tr> : runs.map((run) => <tr key={run.id}><td><b>#{run.runNumber ?? "—"}</b><small>{run.monitorName}</small></td><td><span className={`mode mode-${run.dryRun === true ? "dry" : run.dryRun === false ? "prod" : "unknown"}`}>{formatMode(run.dryRun)}</span></td><td>{formatDate(run.startedAt)}</td><td>{run.publications}</td><td>{run.sourcesInCoverage}</td><td>{formatDate(run.importedAt)}</td></tr>)}</tbody></table></div></section>
    <section className="panel db-path"><span>SQLite</span><code title={stats?.databasePath}>{stats?.databasePath ?? "инициализация…"}</code></section>
  </div>;
}
