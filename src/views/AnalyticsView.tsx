import type { DashboardOverview, PeriodDays } from "../types";
import { PeriodSelector } from "../components/PeriodSelector";
import { TrendColumns } from "../components/Charts";
import { BreakdownPanel } from "../components/BreakdownPanel";

export function AnalyticsView({ data, period, onPeriodChange }: { data: DashboardOverview | null; period: PeriodDays; onPeriodChange: (value: PeriodDays) => void }) {
  return (
    <div className="view-stack">
      <section className="view-heading">
        <div><div className="eyebrow dark">АНАЛИТИКА</div><h2>Структура информационного потока</h2><p>Распределение публикаций по времени, проблемным темам, регионам событий и источникам.</p></div>
        <PeriodSelector value={period} onChange={onPeriodChange} />
      </section>
      <section className="panel chart-panel analytics-trend"><div className="panel-head"><div><h3>Интенсивность публикаций</h3><p>Уникальные материалы без дублей ежедневных окон; средняя линия помогает видеть отклонения.</p></div></div><TrendColumns data={data?.trend ?? []} /></section>
      <section className="analytics-grid">
        <BreakdownPanel title="Категории проблем" subtitle="Тематический профиль." data={data?.categoryBreakdown ?? []} maxItems={12} />
        <BreakdownPanel title="Регионы событий" subtitle="География проблемы." data={data?.regionBreakdown ?? []} maxItems={12} allowMap />
        <BreakdownPanel title="Источники результата" subtitle="Кто чаще поставляет релевантные материалы." data={data?.sourceBreakdown ?? []} maxItems={16} className="span-two" />
      </section>
      <section className="panel roadmap-card"><b>Следующая аналитическая надстройка</b><p>Концентрация источников и блок «Персоналии и понятия» подключаются поверх этой же базы. Карта-схема Беларуси уже работает по event geography.</p></section>
    </div>
  );
}
