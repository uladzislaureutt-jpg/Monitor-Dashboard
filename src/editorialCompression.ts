export type CompressionMode = "auto" | "light" | "standard";

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function splitEditorialSentences(value: string) {
  const text = normalize(value);
  if (!text) return [];
  return (text.match(/[^.!?…]+(?:[.!?…]+(?:[»”\"])?|$)/g) ?? [text])
    .map((part) => normalize(part))
    .filter((part) => part.length >= 8);
}

export function effectiveCompressionMode(text: string, mode: CompressionMode): Exclude<CompressionMode, "auto"> {
  if (mode !== "auto") return mode;
  const sentences = splitEditorialSentences(text);
  return sentences.length <= 6 || normalize(text).length < 900 ? "light" : "standard";
}

function sentenceScore(sentence: string, index: number, total: number) {
  const value = sentence.toLocaleLowerCase("ru-RU");
  let score = 0;
  if (index === 0) score += 5;
  if (index === total - 1) score += 1;
  if (/\d/.test(sentence)) score += 3;
  if (/[«“\"][^»”\"]{8,}[»”\"]/.test(sentence)) score += 3;
  if (/(жалоб|жалу|проблем|возму|не хватает|нет |отсутств|опасн|аварийн|разруш|очеред|цена|зарплат|дорог|мусор|вод|свет|транспорт|поликлиник|школ|жкх)/i.test(value)) score += 3;
  if (/(ответ|сообщил|заявил|прокоммент|власти|исполком|министер|ведомств|прокуратур|служб|обещал|пообещал|реакц)/i.test(value)) score += 3;
  if (/(жител|горожан|читател|родител|водител|работник|пациент|пассажир)/i.test(value)) score += 1.5;
  if (sentence.length >= 70 && sentence.length <= 360) score += 1;
  if (/(напомним|ранее мы писали|читайте также|подробнее|фото:|источник:|подписывайтесь|наш канал|реклама)/i.test(value)) score -= 6;
  if (sentence.length < 35) score -= 1;
  return score;
}

export function exactCompress(text: string, mode: CompressionMode = "auto") {
  const source = normalize(text);
  const sentences = splitEditorialSentences(source);
  const effective = effectiveCompressionMode(source, mode);
  if (!source || sentences.length <= 3) return { text: source, reductionPct: 0, mode: effective };

  // Very short news items are intentionally kept almost intact.
  if (effective === "light" && sentences.length <= 6) {
    const boilerplate = sentences
      .map((sentence, index) => ({ sentence, index, score: sentenceScore(sentence, index, sentences.length) }))
      .filter((item) => item.score <= -3)
      .sort((a, b) => a.score - b.score)[0];
    if (!boilerplate) return { text: source, reductionPct: 0, mode: effective };
    const kept = sentences.filter((_, index) => index !== boilerplate.index).join(" ");
    const reductionPct = Math.max(0, Math.round((1 - kept.length / source.length) * 1000) / 10);
    return reductionPct <= 12 ? { text: kept, reductionPct, mode: effective } : { text: source, reductionPct: 0, mode: effective };
  }

  const targetRatio = effective === "light" ? 0.93 : 0.72;
  const minimumRatio = effective === "light" ? 0.86 : 0.60;
  const selected = new Set(sentences.map((_, index) => index));
  let selectedChars = sentences.reduce((sum, sentence) => sum + sentence.length + 1, 0);
  const removable = sentences
    .map((sentence, index) => ({ sentence, index, score: sentenceScore(sentence, index, sentences.length) }))
    .filter((item) => item.index !== 0)
    .sort((a, b) => a.score - b.score || b.index - a.index);

  for (const item of removable) {
    if (selectedChars <= source.length * targetRatio || selected.size <= 3) break;
    const nextChars = selectedChars - item.sentence.length - 1;
    if (nextChars < source.length * minimumRatio) continue;
    selected.delete(item.index);
    selectedChars = nextChars;
  }

  const result = sentences.filter((_, index) => selected.has(index)).join(" ");
  const reductionPct = Math.max(0, Math.round((1 - result.length / source.length) * 1000) / 10);
  return { text: result || source, reductionPct, mode: effective };
}

export function compressionReduction(source: string, result: string) {
  const a = normalize(source).length;
  const b = normalize(result).length;
  return a ? Math.max(0, Math.round((1 - b / a) * 1000) / 10) : 0;
}

export function compressionRange(mode: Exclude<CompressionMode, "auto">) {
  return mode === "light" ? { min: 3, max: 14 } : { min: 18, max: 42 };
}
