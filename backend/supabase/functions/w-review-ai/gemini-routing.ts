// W-Review explicit Gemini routing. A 3.5 Flash ID (non-Lite) aliases to 3.6
// at Google, therefore use the active 3.5 Flash-Lite endpoint explicitly.
export const W_REVIEW_GEMINI_PRIMARY = "gemini-3.5-flash-lite";
export const W_REVIEW_GEMINI_FALLBACK = "gemini-3.1-flash-lite";
export const W_REVIEW_GEMINI_ROUTES = [W_REVIEW_GEMINI_PRIMARY, W_REVIEW_GEMINI_FALLBACK] as const;

// The Gemini 3.5 Flash-Lite and later GenerateContent API no longer accepts
// legacy sampling config (temperature/topP/topK). Return a fresh whitelist.
export function wGeminiGenerationConfig(schema:unknown, options?:{
  maxOutputTokens?:number; thinkingLevel?:"minimal"|"low"|"medium"|"high"
}) {
  return {
    responseMimeType:"application/json",responseSchema:schema,
    ...(options?.maxOutputTokens?{maxOutputTokens:options.maxOutputTokens}:{}),
    ...(options?.thinkingLevel?{thinkingConfig:{thinkingLevel:options.thinkingLevel}}:{})
  };
}
