import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {EDITORIAL_SYNTHESIS_CONTRACT_V2 as contract} from "./editorial-synthesis-contract.ts";
import {editorialQuoteBrief,editorialQuoteInventory} from "./editorial-quotes.ts";
import {editorialHeadlineBrief,publicationHeadlineInventory} from "./editorial-headlines.ts";
import {makeSynthesisDossier,normalizeDossier} from "./editorial-dossier.ts";
const index=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const synth=index.slice(index.indexOf('if (action === "synthesize")'));
test("v2 is a single compact contract replacing stacked and contradictory style priorities",()=>{
 assert.ok(contract.length<6000,"do not grow an accumulating style prompt");
 for(const word of ["ЗАЧИН-ЦИТАТА","КОНТРПОЗИЦИЯ СРАЗУ ПОСЛЕ ЗАЧИНА",
   "АБЗАЦНЫЙ РИТМ","ЭКСПЕРТЫ И ПОЛИТИКИ","СОДЕРЖАТЕЛЬНАЯ ПОЛНОТА",
   "ДОКАЗАТЕЛЬНОСТЬ","STYLE_ONLY","ВНУТРЕННЯЯ СВЕРКА"])
   assert.ok(contract.includes(word),word);
 assert.ok(synth.includes("\${EDITORIAL_SYNTHESIS_CONTRACT_V2}"));
 assert.ok(!synth.includes("СТИЛЕВОЙ ПРИОРИТЕТ W-REVIEW"));
 assert.ok(!synth.includes("ЗАПРЕТ ПУСТОЙ РИТОРИКИ"));
});
test("selection is source-first, without forced exact counts or fabricated quotes",()=>{
 const titleCards=[
   "ID: P01\nИСТОЧНИК: «The Times»\nЗАГОЛОВОК: Risks of sovereign debt\nTITLE_RU: Риски государственного долга\nE01 [fact/P001] Прогноз долговой нагрузки. | SOURCE: «Original»",
   "ID: P02\nИСТОЧНИК: «The Guardian»\nЗАГОЛОВОК: New warning on stability\nTITLE_RU: Новое предупреждение об устойчивости\nE01 [fact/P001] Риск финансовых потрясений. | SOURCE: «Original»"
 ];
 const titles=publicationHeadlineInventory(titleCards);
 const brief=editorialHeadlineBrief(titles,9);
 assert.ok(brief.includes("Риски государственного долга"));
 assert.ok(brief.includes("контрпозицию"));
 assert.ok(!brief.includes("Ориентир — до 9"));
 const bank=editorialQuoteInventory(titleCards);
 assert.equal(bank.length,0);
 assert.ok(editorialQuoteBrief(bank,0).includes("Запрещено создавать псевдоцитаты"));
 assert.ok(contract.includes("при отсутствии реального спора не выдумывай"));
});
test("planning target remains +17% (within 5-20%) for every operator preset",()=>{
 assert.ok(synth.includes('Math.round(targetChars * 1.17)'));
 assert.deepEqual([1000,2000,3000,4000,6000,8000].map(x=>Math.round(x*1.17)),
   [1170,2340,3510,4680,7020,9360]);
 assert.ok(synth.includes('const lengthMinimum=Math.round(targetChars*0.95)'));
 assert.ok(synth.includes('const lengthMaximum=Math.round(targetChars*1.05)'));
 assert.ok(synth.includes('const synthesisRoute="gemini_first"'));
 assert.ok(synth.includes('const routes:SynthRoute[]=["gemini_3_5","cloudflare_primary","cloudflare_backup"]'));
});
test("block schema and all verified material are preserved; no extra model calls",()=>{
 assert.ok(synth.includes("synthesisResponseSchema(synthesisDossier.blocks)"));
 assert.ok(synth.includes("readSynthesisBlocks(raw,synthesisDossier.blocks)"));
 assert.ok(synth.includes("w_review_single_pass"));
 assert.ok(synth.includes("finishQuota(true)"));
 assert.ok(synth.includes("editorial_contract:\"media_review_v2\""));
 assert.ok(synth.includes("opening_starts_with_quote:openingStartsWithQuote"));
 assert.ok(synth.includes("opening_matches_source_title:openingVerifiedHeadlines>0"));
 assert.ok(synth.includes("editorialHeadlineUsage(\n      openingParagraph,publicationHeadlines)"));
 assert.ok(contract.includes("выразительность должна усиливать"));
 assert.ok(!contract.includes("W-Review-5"));
 assert.ok(!contract.includes("W-Review-6"));
 assert.ok(synth.includes("quoteOutcome=editorialQuoteUsage(reviewText,quoteCandidates)"));
 assert.ok(!synth.includes("quoteOutcome.used<Math.min(quoteTarget"));
 const d=readFileSync(new URL("./editorial-dossier.ts",import.meta.url),"utf8");
 assert.ok(d.includes("открытие подлинным цитатным заголовком"));
 assert.ok(d.includes("не обязательное заключение"));
 assert.ok(d.includes("const opening=Math.round(targetChars*0.085)"));
});
