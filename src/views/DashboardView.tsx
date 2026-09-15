import type { DashboardOverview, PeriodDays } from "../types";
import { PeriodSelector } from "../components/PeriodSelector";
import { TrendColumns } from "../components/Charts";
import { BreakdownPanel } from "../components/BreakdownPanel";
import { PublicationCard } from "../components/PublicationCard";

export function DashboardView({
  data,
  period,
  onPeriodChange,
  loading,
  onOpenArchive,
}: {
  data: DashboardOverview | null;
  period: PeriodDays;
  onPeriodChange: (value: PeriodDays) => void;
  loading: boolean;
  onOpenArchive: () => void;
}) {
  return (
    <div className="view-stack">
      <section className="view-heading dashboard-heading">
        <div>
          <div className="eyebrow dark">SEP-MONITOR</div>
          <h2>Мониторинг социально-экономических проблем</h2>
          <p>Сводка по уникальным публикациям в локальной базе, без повторного счёта перекрывающихся запусков.</p>
        </div>
        <PeriodSelector value={period} onChange={onPeriodChange} />
      </section>

      <section className="kpi-grid dashboard-kpis">
        <article className="kpi"><strong>{loading ? "…" : data?.publications ?? 0}</strong><span>публикаций</span></article>
        <article className="kpi"><strong>{loading ? "…" : data?.activeSources ?? 0}</strong><span>активных источников</span></article>
        <article className="kpi"><strong>{loading ? "…" : data?.regions ?? 0}</strong><span>регионов событий</span></article>
        <article className="kpi"><strong>{loading ? "…" : data?.categories ?? 0}</strong><span>категорий проблем</span></article>
        <article className="kpi"><strong>{loading ? "…" : data?.officialResponses ?? 0}</strong><span>с официальным ответом</span></article>
      </section>

      <section className="dashboard-grid">
        <article className="panel chart-panel span-two">
          <div className="panel-head"><div><h3>Динамика публикаций</h3><p>Столбцы показывают число публикаций по дням или месяцам; пунктир — среднее за выбранный период.</p></div></div>
          <TrendColumns data={data?.trend ?? []} />
        </article>
        <BreakdownPanel title="Темы" subtitle="Наиболее частые категории." data={data?.categoryBreakdown ?? []} />
        <BreakdownPanel title="География" subtitle="Регион события, а не регион источника." data={data?.regionBreakdown ?? []} allowMap />
        <BreakdownPanel title="Источники" subtitle="Кто дал больше релевантных публикаций." data={data?.sourceBreakdown ?? []} />
      </section>

      <section className="panel recent-panel">
        <div className="panel-head">
          <div><h3>Последние материалы</h3><p>Новые записи из накопленного архива.</p></div>
          <button className="secondary-button" onClick={onOpenArchive}>Открыть архив</button>
        </div>
        <div className="recent-list">
          {(data?.recent ?? []).length === 0 ? <div className="empty-state">Пока нет данных.</div> : (data?.recent ?? []).map((item) => <PublicationCard item={item} compact key={item.id} />)}
        </div>
      </section>
    </div>
  );
}
