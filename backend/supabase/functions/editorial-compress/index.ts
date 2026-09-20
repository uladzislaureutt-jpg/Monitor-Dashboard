const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CompressionMode = "auto" | "light" | "standard";

type CompressionRequest = {
  text?: string;
  mode?: CompressionMode;
  title?: string;
  source?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function sentenceCount(value: string) {
  return (value.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? [])
    .map((part) => normalizeSpaces(part))
    .filter((part) => part.length >= 8).length;
}

function numericTokens(value: string) {
  return new Set((value.match(/\b\d[\d\s.,:%–—\-/]*\d\b|\b\d+\b/g) ?? []).map(normalizeSpaces));
}

function quotedSpans(value: string) {
  const result: string[] = [];
  for (const match of value.matchAll(/[«“\"]([^»”\"]{8,})[»”\"]/g)) {
    result.push(normalizeSpaces(match[1] || ""));
  }
  return result;
}

function suspiciousNames(value: string) {
  const result = new Set<string>();
  const re = /\b([А-ЯЁІЎA-Z][а-яёіўa-z'’\-]{2,}\s+[А-ЯЁІЎA-Z][а-яёіўa-z'’\-]{2,}(?:\s+[А-ЯЁІЎA-Z][а-яёіўa-z'’\-]{2,})?)\b/g;
  for (const match of value.matchAll(re)) result.add(normalizeSpaces(match[1] || ""));
  return result;
}


function validateCompression(original: string, compressed: string, mode: CompressionMode) {
  const source = normalizeSpaces(original);
  const result = normalizeSpaces(compressed)
    .replace(/\[\s*(?:…|\.{3})\s*\]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!result) return { ok: false, reason: "empty_result", result };
  const ratio = result.length / Math.max(1, source.length);
  const sentences = sentenceCount(source);
  const effective = mode === "auto" ? (sentences <= 6 || source.length < 900 ? "light" : "standard") : mode;
  const minRatio = effective === "light" ? 0.80 : 0.50;
  if (ratio < minRatio || ratio > 1.04) return { ok: false, reason: "length_out_of_range", result, ratio };

  const sourceNumbers = numericTokens(source);
  for (const token of numericTokens(result)) {
    if (!sourceNumbers.has(token)) return { ok: false, reason: `new_number:${token}`, result, ratio };
  }

  const sourceFolded = source.toLocaleLowerCase("ru-RU");
  for (const quote of quotedSpans(result)) {
    if (!sourceFolded.includes(quote.toLocaleLowerCase("ru-RU"))) {
      return { ok: false, reason: "changed_quote", result, ratio };
    }
  }
  for (const name of suspiciousNames(result)) {
    if (!sourceFolded.includes(name.toLocaleLowerCase("ru-RU"))) {
      return { ok: false, reason: `new_name:${name}`, result, ratio };
    }
  }
  return { ok: true, reason: "ok", result, ratio };
}

function instructions(mode: CompressionMode, text: string) {
  const sentences = sentenceCount(text);
  const effective = mode === "auto" ? (sentences <= 6 || text.length < 900 ? "light" : "standard") : mode;
  const target = effective === "light" ? "Сократи не более чем на 5–10%; если сокращение ухудшает текст, оставь почти без изменений." : "Сократи примерно на 20–40%.";
  return `Ты редактор информационного обзора. Нужно аккуратно сократить исходную публикацию, не превращая её в пересказ. ${target}\n\nЖЁСТКИЕ ПРАВИЛА:\n1. Не добавляй ни одного факта, вывода, причины, оценки или связки, которых нет в исходнике.\n2. Сохраняй смысл проблемы, место, действующих лиц, даты, числа, суммы, масштабы, прямые цитаты и официальную реакцию.\n3. Удаляй прежде всего вводные фразы, повторы, второстепенные детали и редакционную упаковку.\n4. Допускается лёгкое грамматическое сокращение длинной фразы, но без изменения фактов и тональности.\n5. Не используй маркеры пропуска […], [...], многоточие как обозначение вырезанного текста и служебные комментарии. После точки просто идёт следующее предложение.\n6. Не добавляй заголовок, источник, URL или пояснения. Нужен только готовый текст публикации для редактора.\n7. Если материал короткий, не сокращай его искусственно.\n8. Прямые цитаты либо сохраняй дословно, либо удаляй целиком; не переписывай слова внутри цитаты.\n9. Язык исходника сохраняй.\n\nВерни строго JSON по заданной схеме.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("GROQ_API_KEY") || "";
  if (!apiKey) return json({ error: "groq_not_configured" }, 503);

  let body: CompressionRequest;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const text = String(body.text || "").trim();
  const mode: CompressionMode = body.mode === "light" || body.mode === "standard" ? body.mode : "auto";
  if (text.length < 120) return json({ error: "text_too_short" }, 400);
  if (text.length > 30000) return json({ error: "text_too_long", max_chars: 30000 }, 400);

  const userContext = [body.source ? `Источник: ${body.source}` : "", body.title ? `Заголовок: ${body.title}` : ""].filter(Boolean).join("\n");
  const payload = {
    model: "openai/gpt-oss-120b",
    reasoning_effort: "low",
    reasoning_format: "hidden",
    messages: [
      { role: "system", content: instructions(mode, text) },
      { role: "user", content: `${userContext}${userContext ? "\n\n" : ""}ИСХОДНЫЙ ТЕКСТ:\n${text}` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "editorial_compression",
        strict: true,
        schema: {
          type: "object",
          properties: { compressed_text: { type: "string" } },
          required: ["compressed_text"],
          additionalProperties: false,
        },
      },
    },
  };

  let response: Response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return json({ error: "groq_network_error", detail: String(error) }, 502);
  }
  const raw = await response.text();
  if (!response.ok) return json({ error: "groq_error", status: response.status, detail: raw.slice(0, 1200) }, 502);

  let decoded: any;
  try { decoded = JSON.parse(raw); } catch { return json({ error: "groq_invalid_response" }, 502); }
  const content = decoded?.choices?.[0]?.message?.content;
  if (!content) return json({ error: "groq_empty_response" }, 502);
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { return json({ error: "groq_invalid_json" }, 502); }

  const validation = validateCompression(text, String(parsed?.compressed_text || ""), mode);
  if (!validation.ok) {
    return json({ error: "compression_validation_failed", reason: validation.reason, ratio: validation.ratio ?? null }, 422);
  }

  const usage = decoded?.usage || {};
  return json({
    compressed_text: validation.result,
    reduction_pct: Math.max(0, Math.round((1 - validation.ratio) * 1000) / 10),
    model: "openai/gpt-oss-120b",
    mode,
    usage: {
      prompt_tokens: Number(usage.prompt_tokens || 0),
      completion_tokens: Number(usage.completion_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0),
    },
  });
});
