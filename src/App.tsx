import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "./api";
import type { DatabaseStats, ImportResult, RunSummary } from "./types";

function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ru-RU");
}

function formatMode(value: boolean | null) {
  if (value === true) return "dry-run";
  if (value === false) return "production";
  return "не определён";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}

export default function App() {
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");

  const refresh = useCallback(async () => {
    const [nextStats, nextRuns] = await Promise.all([
      desktopApi.stats(),
      desktopApi.runs(),
    ]);
    setStats(nextStats);
    setRuns(nextRuns);
  }, []);

  useEffect(() => {
    refresh().catch((reason) => setError(String(reason)));
  }, [refresh]);

  const latest = runs[0] ?? null;
  const productionRuns = useMemo(
    () => runs.filter((run) => run.dryRun === false).length,
    [runs],
  );

  async function importBundle() {
    setError("");
    setMessage("");
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Импортировать Dashboard bundle",
      filters: [{ name: "Dashboard bundle ZIP", extensions: ["zip"] }],
    });
    if (!selected || Array.isArray(selected)) return;

    setBusy(true);
    try {
      const result: ImportResult = await desktopApi.importBundle(selected);
      const prefix =
        result.status === "already_imported"
          ? "Этот запуск уже был импортирован"
          : result.status === "replaced"
            ? "Запуск переимпортирован"
            : "Bundle импортирован";
      setMessage(
        `${prefix}: run ${result.runNumber ?? "—"}, ${result.publications} публикаций, ${result.sourcesInCoverage} источников coverage.`,
      );
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Monitor Dashboard</h1>
          <div className="subtitle">Desktop Core 0.3 · Windows x64 · локальная SQLite</div>
        </div>
        <div className="module-pill">Модуль: Соц-экон</div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="nav-label">Навигация</div>
          <button className="nav-item active">Импорт и запуски</button>
          <button className="nav-item" disabled>Dashboard <span>0.4</span></button>
          <button className="nav-item" disabled>Архив <span>0.4</span></button>
          <button className="nav-item" disabled>Аналитика <span>0.4</span></button>
          <button className="nav-item" disabled>Источники <span>0.4</span></button>
          <div className="side-note">
            0.3 отвечает только за устойчивое накопление данных. Визуальная аналитика подключается поверх той же БД на следующем этапе.
          </div>
        </aside>

        <main className="content">
          <section className="hero">
            <div>
              <div className="eyebrow">DATA FOUNDATION</div>
              <h2>Локальная база мониторинга</h2>
              <p>
                Импортирует стабильный Dashboard Data Contract 0.x, проверяет JSON Schema,
                устраняет дубли между перекрывающимися 36-часовыми окнами и хранит публикацию один раз.
              </p>
            </div>
            <button className="import-button" onClick={importBundle} disabled={busy}>
              {busy ? "Импорт…" : "+ Импортировать bundle"}
            </button>
          </section>

          {message && <div className="notice success">{message}</div>}
          {error && <div className="notice error">{error}</div>}

          <section className="kpi-grid">
            <article className="kpi"><strong>{stats?.runs ?? "—"}</strong><span>импортированных запусков</span></article>
            <article className="kpi"><strong>{stats?.documents ?? "—"}</strong><span>уникальных публикаций</span></article>
            <article className="kpi"><strong>{stats?.sources ?? "—"}</strong><span>источников в каталоге</span></article>
            <article className="kpi"><strong>{productionRuns}</strong><span>production runs</span></article>
            <article className="kpi"><strong>{latest?.runNumber ?? "—"}</strong><span>последний run</span></article>
            <article className="kpi"><strong>{stats ? formatBytes(stats.databaseSizeBytes) : "—"}</strong><span>размер SQLite</span></article>
          </section>

          <section className="grid-two">
            <article className="panel">
              <div className="panel-head">
                <div>
                  <h3>Импортированные запуски</h3>
                  <p>Повторный импорт того же bundle идемпотентен.</p>
                </div>
                <span className="badge">Contract 0.x</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Run</th><th>Режим</th><th>Старт</th><th>Публикации</th><th>Источники</th><th>Импорт</th></tr>
                  </thead>
                  <tbody>
                    {runs.length === 0 ? (
                      <tr><td colSpan={6} className="empty">Пока нет импортированных bundle.</td></tr>
                    ) : runs.map((run) => (
                      <tr key={run.id}>
                        <td><b>#{run.runNumber ?? "—"}</b><small>{run.monitorName}</small></td>
                        <td><span className={`mode mode-${run.dryRun === true ? "dry" : run.dryRun === false ? "prod" : "unknown"}`}>{formatMode(run.dryRun)}</span></td>
                        <td>{formatDate(run.startedAt)}</td>
                        <td>{run.publications}</td>
                        <td>{run.sourcesInCoverage}</td>
                        <td>{formatDate(run.importedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="panel core-panel">
              <div className="panel-head">
                <div>
                  <h3>Desktop Core</h3>
                  <p>Текущее состояние слоя данных.</p>
                </div>
                <span className="badge ok">готов 0.3</span>
              </div>
              <ul className="check-list">
                <li><span>✓</span><div><b>SQLite + миграции</b><small>База в системной папке данных приложения.</small></div></li>
                <li><span>✓</span><div><b>ZIP importer</b><small>Принимает direct bundle и ZIP-обёртку GitHub artifact.</small></div></li>
                <li><span>✓</span><div><b>JSON Schema validation</b><small>Проверка manifest, publications, source_metrics, run_metrics.</small></div></li>
                <li><span>✓</span><div><b>Idempotent ingest</b><small>document → monitor_item → run observation.</small></div></li>
                <li><span>✓</span><div><b>Event geography separated</b><small>География события хранится независимо от географии источника.</small></div></li>
              </ul>
              <div className="db-path">
                <span>SQLite</span>
                <code title={stats?.databasePath}>{stats?.databasePath ?? "инициализация…"}</code>
              </div>
            </article>
          </section>
        </main>
      </div>
    </div>
  );
}
