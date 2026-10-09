import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "./workroom";

export type WUsage = { promptTokens: number; completionTokens: number; totalTokens: number };
export type WDensity = "minimum" | "moderate" | "many";
export type WEditorialTrend = { id: string; title: string; summary: string; sources: string[] };
export type WEditorialMap = {
  trends: WEditorialTrend[];
  inventory: { quotes: number; headlines: number; experts: number };
};

async function call(body: Record<string, unknown>) {
  const config = loadWorkroomConfig();
  const current = loadWorkroomSession();
  if (!current) throw new Error("W_REVIEW_AUTH_REQUIRED");
  const session = await ensureWorkroomSession(config, current);
  const response = await fetch(`${config.url.replace(/\/+$/, "")}/functions/v1/w-review-ai`, {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload: any;
  try { payload = JSON.parse(raw); } catch { payload = { error: "invalid_response", detail: raw }; }
  if (!response.ok) {
    const retry = payload.retry_after ? `: retry_after=${payload.retry_after}` : "";
    throw new Error(`${String(payload.error || `HTTP_${response.status}`)}${retry}`);
  }
  return payload;
}

function usage(value: any): WUsage {
  return {
    promptTokens: Number(value?.prompt_tokens || 0),
    completionTokens: Number(value?.completion_tokens || 0),
    totalTokens: Number(value?.total_tokens || 0),
  };
}

export async function wEvidence(input: { title: string; source: string; text: string }) {
  const payload = await call({ action: "evidence", ...input });
  return { evidence: String(payload.evidence || ""), model: String(payload.model || "openai/gpt-oss-20b"), usage: usage(payload.usage) };
}

export async function wStyleProfile(samples: string[]) {
  const payload = await call({ action: "style_profile", samples });
  return { styleProfile: String(payload.style_profile || ""), model: String(payload.model || "openai/gpt-oss-20b"), usage: usage(payload.usage) };
}

export async function wEditorialMap(input: { task: string; evidenceCards: string[] }) {
  const payload = await call({ action: "editorial_map", task: input.task, evidence_cards: input.evidenceCards });
  const raw = payload.editorial_map || {};
  const trends = Array.isArray(raw.trends) ? raw.trends.slice(0, 4).map((item: any, index: number) => ({
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
  targetChars: number;
  model: "openai/gpt-oss-120b" | "openai/gpt-oss-20b";
  evidenceCards: string[];
  styleProfile: string;
  trends: WEditorialTrend[];
  density: { quotes: WDensity; headlines: WDensity; experts: WDensity };
}) {
  const payload = await call({
    action: "synthesize",
    task: input.task,
    target_chars: input.targetChars,
    model: input.model,
    evidence_cards: input.evidenceCards,
    style_profile: input.styleProfile,
    trends: input.trends,
    density: input.density,
  });
  return { reviewText: String(payload.review_text || ""), model: String(payload.model || input.model), usage: usage(payload.usage) };
}
