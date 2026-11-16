/** Pure Networks v1 compatibility layer. Does not touch SEP/L documents. */
export type NetworkCategory = "P1" | "P2" | "P3" | "G" | "S" | "REVIEW" | "REJECT";
export type NetworkQueue = "candidate" | "needs_review" | "date_unknown" | "archive";
export type TikTokSection = "appeals" | "complaints" | "review";
export type TikTokMoveSection = Exclude<TikTokSection, "review">;
export type NetworkReviewLane = "main" | "gemini_veto" | "triage";
export type NetworkCard = {
  schema_version: "networks.v1";
  platform: "tiktok";
  item_id: string;
  source_url: string;
  preview_image_url?: string | null;
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
  included_in_current_overview?: boolean;
  report_suppressed?: boolean;
  operator_lane?: string;
  review_displayed?: boolean;
  operator_reported_run?: number;
  operator_display_section?: TikTokSection;
  operator_display_group?: string;
  operator_review_rank?: number;
  operator_review_reason?: string;
  operator_review_lane?: NetworkReviewLane;
  operator_review_seen_run?: number;
  operator_review_model_proposed?: string;
  operator_review_gate_reason?: string;
  operator_review_stage?: string;
  operator_review_action?: string;
  operator_review_proof_gaps?: string;
  operator_review_source_category?: string;
  operator_review_triage_lane?: string;
  operator_review_score?: number;
  operator_review_triage_reason?: string;
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

/** Never render arbitrary imported URLs, data SVGs or oversized embedded media. */
export function safeTikTokPreview(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40000) return null;
  if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (u.protocol !== "https:" || u.username || u.password || raw.length > 1800) return null;
    if (["tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com"].some(
      (root) => host === root || host.endsWith("." + root))) return raw;
  } catch { /* Reject malformed images. */ }
  return null;
}

