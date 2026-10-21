import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {editorialQuoteInventory,editorialQuoteTarget,editorialQuoteBrief,editorialQuoteUsage}
  from "./editorial-quotes.ts";
const makeCard=(source,records)=>[
  'ИСТОЧНИК: «'+source+'»',
  'ЗАГОЛОВОК: Новая публикация',
  ...records
].join("\n");
const quote=(id,original,ru,speaker)=>id+
  " [quote/P001] Издание приводит исходную цитату. | SOURCE: «"+original+
  "» | ORIGINAL: «"+original+"» | RU: «"+ru+"» | SPEAKER: "+speaker;
const english="The policy contains a serious risk to the economy";
const ru="Такая политика создаёт серьёзный риск для экономики";
const english2="We expect the impact to be concentrated in several countries";
const ru2="Мы ожидаем, что последствия затронут прежде всего несколько стран";
test("only verified kind=quote records become candidates, not source citations or invented speech",()=>{
  const cards=[makeCard("The Times",[
    "E01 [fact/P001] Ситуация осложнилась. | SOURCE: «The report says the outlook is challenging»",
    quote("E02",english,ru,"Анна Иванова (независимый эксперт)"),
    "E03 [editorial_stance/P002] Редакция критикует ситуацию. | SOURCE: «The Times calls for reform»",
    "E04 [headline/TITLE] Новая политика названа рискованной. | SOURCE: «The policy carries a risk»"
  ])];
  const candidates=editorialQuoteInventory(cards);
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].id,"P01:E02");
  assert.equal(candidates[0].speaker,"Анна Иванова");
  assert.equal(candidates[0].role,"независимый эксперт");
  assert.equal(candidates[0].source,"The Times");
  assert.equal(candidates[0].quoteRu,ru);
});
test("distinct sources take priority; canonical CFR is preserved; identical quotes deduplicate",()=>{
  const cards=[
    makeCard("cfr.org/",[quote("E01",english,ru,"Автор (аналитик)")]),
    makeCard("Fortune",[
      quote("E01",english,ru,"Другой автор (аналитик)"),
      quote("E02",english2,ru2,"Политик (политик)")
    ])
  ];
  const candidates=editorialQuoteInventory(cards);
  assert.deepEqual(candidates.map(x=>x.id),["P01:E01","P02:E02"]);
  assert.equal(candidates[0].source,"CFR.org");
  const brief=editorialQuoteBrief(candidates,2);
  assert.match(brief,/P01:E01/);
  assert.match(brief,/P02:E02/);
  assert.match(brief,/не приписывай слова редакции без оснований/);
});
test("default quotation objectives are bounded by available evidence and user choice",()=>{
  assert.equal(editorialQuoteTarget(15,6000,"moderate"),4);
  assert.equal(editorialQuoteTarget(15,8000,"moderate"),6);
  assert.equal(editorialQuoteTarget(15,6000,"many"),5);
  assert.equal(editorialQuoteTarget(2,8000,"many"),2);
  assert.equal(editorialQuoteTarget(15,8000,"minimum"),1);
  assert.equal(editorialQuoteTarget(15,8000,"all"),12);
  assert.equal(editorialQuoteTarget(0,8000,"moderate"),0);
});
test("only exact quoted verified Russian strings count as used",()=>{
  const cards=[makeCard("Fortune",[quote("E01",english,ru,"Эксперт (аналитик)")])];
  const available=editorialQuoteInventory(cards);
  assert.equal(editorialQuoteUsage("Рассматривался риск, но никто не цитировался («Fortune»).",available).used,0);
  assert.equal(editorialQuoteUsage("Эксперт пояснила: «"+ru+"» («Fortune»).",available).used,1);
  assert.equal(editorialQuoteUsage("Эксперт пояснила: "+ru+" («Fortune»).",available).used,0);
});
test("a zero-quote evidence pool does not lead to invented quotations",()=>{
  const bank=editorialQuoteInventory([makeCard("CNN",[
    "E01 [fact/P002] Эксперты обсудили экономику. | SOURCE: «Experts discussed the economy»"
  ])]);
  assert.equal(bank.length,0);
  assert.match(editorialQuoteBrief(bank,0),/Запрещено создавать псевдоцитаты/);
});
test("synthesis integrates inventory in same single pass, logs usage and warns without rewriting",()=>{
  const synth=readFileSync(new URL("./index.ts",import.meta.url),"utf8")
    .split('if (action === "synthesize")')[1];
  assert.ok(synth.includes("const quoteCandidates=editorialQuoteInventory(cards)"));
  assert.ok(synth.includes("quoteTarget=editorialQuoteTarget("));
  assert.ok(synth.includes("${quoteBrief}"));
  assert.ok(synth.includes("quoteOutcome=editorialQuoteUsage(reviewText,quoteCandidates)"));
  assert.ok(synth.includes("directly_quoted_entries_used:quoteOutcome.used"));
  assert.ok(synth.includes("preflightWarnings.push"));
  assert.ok(synth.includes("SINGLE-PASS"));
  assert.ok(!synth.includes("await wEvidenceBatch("));
});
test("future Evidence prompts seek editorials and named experts but never mandate false quotes",()=>{
  const extract=readFileSync(new URL("./evidence-v2.ts",import.meta.url),"utf8");
  assert.ok(extract.includes("ЦИТАТЫ И АВТОРСКАЯ МАНЕРА"));
  assert.ok(extract.includes("ноль quote допустимо"));
  assert.ok(extract.includes("ОДНОГО anchor_id"));
});
