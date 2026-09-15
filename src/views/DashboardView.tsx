import type { DashboardOverview, PeriodDays } from "../types";
import { PeriodSelector } from "../components/PeriodSelector";
import { RankBars, TrendChart } from "../components/Charts";
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
          <div className="eyebrow dark">ОБЗОР</div>
          <h2>Социально-экономический мониторинг</h2>
          <p>Сводка строится по уникальным публикациям в локальной базе, без повторного счёта перекрывающихся запусков.</p>
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
          <div className="panel-head">
            <div><h3>Динамика публикаций</h3><p>По дате публикации; для длинных периодов агрегируется по месяцам.</p></div>
          </div>
          <TrendChart data={data?.trend ?? []} />
        </article>
        <article className="panel chart-panel">
          <div className="panel-head"><div><h3>Темы</h3><p>Наиболее частые категории.</p></div></div>
          <RankBars data={data?.categoryBreakdown ?? []} />
        </article>
        <article className="panel chart-panel">
          <div className="panel-head"><div><h3>География</h3><p>Регион события, а не регион источника.</p></div></div>
          <RankBars data={data?.regionBreakdown ?? []} />
        </article>
        <article className="panel chart-panel">
          <div className="panel-head"><div><h3>Источники</h3><p>Кто дал больше релевантных публикаций.</p></div></div>
          <RankBars data={data?.sourceBreakdown ?? []} />
        </article>
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
