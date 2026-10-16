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

function retrySeconds(value: unknown) {
  const text = String(value || "");
  const numeric = Number(text.match(/[0-9]+(?:\.[0-9]+)?/)?.[0] || 0);
  return Math.max(2, Math.min(75, Math.ceil(numeric || 12)));
}
function wait(ms: number) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

async function call(body: Record<string, unknown>, onRetry?: RetryNotice) {
  const config = loadWorkroomConfig();
  const current = loadWorkroomSession();
  if (!current) throw new Error("W_REVIEW_AUTH_REQUIRED");
  const session = await ensureWorkroomSession(config, current);
  const appVersion = await getVersion().catch(() => "0.0.0");
  for (let attempt = 0; attempt < 8; attempt += 1) {
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
    if (response.status === 429 && attempt < 7) {
      const seconds = retrySeconds(payload.retry_after);
      onRetry?.(seconds);
      await wait(seconds * 1000);
      continue;
    }
    const retry = payload.retry_after ? `: retry_after=${payload.retry_after}` : "";
    throw new Error(`${String(payload.error || `HTTP_${response.status}`)}${retry}${payload.detail ? `: ${String(payload.detail).slice(0, 350)}` : ""}`);
  }
  throw new Error("groq_rate_limit");
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

export async function wVerifyReview(input: {
  task: string;
  reviewText: string;
  evidenceCards: string[];
}, onRetry?: RetryNotice) {
  const payload = await call({
    action: "verify_review",
    task: input.task,
    review_text: input.reviewText,
    evidence_cards: input.evidenceCards,
  }, onRetry);
  const raw = payload.fact_check || {};
  return {
    verifiedText: String(payload.verified_text || "").trim(),
    factCheck: {
      verified: raw.verified === true,
      claimsTotal: Math.max(0, Number(raw.claims_total || 0)),
      supportedClaims: Math.max(0, Number(raw.supported_claims || 0)),
      partialClaimsRewritten: Math.max(0, Number(raw.partial_claims_rewritten || 0)),
      unsupportedClaimsRemoved: Math.max(0, Number(raw.unsupported_claims_removed || 0)),
      suspiciousAnchors: Math.max(0, Number(raw.suspicious_anchors || 0)),
      issues: Array.isArray(raw.issues) ? raw.issues.map((value: unknown) => String(value || "").trim()).filter(Boolean) : [],
    } satisfies WFactCheck,
    model: String(payload.model || "gemini-3.5-flash-lite"),
    usage: usage(payload.usage),
  };
}

export async function wSynthesize(input: {
  task: string;
  targetChars: number;
  evidenceCards: string[];
  styleProfile: string;
  trends: WEditorialTrend[];
  density: { quotes: WDensity; headlines: WDensity; experts: WDensity };
  sourceNames: string[];
}, onRetry?: RetryNotice) {
  const baseBody = {
    task: input.task,
    target_chars: input.targetChars,
    evidence_cards: input.evidenceCards,
    style_profile: input.styleProfile,
    trends: input.trends,
    density: input.density,
    source_names: input.sourceNames,
  };
  let payload = await call({ action: "synthesize", ...baseBody }, onRetry);
  let totalUsage = usage(payload.usage);
  let reviewText = String(payload.review_text || "");
  let sectionTitles = Array.isArray(payload.section_titles) ? payload.section_titles.map((value: unknown) => String(value || "").trim()).filter(Boolean) : [];
  let boldPhrases = Array.isArray(payload.bold_phrases) ? payload.bold_phrases.map((value: unknown) => String(value || "").trim()).filter(Boolean) : [];

  if (reviewText.length < Math.floor(input.targetChars * 0.88)) {
    payload = await call({ action: "expand_review", ...baseBody, draft: reviewText }, onRetry);
    const extra = usage(payload.usage);
    totalUsage = {
      promptTokens: totalUsage.promptTokens + extra.promptTokens,
      completionTokens: totalUsage.completionTokens + extra.completionTokens,
      totalTokens: totalUsage.totalTokens + extra.totalTokens,
    };
    reviewText = String(payload.review_text || reviewText);
    sectionTitles = Array.isArray(payload.section_titles) ? payload.section_titles.map((value: unknown) => String(value || "").trim()).filter(Boolean) : sectionTitles;
    boldPhrases = Array.isArray(payload.bold_phrases) ? payload.bold_phrases.map((value: unknown) => String(value || "").trim()).filter(Boolean) : boldPhrases;
  }

  let verification: Awaited<ReturnType<typeof wVerifyReview>> | null = null;
  let verificationError = "";
  try {
    verification = await wVerifyReview({task: input.task, reviewText, evidenceCards: input.evidenceCards}, onRetry);
  } catch (reason) {
    verificationError = String(reason);
  }
  if (verification) {
    totalUsage = {
      promptTokens: totalUsage.promptTokens + verification.usage.promptTokens,
      completionTokens: totalUsage.completionTokens + verification.usage.completionTokens,
      totalTokens: totalUsage.totalTokens + verification.usage.totalTokens,
    };
    reviewText = verification.verifiedText || reviewText;
  }
  sectionTitles = sectionTitles.filter((value: string) => reviewText.includes(value));
  boldPhrases = boldPhrases.filter((value: string) => reviewText.includes(value));

  return {
    reviewText,
    sectionTitles,
    boldPhrases,
    factCheck: verification?.factCheck ?? {
      verified: false, claimsTotal: 0, supportedClaims: 0,
      partialClaimsRewritten: 0, unsupportedClaimsRemoved: 0,
      suspiciousAnchors: 0, issues: ["Проверка фактов не завершена. Не экспортируйте обзор без повторной проверки."],
    },
    verificationError,
    model: String(payload.model || "openai/gpt-oss-120b"),
    verifierModel: verification?.model || "",
    usage: totalUsage,
  };
}
