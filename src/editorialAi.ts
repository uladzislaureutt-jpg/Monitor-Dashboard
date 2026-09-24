import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "./workroom";
import { compressionRange, compressionReduction, effectiveCompressionMode, type CompressionMode } from "./editorialCompression";

export type EditorialAiResult = {
  compressedText: string;
  reductionPct: number;
  model: string;
  mode: CompressionMode;
  effectiveMode: Exclude<CompressionMode, "auto">;
  attempts: number;
  fallback: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
};

function parsePayload(text: string) {
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { return { error: "invalid_response", detail: text }; }
}

export async function aiCompress(input: { text: string; mode: CompressionMode; title: string; source: string }): Promise<EditorialAiResult> {
  const config = loadWorkroomConfig();
  const current = loadWorkroomSession();
  if (!current) throw new Error("AI_AUTH_REQUIRED");
  const session = await ensureWorkroomSession(config, current);
  const response = await fetch(`${config.url.replace(/\/+$/, "")}/functions/v1/editorial-compress`, {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: input.text, mode: input.mode, title: input.title, source: input.source }),
  });
  const raw = await response.text();
  const payload = parsePayload(raw);
  if (!response.ok) {
    const code = String(payload.error || `HTTP_${response.status}`);
    const reason = payload.reason ? `: ${String(payload.reason)}` : "";
    throw new Error(`${code}${reason}`);
  }
  const compressedText = String(payload.compressed_text || "").trim();
  if (!compressedText) throw new Error("AI_CLIENT_INVALID_RESULT");
  const effectiveMode = (payload.effective_mode === "light" || payload.effective_mode === "standard" || payload.effective_mode === "maximum" || payload.effective_mode === "extract"
    ? payload.effective_mode
    : effectiveCompressionMode(input.text, input.mode)) as Exclude<CompressionMode, "auto">;
  const reductionPct = compressionReduction(input.text, compressedText);
  const range = compressionRange(effectiveMode);
  if (reductionPct < range.min || reductionPct > range.max) {
    throw new Error(`AI_CLIENT_REJECTED_RANGE:${reductionPct}:${range.min}-${range.max}`);
  }
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  return {
    compressedText,
    reductionPct,
    model: String(payload.model || "openai/gpt-oss-120b"),
    mode: (payload.mode === "light" || payload.mode === "standard" || payload.mode === "maximum" || payload.mode === "extract" ? payload.mode : "auto") as CompressionMode,
    effectiveMode,
    attempts: Math.max(1, Number(payload.attempts || (payload.retried === true ? 2 : 1))),
    fallback: typeof payload.fallback === "string" ? payload.fallback : null,
    usage: {
      promptTokens: Number(usage.prompt_tokens || 0),
      completionTokens: Number(usage.completion_tokens || 0),
      totalTokens: Number(usage.total_tokens || 0),
    },
  };
}
