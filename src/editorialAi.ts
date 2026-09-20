import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "./workroom";
import type { CompressionMode } from "./editorialCompression";

export type EditorialAiResult = {
  compressedText: string;
  reductionPct: number;
  model: string;
  mode: CompressionMode;
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
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  return {
    compressedText: String(payload.compressed_text || ""),
    reductionPct: Number(payload.reduction_pct || 0),
    model: String(payload.model || "openai/gpt-oss-120b"),
    mode: (payload.mode === "light" || payload.mode === "standard" ? payload.mode : "auto") as CompressionMode,
    usage: {
      promptTokens: Number(usage.prompt_tokens || 0),
      completionTokens: Number(usage.completion_tokens || 0),
      totalTokens: Number(usage.total_tokens || 0),
    },
  };
}
