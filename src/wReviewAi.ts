import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "./workroom";
import { getVersion } from "@tauri-apps/api/app";

export type WUsage = { promptTokens: number; completionTokens: number; totalTokens: number };
export type WDensity = "minimum" | "moderate" | "many" | "all";
export type WEditorialTrend = { id: string; title: string; summary: string; sources: string[] };
export type WFactCheck = {
  verified: boolean;
  claimsTotal: number;
  supportedClaims: number;
  partialClaimsRewritten: number;
  unsupportedClaimsRemoved: number;
  suspiciousAnchors: number;
  issues: string[];
};
export type WEditorialMap = {
  trends: WEditorialTrend[];
  inventory: { quotes: number; headlines: number; experts: number };
};

type RetryNotice = (seconds: number) => void;
type EvidenceInput = { title: string; source: string; text: string };

function retrySeconds(value: unknown): number | null {
  // Never guess a wait time for quota exhaustion; only honor short provider hints.
  const raw = String(value || "").trim();
  if (!/^\d+(?:\.\d+)?s?$/.test(raw)) return null;
  const seconds = Math.max(2, Math.ceil(Number(raw.replace(/s$/, ""))));
  return seconds <= 12 ? seconds : null;
}
function wait(ms: number) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

async function call(body: Record<string, unknown>, onRetry?: RetryNotice) {
  const config = loadWorkroomConfig();
  const current = loadWorkroomSession();
  if (!current) throw new Error("W_REVIEW_AUTH_REQUIRED");
  const session = await ensureWorkroomSession(config, current);
  const appVersion = await getVersion().catch(() => "0.0.0");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${config.url.replace(/\/+$/, "")}/functions/v1/w-review-ai`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, app_version: appVersion }),
    });
    const raw = await response.text();
    let payload: any;
    try { payload = JSON.parse(raw); } catch { payload = { error: "invalid_response", detail: raw }; }
    if (response.ok) return payload;
    const seconds = retrySeconds(payload.retry_after);
    // A daily Gemini quota, an unclassified 429, or a failed fallback must not be retried.
    if (response.status === 429 && payload.retryable === true && seconds !== null && attempt === 0) {
      onRetry?.(seconds);
      await wait(seconds * 1000);
      continue;
    }
    const issue = payload?.issue && typeof payload.issue === "object" ? payload.issue : null;
    const kind = typeof issue?.kind === "string" ? ` [${issue.kind}]` : "";
    const metric = typeof issue?.quota_metric === "string" && issue.quota_metric ? ` [${issue.quota_metric}]` : "";
    const detail = payload.detail ? `: ${String(payload.detail).slice(0, 220)}` : "";
    throw new Error(`${String(payload.error || `HTTP_${response.status}`)}${kind}${metric}${detail}`);
  }
  throw new Error("W_REVIEW_RETRIES_EXHAUSTED");
}

function usage(value: any): WUsage {
  return {
    promptTokens: Number(value?.prompt_tokens || 0),
    completionTokens: Number(value?.completion_tokens || 0),
    totalTokens: Number(value?.total_tokens || 0),
  };
}

export async function wEvidenceBatch(items: EvidenceInput[], onRetry?: RetryNotice) {
  const payload = await call({ action: "evidence_batch", items }, onRetry);
  const cards = Array.isArray(payload.cards) ? payload.cards.map((card: any) => ({
    index: Number(card?.index || 0),
    evidence: String(card?.evidence || "").trim(),
  })) : [];
  return { cards, model: String(payload.model || "openai/gpt-oss-20b"), usage: usage(payload.usage) };
}

export async function wStyleProfile(samples: string[], onRetry?: RetryNotice) {
  const payload = await call({ action: "style_profile", samples }, onRetry);
  return { styleProfile: String(payload.style_profile || ""), model: String(payload.model || "openai/gpt-oss-20b"), usage: usage(payload.usage) };
}

export async function wEditorialMap(input: { task: string; evidenceCards: string[] }, onRetry?: RetryNotice) {
  const payload = await call({ action: "editorial_map", task: input.task, evidence_cards: input.evidenceCards }, onRetry);
  const raw = payload.editorial_map || {};
  const trends = Array.isArray(raw.trends) ? raw.trends.slice(0, 5).map((item: any, index: number) => ({
    id: String(item?.id || `trend-${index + 1}`),
    title: String(item?.title || "").trim(),
    summary: String(item?.summary || "").trim(),
    sources: Array.isArray(item?.sources) ? item.sources.map((value: unknown) => String(value)).filter(Boolean) : [],
  })).filter((item: WEditorialTrend) => item.title) : [];
  const inventory = raw.inventory || {};
  return {
    editorialMap: {
      trends,
      inventory: {
        quotes: Math.max(0, Number(inventory.quotes || 0)),
        headlines: Math.max(0, Number(inventory.headlines || 0)),
        experts: Math.max(0, Number(inventory.experts || 0)),
      },
    } satisfies WEditorialMap,
    model: String(payload.model || "openai/gpt-oss-20b"),
    usage: usage(payload.usage),
  };
}

export async function wSynthesize(input: {
  task: string;
  topicKey: string;
  targetChars: number;
  evidenceCards: string[];
  styleProfile: string;
  styleExcerpts: Array<{name:string;text:string}>;
  trends: WEditorialTrend[];
  density: { quotes: WDensity; headlines: WDensity; experts: WDensity };
  sourceNames: string[];
}, onRetry?: RetryNotice) {
  const baseBody = {
    task: input.task,
    topic_key: input.topicKey,
    target_chars: input.targetChars,
    evidence_cards: input.evidenceCards,
    style_profile: input.styleProfile,
    style_excerpts: input.styleExcerpts,
    trends: input.trends,
    density: input.density,
    source_names: input.sourceNames,
  };
  // Cloudflare receives the complete evidence pool in a single synthesis request.
  const payload = await call({action:"synthesize",...baseBody,target_chars:Math.min(8000,input.targetChars)},onRetry);
  const reviewText = String(payload.review_text || "").trim();
  if (!reviewText) throw new Error("W_REVIEW_EMPTY_SYNTHESIS");
  const sectionTitles: string[] = Array.isArray(payload.section_titles)
    ? payload.section_titles.map((v:unknown)=>String(v||"").trim()).filter((v:string)=>Boolean(v)&&reviewText.includes(v)) : [];
  const boldPhrases: string[] = Array.isArray(payload.bold_phrases)
    ? payload.bold_phrases.map((v:unknown)=>String(v||"").trim()).filter((v:string)=>Boolean(v)&&reviewText.includes(v)) : [];
  return {
    reviewText,
    sectionTitles,
    boldPhrases,
    model: String(payload.model || "@cf/openai/gpt-oss-120b"),
    usage: usage(payload.usage),
    preflightWarnings: Array.isArray(payload.preflight_warnings) ? payload.preflight_warnings.map(String).slice(0, 6) : [] as string[],
    targetChars: Number(payload.target_chars || input.targetChars),
    actualChars: Number(payload.actual_chars || reviewText.length),
    lengthWithinTolerance: payload.length_within_tolerance === true,
  };
}
