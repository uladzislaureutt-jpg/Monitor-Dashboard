import type { PeriodDays } from "../types";
import { useI18n } from "../i18n";

const values: PeriodDays[] = [1, 7, 30, 365, null];

export function PeriodSelector({ value, onChange, compact = false }: { value: PeriodDays; onChange: (value: PeriodDays) => void; compact?: boolean }) {
  const { t } = useI18n();
  const labelFor = (option: PeriodDays) => option === null ? t("period.all") : t(`period.${option}` as "period.1" | "period.7" | "period.30" | "period.365");
  return (
    <div className={`period-selector ${compact ? "compact" : ""}`} role="group" aria-label={t("period.aria")}>
      {values.map((option) => (
        <button
          key={option ?? "all"}
          className={value === option ? "active" : ""}
          onClick={() => onChange(option)}
        >
          {labelFor(option)}
        </button>
      ))}
    </div>
  );
}