export function isTikTokPostUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "tiktok.com" || u.hostname === "www.tiktok.com")
      && /^\/@[^/]+\/(?:video|photo)\/\d+\/?$/.test(u.pathname);
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
    const match = typeof card.source_url === "string" ? card.source_url.match(/\/(?:video|photo)\/(\d+)/) : null;
    if (card.schema_version !== "networks.v1" || card.platform !== "tiktok"
      || !isTikTokPostUrl(card.source_url) || !match || card.item_id !== `tiktok:${match[1]}`
      || !VALID_CATEGORIES.has(card.category) || !VALID_QUEUES.has(card.queue)
      || !card.publication || typeof card.publication !== "object") {
      throw new Error(`Несовместимая карточка networks.v1, строка ${index + 1}. Импорт отменён.`);
    }
    if (card.queue === "date_unknown" && card.publication.published_at) {
      throw new Error(`Противоречивая дата в строке ${index + 1}. Импорт отменён.`);
    }
    const safeCard: NetworkCard = {
      ...card,
      preview_image_url: safeTikTokPreview(card.preview_image_url),
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
  for (const input of incoming) {
    const previous = merged.get(input.item_id);
    const existingPreview = safeTikTokPreview(previous?.preview_image_url);
    const incomingPreview = safeTikTokPreview(input.preview_image_url);
    const next = { ...input, preview_image_url: incomingPreview || existingPreview };
    // Preview-only enrichment must survive even when this device already has
    // a newer operator record. Never roll back that operator verdict.
    const preservePrevious = () => {
      if (previous && !existingPreview && incomingPreview)
        merged.set(previous.item_id, { ...previous, preview_image_url: incomingPreview });
    };
    const incomingSection = networkOperatorSection(next);
    const previousSection = previous ? networkOperatorSection(previous) : null;
    const incomingFinal = incomingSection != null && incomingSection !== "review";
    const previousFinal = previousSection != null && previousSection !== "review";
    if (previous && previousFinal && !incomingFinal) { preservePrevious(); continue; }
    if (previousSection === "review" && incomingSection === null) { preservePrevious(); continue; }
    const previousRun = previous ? operatorRun(previous) : 0;
    const nextRun = operatorRun(next);
    if (previous && previousSection !== null && previousFinal === incomingFinal
      && (previousRun > nextRun || (previousRun === nextRun &&
        ((previous.operator_display_section && !next.operator_display_section)
          || Boolean(previous.operator_display_section) === Boolean(next.operator_display_section)
            && String(previous.generated_at || "") > String(next.generated_at || ""))))) {
      preservePrevious();
      continue;
    }
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

/** Match the final operator report, NOT discovery output or pre-AI candidates. */
export function includedInOperatorOverview(card: NetworkCard): boolean {
  if (card.report_suppressed === true || card.included_in_current_overview !== true) return false;
  if (card.publication?.eligible_for_daily !== true || publishedTimestamp(card) <= 0) return false;
  if (effectiveCategory(card) === "REJECT") return false;
  return card.operator_lane === "candidate"
    || (card.operator_lane === "review" && card.review_displayed === true);
}

/** Review visibility is not publication approval; never reuse it for charts. */
export function isNetworkOperatorReview(card: NetworkCard): boolean {
  return (card.operator_review_lane === "gemini_veto" || card.operator_review_lane === "triage")
    && card.included_in_current_overview === false
    && card.report_suppressed === true
    && card.already_reported !== true
    && Number.isSafeInteger(card.operator_review_seen_run)
    && (card.operator_review_seen_run || 0) > 0;
}
export function isNetworkOperatorVisible(card: NetworkCard): boolean {
  return includedInOperatorOverview(card) || isNetworkOperatorReview(card);
}
export const TIKTOK_SECTIONS: TikTokSection[] = ["appeals", "complaints", "review"];
const SECTION_LABELS: Record<TikTokSection, [string, string]> = {
  appeals: ["Обращения", "Звароты"],
  complaints: ["Жалобы на местные проблемы и работу служб", "Скаргі на мясцовыя праблемы і працу службаў"],
  review: ["Требуют проверки", "Патрабуюць праверкі"],
};
export function networkSectionName(section: TikTokSection, be: boolean): string {
  return SECTION_LABELS[section][be ? 1 : 0];
}

export function networkOperatorSection(card: NetworkCard, decision?: TikTokMoveSection): TikTokSection | null {
  if ((decision === "appeals" || decision === "complaints") && isNetworkOperatorVisible(card)) return decision;
  if (isNetworkOperatorReview(card)) return "review";
  if (!includedInOperatorOverview(card)) return null;
  const category = effectiveCategory(card);
  if (category === "REVIEW" || card.operator_display_section === "review") return "review";
  if (category === "P1" || category === "P3") return "appeals";
  return card.operator_display_section === "appeals" && category === card.category
    ? "appeals" : "complaints";
}

export function operatorRun(card: NetworkCard): number {
  const run = card.operator_reported_run ?? card.operator_review_seen_run ?? 0;
  return Number.isSafeInteger(run) && run > 0 ? run : 0;
}

export function latestOperatorRuns(cards: NetworkCard[], receipts: number[]): number[] {
  return [...new Set([...receipts, ...cards.filter(isNetworkOperatorVisible).map(operatorRun)])]
    .filter((run) => Number.isSafeInteger(run) && run > 0).sort((a, b) => b - a).slice(0, 2);
}

export function sortOperatorArchive(a: NetworkCard, b: NetworkCard): number {
  return publishedTimestamp(b) - publishedTimestamp(a)
    || operatorRun(b) - operatorRun(a) || a.item_id.localeCompare(b.item_id);
}

const REVIEW_LIMIT = 10;
const LEGACY_REVIEW_WEIGHT: Record<string, number> = {
  possible_false_reject: 8, presidential_media_priority: 7, firsthand_audio_review: 7,
  gemini_positive_veto: 5, near_review: 5, candidate: 4, visual_context_review: 2,
  hashtag_local_media_lead: 2, high_engagement_media: 1,
};

export function compareOperatorReview(a: NetworkCard, b: NetworkCard): number {
  const rank = (item: NetworkCard) => item.operator_review_rank || Number.MAX_SAFE_INTEGER;
  const score = (item: NetworkCard) => item.operator_review_lane === "main"
    ? 12 + (Number(item.review_score) || 0)
    : (item.operator_review_score || 0) + (LEGACY_REVIEW_WEIGHT[item.operator_review_triage_lane || ""] || 0);
  return rank(a) - rank(b) || score(b) - score(a) || sortOperatorArchive(a, b);
}

/** Retain the producer's shortlist and reduce pre-v3 archives to a bounded review sample. */
export function selectOperatorArchive(cards: NetworkCard[]): NetworkCard[] {
  const selected: NetworkCard[] = [];
  const reviewByRun = new Map<number, NetworkCard[]>();
  for (const card of cards) {
    const section = networkOperatorSection(card);
    if (!section) continue;
    if (section !== "review") {
      selected.push(card);
      continue;
    }
    const run = operatorRun(card);
    const group = card.operator_review_triage_lane || "";
    if (card.operator_display_section !== "review"
      && (card.geography_evidence as { status?: string } | undefined)?.status === "foreign_only") continue;
    if (card.operator_display_section !== "review" && card.operator_review_lane !== "main"
      && card.operator_review_lane !== "gemini_veto" && !Object.hasOwn(LEGACY_REVIEW_WEIGHT, group)) continue;
    const list = reviewByRun.get(run) || [];
    list.push(card);
    reviewByRun.set(run, list);
  }
  for (const reviews of reviewByRun.values()) {
    const ranked = reviews.filter((card) => card.operator_display_section === "review");
    selected.push(...(ranked.length ? ranked : reviews).sort(compareOperatorReview).slice(0, REVIEW_LIMIT));
  }
  return selected.sort(sortOperatorArchive);
}

export function operatorReviewLabel(card: NetworkCard, be: boolean): string {
  if (card.operator_review_lane === "gemini_veto") {
    return be ? "Gemini прапанаваў, фільтры панізілі ацэнку" : "Gemini предложил, фильтры понизили оценку";
  }
  switch (card.operator_review_reason || card.operator_review_triage_lane) {
    case "possible_false_reject":
      return be ? "Магчыма, адхілена памылкова" : "Возможный ошибочный отсев";
    case "comment_review":
      return be ? "У каментарах абмяркоўваюць скаргу" : "В комментариях обсуждают жалобу";
    case "pending_media":
    case "visual_context_review":
    case "presidential_media_priority":
    case "firsthand_audio_review":
      return be ? "Праверыць маўленне ці выяву" : "Проверить речь или изображение";
    default:
      return be ? "Праверыць першакрыніцу" : "Проверить первоисточник";
  }
}

export type NetworkModeration = { flagged: string[]; deleted: string[]; sections?: Record<string, TikTokMoveSection> };
export const EMPTY_NETWORK_MODERATION: NetworkModeration = { flagged: [], deleted: [] };
export function normalizeNetworkModeration(raw: unknown): NetworkModeration {
  if (!raw || typeof raw !== "object") return { ...EMPTY_NETWORK_MODERATION };
  const m = raw as Partial<NetworkModeration>;
  const clean = (value: unknown) => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^tiktok:\d+$/.test(item)))].slice(0, 20000) : [];
  const sections = Object.fromEntries(Object.entries(m.sections ?? {}).filter(([id, section]) =>
    /^tiktok:\d+$/.test(id) && (section === "appeals" || section === "complaints")));
  return { flagged: clean(m.flagged), deleted: clean(m.deleted), sections };
}

export function networkTrend(cards: NetworkCard[], days: number | null, now = Date.now(), decisions?: NetworkModeration["sections"]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  const min = days === null ? -Infinity : now - days * 86_400_000;
  const max = now + 86_400_000;
  for (const card of cards) {
    const section = networkOperatorSection(card, decisions?.[card.item_id]);
    if (!section || section === "review") continue;
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
