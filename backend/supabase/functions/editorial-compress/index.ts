const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CompressionMode = "auto" | "light" | "standard" | "maximum" | "extract";
type EffectiveMode = Exclude<CompressionMode, "auto">;
type CompressionRequest = { text?: string; mode?: CompressionMode; title?: string; source?: string };
type GroqCallResult = {
  compressedText: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function normalizeSpaces(value: string) { return value.replace(/\s+/g, " ").trim(); }
function sentenceCount(value: string) {
  return (value.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? []).map(normalizeSpaces).filter((part) => part.length >= 8).length;
}
function effectiveMode(mode: CompressionMode, text: string): EffectiveMode {
  if (mode !== "auto") return mode;
  return sentenceCount(text) <= 6 || normalizeSpaces(text).length < 900 ? "light" : "standard";
}
function ratioRange(mode: EffectiveMode) {
  if (mode === "light") return { minRatio: 0.86, maxRatio: 0.97, targetRatio: 0.92, label: "5–12%" };
  if (mode === "maximum") return { minRatio: 0.40, maxRatio: 0.60, targetRatio: 0.50, label: "40–60%" };
  if (mode === "extract") return { minRatio: 0.20, maxRatio: 0.40, targetRatio: 0.30, label: "60–80%" };
  return { minRatio: 0.58, maxRatio: 0.82, targetRatio: 0.70, label: "20–40%" };
}
function numericTokens(value: string) {
  return new Set((value.match(/\b\d[\d\s.,:%–—\-/]*\d\b|\b\d+\b/g) ?? []).map(normalizeSpaces));
}
function quotedSpans(value: string) {
  const result: string[] = [];
  for (const match of value.matchAll(/[«“\"]([^»”\"]{8,})[»”\"]/g)) result.push(normalizeSpaces(match[1] || ""));
  return result;
}
function suspiciousNames(value: string) {
  const result = new Set<string>();
  const re = /\b([А-ЯЁІЎA-Z][а-яёіўa-z'’\-]{2,}\s+[А-ЯЁІЎA-Z][а-яёіўa-z'’\-]{2,}(?:\s+[А-ЯЁІЎA-Z][а-яёіўa-z'’\-]{2,})?)\b/g;
  for (const match of value.matchAll(re)) result.add(normalizeSpaces(match[1] || ""));
  return result;
}
function wordSet(value: string) { return new Set((value.toLocaleLowerCase("ru-RU").match(/[a-zа-яёіў0-9'’\-]{3,}/g) ?? [])); }
function sourceSentences(value: string) {
  return (normalizeSpaces(value).match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? []).map(normalizeSpaces).filter((part) => part.length >= 8);
}
function sentenceGrounded(original: string, compressed: string) {
  const source = sourceSentences(original).map(wordSet);
  for (const sentence of sourceSentences(compressed)) {
    const words = wordSet(sentence);
    if (words.size < 3) continue;
    let best = 0;
    for (const candidate of source) {
      let common = 0;
      for (const word of words) if (candidate.has(word)) common += 1;
      best = Math.max(best, common / words.size);
    }
    if (best < 0.45) return false;
  }
  return true;
}
function exactSentenceScore(sentence: string, index: number, total: number) {
  const value = sentence.toLocaleLowerCase("ru-RU");
  let score = index === 0 ? 5 : index === total - 1 ? 1 : 0;
  if (/\d/.test(sentence)) score += 3;
  if (/[«“"][^»”"]{8,}[»”"]/.test(sentence)) score += 3;
  if (/(жалоб|жалу|проблем|возму|не хватает|нет |отсутств|опасн|аварийн|разруш|очеред|цена|зарплат|дорог|мусор|вод|свет|транспорт|поликлиник|школ|жкх)/i.test(value)) score += 3;
  if (/(ответ|сообщил|заявил|прокоммент|власти|исполком|министер|ведомств|прокуратур|служб|обещал|пообещал|реакц)/i.test(value)) score += 3;
  if (/(жител|горожан|читател|родител|водител|работник|пациент|пассажир)/i.test(value)) score += 1.5;
  if (sentence.length >= 70 && sentence.length <= 360) score += 1;
  if (/(напомним|ранее мы писали|читайте также|подробнее|фото:|источник:|источник информации|подписывайтесь|присоединяйтесь|наш канал|telegram|viber|бот|реклама)/i.test(value)) score -= 8;
  if (sentence.length < 35) score -= 1;
  return score;
}
function exactFallback(text: string, mode: EffectiveMode) {
  const source = normalizeSpaces(text);
  const sentences = sourceSentences(source);
  if (!source || sentences.length <= 3) return { text: source, reductionPct: 0 };
  const range = ratioRange(mode);
  const selected = new Set(sentences.map((_, index) => index));
  let selectedChars = sentences.reduce((sum, sentence) => sum + sentence.length + 1, 0);
  const removable = sentences.map((sentence, index) => ({ sentence, index, score: exactSentenceScore(sentence, index, sentences.length) }))
    .filter((item) => item.index !== 0).sort((a, b) => a.score - b.score || b.index - a.index);
  const minimumSentences = mode === "extract" ? 1 : mode === "maximum" ? 2 : 3;
  for (const item of removable) {
    if (selectedChars <= source.length * range.targetRatio || selected.size <= minimumSentences) break;
    const nextChars = selectedChars - item.sentence.length - 1;
    if (nextChars < source.length * range.minRatio) continue;
    selected.delete(item.index);
    selectedChars = nextChars;
  }
  const result = sentences.filter((_, index) => selected.has(index)).join(" ");
  return { text: result || source, reductionPct: Math.max(0, Math.round((1 - (result || source).length / source.length) * 1000) / 10) };
}
function validateCompression(original: string, compressed: string, mode: EffectiveMode) {
  const source = normalizeSpaces(original);
  const result = normalizeSpaces(compressed).replace(/\[\s*(?:…|\.{3})\s*\]/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!result) return { ok: false, reason: "empty_result", result, ratio: 0 };
  const ratio = result.length / Math.max(1, source.length);
  const range = ratioRange(mode);
  if (ratio < range.minRatio) return { ok: false, reason: "over_compressed", result, ratio };
  if (ratio > range.maxRatio) return { ok: false, reason: "under_compressed", result, ratio };
  const sourceNumbers = numericTokens(source);
  for (const token of numericTokens(result)) if (!sourceNumbers.has(token)) return { ok: false, reason: `new_number:${token}`, result, ratio };
  const sourceFolded = source.toLocaleLowerCase("ru-RU");
  for (const quote of quotedSpans(result)) if (!sourceFolded.includes(quote.toLocaleLowerCase("ru-RU"))) return { ok: false, reason: "changed_quote", result, ratio };
  for (const name of suspiciousNames(result)) if (!sourceFolded.includes(name.toLocaleLowerCase("ru-RU"))) return { ok: false, reason: `new_name:${name}`, result, ratio };
  if (!sentenceGrounded(source, result)) return { ok: false, reason: "sentence_not_grounded", result, ratio };
  return { ok: true, reason: "ok", result, ratio };
}
function instructions(mode: EffectiveMode, retryReason = "") {
  const range = ratioRange(mode);
  const targetPercent = Math.round((1 - range.targetRatio) * 100);
  const hardTarget = mode === "light"
    ? `Сократи текст примерно на ${range.label}. Итог должен быть заметно короче исходника, но не ниже 86% его длины.`
    : mode === "extract"
      ? `Подготовь экстракт: сократи текст примерно на ${range.label}; целевой ориентир — около ${targetPercent}%. Итог должен занимать строго 20–40% длины исходника. Оставь только ядро сюжета: что произошло, кого и где касается, существенные даты, числа, суммы, имена и официальную реакцию.`
      : mode === "maximum"
        ? `Сократи текст примерно на ${range.label}; целевой ориентир — около ${targetPercent}%. Итог должен занимать 40–60% длины исходника.`
        : `Сократи текст примерно на ${range.label}; целевой ориентир — около ${targetPercent}%. Итог должен занимать примерно 60–80% длины исходника.`;
  const retry = retryReason ? `\nПРЕДЫДУЩАЯ ПОПЫТКА НЕ ПРОШЛА ПРОВЕРКУ (${retryReason}). На этот раз строго соблюдай целевой объём.` : "";
  return `Ты редактор информационного обзора. Нужно аккуратно сократить исходную публикацию, не превращая её в пересказ. ${hardTarget}${retry}\n\nЖЁСТКИЕ ПРАВИЛА:\n1. Не добавляй ни одного факта, вывода, причины, оценки или связки, которых нет в исходнике.\n2. Сохраняй смысл проблемы, место, действующих лиц, даты, числа, суммы, масштабы и официальную реакцию.\n3. Удаляй прежде всего служебную редакционную упаковку, подписи к фото, призывы подписаться, сведения о каналах/ботах, повторы, исторический фон и второстепенные детали, если они не нужны для понимания проблемы.\n4. Допускается лёгкое грамматическое уплотнение длинной фразы, но без изменения фактов и тональности.\n5. Не используй маркеры пропуска […], [...], многоточие как обозначение вырезанного текста и служебные комментарии. После точки просто идёт следующее предложение.\n6. Не добавляй заголовок, источник, URL или пояснения. Нужен только готовый текст публикации для редактора.\n7. Прямые цитаты либо сохраняй дословно, либо удаляй целиком; не переписывай слова внутри цитаты.\n8. Язык исходника сохраняй.\n9. Объём — обязательное требование, а не рекомендация.\n\nВерни строго JSON по заданной схеме.`;
}
function buildPayload(text: string, mode: EffectiveMode, userContext: string, retryReason = "") {
  return { model: "openai/gpt-oss-120b", reasoning_effort: "low", reasoning_format: "hidden", temperature: 0.2,
    messages: [{ role: "system", content: instructions(mode, retryReason) }, { role: "user", content: `${userContext}${userContext ? "\n\n" : ""}ИСХОДНЫЙ ТЕКСТ:\n${text}` }],
    response_format: { type: "json_schema", json_schema: { name: "editorial_compression", strict: true, schema: { type: "object", properties: { compressed_text: { type: "string" } }, required: ["compressed_text"], additionalProperties: false } } } };
}
async function callGroq(apiKey: string, payload: unknown): Promise<GroqCallResult> {
  let response: Response;
  try { response = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }); }
  catch (error) { throw new Error(`groq_network_error:${String(error)}`); }
  const raw = await response.text();
  if (!response.ok) throw new Error(`groq_error:${response.status}:${raw.slice(0, 1200)}`);
  let decoded: any; try { decoded = JSON.parse(raw); } catch { throw new Error("groq_invalid_response"); }
  const content = decoded?.choices?.[0]?.message?.content;
  if (!content) throw new Error("groq_empty_response");
  let parsed: any; try { parsed = JSON.parse(content); } catch { throw new Error("groq_invalid_json"); }
  const usage = decoded?.usage || {};
  return { compressedText: String(parsed?.compressed_text || ""), usage: { prompt_tokens: Number(usage.prompt_tokens || 0), completion_tokens: Number(usage.completion_tokens || 0), total_tokens: Number(usage.total_tokens || 0) } };
}
function sumUsage(a: GroqCallResult["usage"], b?: GroqCallResult["usage"]) { return { prompt_tokens: a.prompt_tokens + (b?.prompt_tokens || 0), completion_tokens: a.completion_tokens + (b?.completion_tokens || 0), total_tokens: a.total_tokens + (b?.total_tokens || 0) }; }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const apiKey = Deno.env.get("GROQ_API_KEY") || "";
  if (!apiKey) return json({ error: "groq_not_configured" }, 503);
  let body: CompressionRequest; try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const text = String(body.text || "").trim();
  const requestedMode: CompressionMode = body.mode === "light" || body.mode === "standard" || body.mode === "maximum" || body.mode === "extract" ? body.mode : "auto";
  if (text.length < 120) return json({ error: "text_too_short" }, 400);
  if (text.length > 30000) return json({ error: "text_too_long", max_chars: 30000 }, 400);
  const mode = effectiveMode(requestedMode, text);
  const userContext = [body.source ? `Источник: ${body.source}` : "", body.title ? `Заголовок: ${body.title}` : ""].filter(Boolean).join("\n");
  let first: GroqCallResult; try { first = await callGroq(apiKey, buildPayload(text, mode, userContext)); } catch (error) { return json({ error: String(error).split(":")[0], detail: String(error) }, 502); }
  let validation = validateCompression(text, first.compressedText, mode);
  let retry: GroqCallResult | undefined;
  if (!validation.ok && ["under_compressed", "over_compressed"].includes(validation.reason)) {
    try { const reduction = Math.max(0, Math.round((1 - validation.ratio) * 1000) / 10); retry = await callGroq(apiKey, buildPayload(text, mode, userContext, `${validation.reason}; фактическое сокращение ${reduction}%`)); validation = validateCompression(text, retry.compressedText, mode); }
    catch (error) { return json({ error: String(error).split(":")[0], detail: String(error) }, 502); }
  }
  const usage = sumUsage(first.usage, retry?.usage);
  if (!validation.ok) {
    const fallback = exactFallback(text, mode);
    const fallbackValidation = validateCompression(text, fallback.text, mode);
    if (!fallbackValidation.ok) return json({ error: "compression_validation_failed", reason: validation.reason, ratio: validation.ratio ?? null, effective_mode: mode, retried: Boolean(retry) }, 422);
    return json({ compressed_text: fallbackValidation.result, reduction_pct: fallback.reductionPct, model: "openai/gpt-oss-120b", mode: requestedMode, effective_mode: mode, retried: Boolean(retry), fallback: "exact", ai_rejected_reason: validation.reason, contract_version: "0.6.5", usage });
  }
  return json({ compressed_text: validation.result, reduction_pct: Math.max(0, Math.round((1 - validation.ratio) * 1000) / 10), model: "openai/gpt-oss-120b", mode: requestedMode, effective_mode: mode, retried: Boolean(retry), fallback: null, contract_version: "0.6.5", usage });
});
