import type { PeriodDays } from "../types";

const options: Array<{ label: string; value: PeriodDays }> = [
  { label: "1 день", value: 1 },
  { label: "7 дней", value: 7 },
  { label: "30 дней", value: 30 },
  { label: "365 дней", value: 365 },
  { label: "Всё время", value: null },
];

export function PeriodSelector({ value, onChange }: { value: PeriodDays; onChange: (value: PeriodDays) => void }) {
  return (
    <div className="period-selector" role="group" aria-label="Период">
      {options.map((option) => (
        <button
          key={option.label}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
