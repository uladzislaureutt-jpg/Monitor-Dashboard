import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "./workroom";

export type WUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

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

export async function wSynthesize(input: { task: string; targetChars: number; model: "openai/gpt-oss-120b" | "openai/gpt-oss-20b"; evidenceCards: string[]; styleProfile: string }) {
  const payload = await call({
    action: "synthesize",
    task: input.task,
    target_chars: input.targetChars,
    model: input.model,
    evidence_cards: input.evidenceCards,
    style_profile: input.styleProfile,
  });
  return { reviewText: String(payload.review_text || ""), model: String(payload.model || input.model), usage: usage(payload.usage) };
}
