/** Pure Networks v1 compatibility layer. Does not touch SEP/L documents. */
export type NetworkCategory = "P1" | "P2" | "P3" | "G" | "S" | "REVIEW" | "REJECT";
export type NetworkQueue = "candidate" | "needs_review" | "date_unknown" | "archive";
export type NetworkCard = {
  schema_version: "networks.v1";
  platform: "tiktok";
  item_id: string;
  source_url: string;
  category: NetworkCategory;
  queue: NetworkQueue;
  title: string;
  text_excerpt: string;
  transcript_excerpt?: string;
  publication: { published_at?: string | null; date_status?: string; eligible_for_daily?: boolean };
  discovered_at?: string | null;
  generated_at?: string | null;
  review_status?: string;
  review?: { decision?: string; category_override?: NetworkCategory | null; note?: string; revision?: number };
  operator_category?: NetworkCategory | null;
  evidence?: Array<{ quote?: string; origin?: string; speaker_verified?: boolean }>;
  reasons?: string[];
  needs_media?: boolean;
  is_original_appeal_verified?: boolean;
  already_reported?: boolean;
  [key: string]: unknown;
};

const VALID_CATEGORIES = new Set(["P1", "P2", "P3", "G", "S", "REVIEW", "REJECT"]);
const VALID_QUEUES = new Set(["candidate", "needs_review", "date_unknown", "archive"]);
const MAX_CARDS = 20_000;

export function isTikTokVideoUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && (url.hostname === "tiktok.com" || url.hostname === "www.tiktok.com")
      && /^\/@[^/]+\/video\/\d+\/?$/.test(url.pathname);
  } catch { return false; }
}

export function importNetworkCards(text: string): NetworkCard[] {
  if (text.length > 22_000_000) throw new Error("Файл networks_cards.jsonl слишком большой (более 22 МБ).");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length || lines.length > MAX_CARDS) throw new Error("Файл пуст или содержит слишком много карточек.");
  const cards = new Map<string, NetworkCard>();
  for (const [index, line] of lines.entries()) {
    let item: unknown;
    try { item = JSON.parse(line); } catch { throw new Error(`Некорректный JSON в строке ${index + 1}.`); }
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Некорректная карточка: строка ${index + 1}.`);
    const card = item as NetworkCard;
    const match = typeof card.source_url === "string" ? card.source_url.match(/\/video\/(\d+)/) : null;
    if (card.schema_version !== "networks.v1" || card.platform !== "tiktok"
      || !isTikTokVideoUrl(card.source_url) || !match || card.item_id !== `tiktok:${match[1]}`
      || !VALID_CATEGORIES.has(card.category) || !VALID_QUEUES.has(card.queue)
      || !card.publication || typeof card.publication !== "object") {
      throw new Error(`Несовместимая карточка networks.v1, строка ${index + 1}. Импорт отменён.`);
    }
    if (card.queue === "date_unknown" && card.publication.published_at) {
      throw new Error(`Противоречивая дата в строке ${index + 1}. Импорт отменён.`);
    }
    const safeCard: NetworkCard = {
      ...card,
      title: String(card.title || "").slice(0, 1200),
      text_excerpt: String(card.text_excerpt || "").slice(0, 2500),
      transcript_excerpt: String(card.transcript_excerpt || "").slice(0, 5000),
      evidence: Array.isArray(card.evidence) ? card.evidence.slice(0, 15) : [],
      reasons: Array.isArray(card.reasons) ? card.reasons.filter((v): v is string => typeof v === "string").slice(0, 15) : [],
    };
    const previous = cards.get(card.item_id);
    if (!previous || String(safeCard.generated_at || "") >= String(previous.generated_at || "")) cards.set(card.item_id, safeCard);
  }
  return [...cards.values()];
}

export function mergeNetworkCards(existing: NetworkCard[], incoming: NetworkCard[]): NetworkCard[] {
  const merged = new Map<string, NetworkCard>(existing.map((card) => [card.item_id, card]));
  for (const next of incoming) {
    const previous = merged.get(next.item_id);
    if (previous && String(previous.generated_at || "") > String(next.generated_at || "")) continue;
    // An operator decision must not be overwritten by a later automatic classification.
    if (previous?.review?.decision && previous.review.decision !== "unreviewed") {
      merged.set(next.item_id, {
        ...next, review: previous.review, review_status: previous.review_status,
        operator_category: previous.operator_category,
      });
    } else merged.set(next.item_id, next);
  }
  return [...merged.values()].sort((a, b) => cardTimestamp(b) - cardTimestamp(a) || a.item_id.localeCompare(b.item_id));
}

export function cardTimestamp(card: NetworkCard): number {
  return Date.parse(card.publication?.published_at || card.discovered_at || card.generated_at || "") || 0;
}

export function publishedTimestamp(card: NetworkCard): number {
  // Don't invent publication dates from first discovery time.
  const value = card.publication?.published_at;
  return value && card.publication.date_status === "verified_original" ? (Date.parse(value) || 0) : 0;
}

export function effectiveCategory(card: NetworkCard): NetworkCategory {
  return card.review?.decision === "confirmed" && card.review?.category_override
    ? card.review.category_override : card.category;
}

export const NETWORK_GROUPS: NetworkCategory[] = ["P1", "P2", "P3", "G", "S", "REVIEW"];
export function networkCategoryName(category: NetworkCategory, be: boolean): string {
  const labels: Record<NetworkCategory, [string, string]> = {
    P1: ["Обращения к президенту Беларуси", "Звароты да прэзідэнта Беларусі"],
    P2: ["Жалобы на местные проблемы и работу служб", "Скаргі на мясцовыя праблемы і працу службаў"],
    P3: ["Обращения к республиканским ведомствам", "Звароты да рэспубліканскіх ведамстваў"],
    G: ["Общественные проблемы", "Грамадскія праблемы"],
    S: ["Вторичные сообщения о жалобах", "Другасныя паведамленні пра скаргі"],
    REVIEW: ["Требуют проверки", "Патрабуюць праверкі"],
    REJECT: ["Исключённые", "Выключаныя"],
  };
  return labels[category][be ? 1 : 0];
}

export function networkTrend(cards: NetworkCard[], days: number | null, now = Date.now()): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  const min = days === null ? -Infinity : now - days * 86_400_000;
  const max = now + 86_400_000;
  for (const card of cards) {
    if (card.queue === "archive" || effectiveCategory(card) === "REJECT") continue;
    const time = publishedTimestamp(card);
    if (time <= 0 || time < min || time > max) continue;
    const day = new Date(time).toISOString().slice(0, 10);
    counts.set(day, (counts.get(day) || 0) + 1);
  }
  if (!counts.size) return [];
  const start = days === null
    ? Math.min(...[...counts.keys()].map((date) => Date.parse(date + "T00:00:00Z")))
    : now - (days - 1) * 86_400_000;
  const startDate = new Date(start).toISOString().slice(0, 10);
  const lastDate = new Date(now).toISOString().slice(0, 10);
  const result: Array<{ label: string; count: number }> = [];
  for (let date = startDate, n = 0; date <= lastDate && n < 5000; n++) {
    result.push({ label: date, count: counts.get(date) || 0 });
    date = new Date(Date.parse(date + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  }
  return result;
}
