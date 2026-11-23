export type QuickEventPeriodDays = 1 | 3 | 7 | 30;

export const QUICK_EVENT_PERIODS: readonly QuickEventPeriodDays[] = [1, 3, 7, 30];

/** All date-only event searches use the Europe/Minsk calendar, not the user's OS timezone. */
export function todayInMinsk(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Minsk", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)?.value || "";
  return [part("year"), part("month"), part("day")].join("-");
}

/** Inclusive range: a 1-day preset means today, 3 days includes today and the previous 2. */
export function quickEventRange(days: QuickEventPeriodDays, today = todayInMinsk()) {
  const start = new Date(today + "T12:00:00Z");
  if (Number.isNaN(start.getTime())) throw new Error("invalid_event_date");
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { from: start.toISOString().slice(0, 10), through: today };
}

export function formatEventDate(date: string) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return matched ? `${matched[3]}.${matched[2]}.${matched[1]}` : date;
}
