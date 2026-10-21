import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {publicationHeadlineInventory,editorialHeadlineTarget,
  editorialHeadlineBrief,editorialHeadlineUsage} from "./editorial-headlines.ts";

const fakeCard=(name,title,ru="",withHeadline=false)=>
  "ID: P99\nИСТОЧНИК: «"+name+"»\nКАТАЛОЖНЫЙ_РЕГИОН: США\nЗАГОЛОВОК: "+title+
  "\nURL: https://example.com/article\nTITLE_ORIGINAL: "+title+
  "\nTITLE_RU: "+(ru||title)+"\nEVIDENCE_VERSION: 2\n"+
  "PUBLICATION_ID: id\n"+
  (withHeadline?"E01 [headline/TITLE] Заголовок оценивает событие. | SOURCE: «"+title+"»\n":
    "E01 [fact/P001] Приведена оценка. | SOURCE: «Some other passage»\n");

test("All twelve real publication headlines survive even when only one is tagged headline",()=>{
  const articles=Array.from({length:12},(_,i)=>fakeCard("Media"+i,
    "Доказательно сформулированный заголовок публикации № "+(i+1),"",i===3));
  const titles=publicationHeadlineInventory(articles);
  assert.equal(titles.length,12);
  assert.equal(titles.filter(t=>t.verifiedHeadlineEvidence).length,1);
  assert.equal(titles[0].publicationId,"P01");
  assert.equal(titles[11].publicationId,"P12");
  assert.ok(editorialHeadlineBrief(titles,3).includes("все 12 названий"));
  assert.ok(editorialHeadlineBrief(titles,3).includes("P12 / «Media11»"));
});
test("Provide original and existing RU translation, without presenting translation as verified original",()=>{
  const titles=publicationHeadlineInventory([
    fakeCard("The Hill","Trump's proposal divides US allies","Предложение Трампа раскололо союзников США")
  ]);
  assert.equal(titles[0].original,"Trump's proposal divides US allies");
  assert.equal(titles[0].russian,"Предложение Трампа раскололо союзников США");
  assert.ok(titles[0].hasRussianTranslation);
  assert.match(editorialHeadlineBrief(titles,1),/предоставленный перевод, сверь с оригиналом/);
  assert.match(editorialHeadlineBrief(titles,1),/если перевод нельзя/);
});
test("Editorial headline targets are capped, not mandatory quotas",()=>{
  assert.equal(editorialHeadlineTarget(12,6000,"moderate"),2);
  assert.equal(editorialHeadlineTarget(12,8000,"moderate"),3);
  assert.equal(editorialHeadlineTarget(12,6000,"many"),4);
  assert.equal(editorialHeadlineTarget(12,6000,"minimum"),1);
  assert.equal(editorialHeadlineTarget(12,6000,"all"),8);
  assert.equal(editorialHeadlineTarget(0,8000,"all"),0);
});
test("Only exact explicit title quotations count, source-name brackets do not",()=>{
  const h=publicationHeadlineInventory([fakeCard("CNN","Украинская политика в тупике")]);
  assert.equal(editorialHeadlineUsage("Газета «CNN» описала тупик в политике.",h).quotedTitles,0);
  assert.equal(editorialHeadlineUsage("«Украинская политика в тупике» – так редакция озаглавила материал («CNN»).",h).quotedTitles,1);
});
test("Empty titles are not invented and skipped",()=>{
  const h=publicationHeadlineInventory(["ИСТОЧНИК: «CNN»\nTITLE_RU: Текст"]);
  assert.equal(h.length,0);
  assert.match(editorialHeadlineBrief(h,0),/не придумывай заголовки/);
});
test("Synthesis receives all publisher headlines in the original single-call contract",()=>{
  const src=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
  const synth=src.slice(src.indexOf('if (action === "synthesize")'));
  assert.ok(synth.includes("const publicationHeadlines=publicationHeadlineInventory(cards)"));
  assert.ok(synth.includes("headlineBrief=editorialHeadlineBrief"));
  assert.ok(synth.includes("ПОЛНЫЙ РЕЕСТР ЗАГОЛОВКОВ ДЛЯ РЕДАКЦИОННОГО СОПОСТАВЛЕНИЯ"));
  assert.ok(synth.includes("headlineOutcome=editorialHeadlineUsage"));
  assert.ok(synth.includes("headlines_available:headlineOutcome.titlesAvailable"));
  assert.ok(synth.includes('const synthesisRoute="gemini_first"'));
  assert.ok(synth.includes("// SINGLE-PASS"));
});
test("UI distinguishes twelve source titles from separately tagged headline records",()=>{
  const ui=readFileSync(new URL("../../../../src/views/WReviewView.tsx",import.meta.url),"utf8");
  assert.ok(ui.includes('state.items.filter(item=>item.title.trim().length>0).length'));
  assert.ok(ui.includes('"заголовков публикаций"'));
  assert.ok(ui.includes('"отдельно выделено в Evidence"'));
  assert.ok(ui.includes("state.editorialMap.inventory.headlines"));
});
