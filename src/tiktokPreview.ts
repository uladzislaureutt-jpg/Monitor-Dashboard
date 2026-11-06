/** Optional TikTok poster/cover/selected-frame contract shared by import and cards.
 * A small embedded JPEG/PNG/WebP data URI is allowed for extracted local frames;
 * untrusted SVG, HTTP, private hosts and oversized payloads are never rendered.
 * Image absence is normal: no generic or unrelated placeholder is substituted.
 */
export type PreviewFields = {
  preview_image_url?: unknown;
  preview_image_data_url?: unknown;
  thumbnail_url?: unknown;
  thumbnail_data_url?: unknown;
  cover_url?: unknown;
  cover_image_url?: unknown;
  poster_url?: unknown;
  image_url?: unknown;
  preview_image?: unknown;
  thumbnail?: unknown;
  media?: unknown;
};

const MAX_URL_CHARS = 4096;
const MAX_INLINE_CHARS = 28000; // ~20 KiB image compressed at the source
const INLINE_IMAGE = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

function safeHost(host: string): boolean {
  const value = host.toLowerCase();
  if (!value || value === "localhost" || value.endsWith(".localhost") ||
      value.endsWith(".local") || value.endsWith(".internal")) return false;
  if (value.startsWith("[") || value.includes(":")) return false; // no IP literals
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
  return value.includes(".");
}

export function safeTikTokPreviewUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const src = value.trim();
  if (!src) return null;
  if (src.toLowerCase().startsWith("data:")) {
    if (src.length > MAX_INLINE_CHARS) return null;
    const matched = INLINE_IMAGE.exec(src);
    if (!matched || matched[1].length % 4 === 1) return null;
    return src;
  }
  if (src.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" || url.username || url.password ||
      !safeHost(url.hostname)) return null;
    if (/\.svg(?:$|[?#])/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function objectFields(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

/** Accept both the canonical field and commonly emitted scraper aliases. */
export function tikTokPreviewUrl(raw: PreviewFields | null | undefined): string | null {
  if (!raw) return null;
  const preview = objectFields(raw.preview_image);
  const thumb = objectFields(raw.thumbnail);
  const media = objectFields(raw.media);
  const candidates: unknown[] = [
    raw.preview_image_url, raw.preview_image_data_url,
    raw.thumbnail_url, raw.thumbnail_data_url,
    raw.cover_url, raw.cover_image_url, raw.poster_url, raw.image_url,
    preview?.url, preview?.data_url, thumb?.url, thumb?.data_url,
    media?.thumbnail_url, media?.cover_url, media?.preview_image_url,
  ];
  for (const candidate of candidates) {
    const safe = safeTikTokPreviewUrl(candidate);
    if (safe) return safe;
  }
  return null;
}

/** Canonicalize once; this field survives GitHub JSONL and cloud JSONB sync. */
export function withTikTokPreview<T extends PreviewFields>(card: T, fallback?: PreviewFields): T {
  const safe = tikTokPreviewUrl(card) || tikTokPreviewUrl(fallback);
  if (!safe) return card;
  return { ...card, preview_image_url: safe };
}
