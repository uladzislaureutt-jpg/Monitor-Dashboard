import type { DashboardOverview, PeriodDays } from "../types";
import { PeriodSelector } from "../components/PeriodSelector";
import { RankBars, TrendChart } from "../components/Charts";

export function AnalyticsView({ data, period, onPeriodChange }: { data: DashboardOverview | null; period: PeriodDays; onPeriodChange: (value: PeriodDays) => void }) {
  return (
    <div className="view-stack">
      <section className="view-heading">
        <div><div className="eyebrow dark">АНАЛИТИКА</div><h2>Структура информационного потока</h2><p>Распределение публикаций по времени, проблемным темам, регионам событий и источникам.</p></div>
        <PeriodSelector value={period} onChange={onPeriodChange} />
      </section>
      <section className="panel chart-panel analytics-trend"><div className="panel-head"><div><h3>Интенсивность публикаций</h3><p>Уникальные материалы, без дублей ежедневных окон.</p></div></div><TrendChart data={data?.trend ?? []} /></section>
      <section className="analytics-grid">
        <article className="panel"><div className="panel-head"><div><h3>Категории проблем</h3><p>Тематический профиль.</p></div></div><RankBars data={data?.categoryBreakdown ?? []} maxItems={12} /></article>
        <article className="panel"><div className="panel-head"><div><h3>Регионы событий</h3><p>География проблемы.</p></div></div><RankBars data={data?.regionBreakdown ?? []} maxItems={12} /></article>
        <article className="panel span-two"><div className="panel-head"><div><h3>Источники результата</h3><p>Кто чаще поставляет релевантные материалы.</p></div></div><RankBars data={data?.sourceBreakdown ?? []} maxItems={16} /></article>
      </section>
      <section className="panel roadmap-card"><b>Следующая аналитическая надстройка</b><p>Карта Беларуси по event geography, концентрация источников и блок «Персоналии и понятия» подключаются поверх этого же контракта без изменения архива.</p></section>
    </div>
  );
}
