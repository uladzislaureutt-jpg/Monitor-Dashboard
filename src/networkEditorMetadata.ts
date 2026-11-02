import type { NetworkCard } from "./networks";

/** Frozen discovery context, distinct from the editable transcription. */
export type TikTokSourceContext = { title: string; description: string };
export type TikTokSourceContextMap = Record<string, TikTokSourceContext>;

export function contextFromCard(card: Pick<NetworkCard, "title" | "text_excerpt" | "transcript_excerpt">): TikTokSourceContext {
  return {
    title: String(card.title || "").trim().slice(0, 1200),
    description: String(card.text_excerpt || card.transcript_excerpt || "").trim().slice(0, 5000),
  };
}

export function normalizeSourceContext(raw: unknown): TikTokSourceContextMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: TikTokSourceContextMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(result).length >= 500 || typeof value !== "object" || value === null || Array.isArray(value)) break;
    if (!/^https:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/\d+\/?$/.test(key)) continue;
    const candidate = value as Partial<TikTokSourceContext>;
    result[key] = {
      title: typeof candidate.title === "string" ? candidate.title.slice(0, 1200) : "",
      description: typeof candidate.description === "string" ? candidate.description.slice(0, 5000) : "",
    };
  }
  return result;
}

/** Never replace the original description with an AI transcript or a later scraper refresh. */
export function rememberSourceContext(
  existing: TikTokSourceContextMap, url: string, incoming: TikTokSourceContext
): TikTokSourceContextMap {
  if (existing[url]) return existing;
  if (!incoming.title && !incoming.description) return existing;
  return { ...existing, [url]: incoming };
}
