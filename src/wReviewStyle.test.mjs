import test from "node:test";
import assert from "node:assert/strict";
import {selectStyleExcerpts,buildStylePattern} from "./wReviewStyle.ts";

const doc=(name,index)=>({
  name,text:[
    "НАЧАЛО "+index+". Заметным обстоятельством становится изменение информационного фона, на который указывает автор при постановке основного вопроса.",
    "Автор развивает этот вопрос, приводя сравнительные аргументы нескольких изданий и отмечая особенности их освещения в разных контекстах.",
    "Между тем «Reuters» фокусируется на цифрах, однако «Financial Times» рассматривает прежде всего долгосрочные риски и последствия.",
    "При этом существенным остаётся различие между политическим заявлением и прямым независимым подтверждением приводимых сведений.",
    "Окончание текста не повторяет его начало: оно показывает, какой из доказательных аргументов способен изменить общую оценку развития ситуации."
  ].join("\n\n")
});
test("uses more than three author samples, covering all five",()=>{
  const samples=Array.from({length:5},(_,i)=>doc("Образец "+(i+1),i));
  const excerpts=selectStyleExcerpts(samples);
  assert.equal(new Set(excerpts.map(e=>e.name)).size,5);
  assert.ok(excerpts.length>=5&&excerpts.length<=12);
  assert.ok(excerpts.reduce((n,e)=>n+e.text.length,0)<=7200);
  assert.ok(excerpts.every(e=>e.text.length<=1250));
});
test("includes opening, comparison, and ending roles",()=>{
  const excerpts=selectStyleExcerpts(Array.from({length:3},(_,i)=>doc("S"+i,i)));
  const roles=new Set(excerpts.map(e=>e.role));
  assert.ok(roles.has("opening"));
  assert.ok(roles.has("comparison"));
  assert.ok(roles.has("ending"));
});
test("never truncates an author's paragraph in the middle of a phrase",()=>{
  const samples=[doc("Первый",1)];
  const validParagraphs=samples[0].text.split("\n\n");
  const excerpts=selectStyleExcerpts(samples);
  for(const item of excerpts)for(const paragraph of item.text.split("\n\n"))
    assert.ok(validParagraphs.includes(paragraph),paragraph);
});
test("the ending is taken from the end, not from the first three paragraphs",()=>{
  const sample=doc("Оригинал",2);
  const excerpts=selectStyleExcerpts([sample]);
  const ending=excerpts.find(e=>e.role==="ending");
  assert.ok(ending);
  assert.match(ending.text,/Окончание текста не повторяет его начало/);
});
test("paragraph metrics use the complete texts and do not summarize their facts",()=>{
  const samples=[doc("Первый",1),doc("Второй",2)];
  const result=buildStylePattern(samples);
  assert.equal(result.sampleCount,2);
  assert.equal(result.paragraphCount,10);
  assert.ok(result.medianParagraphChars>80);
  assert.ok(result.comparisonParagraphPct>0);
  assert.ok(result.attributionParagraphPct>0);
  assert.ok(result.excerpts.length>0);
});
test("extremely long paragraphs are skipped, not cut",()=>{
  const full="А".repeat(1400);
  const sample={name:"Long",text:[full,full+" Б",doc("Short",1).text].join("\n\n")};
  const excerpts=selectStyleExcerpts([sample]);
  assert.ok(excerpts.every(e=>!e.text.includes("А".repeat(100))));
  assert.ok(excerpts.every(e=>e.text.length<=1250));
});
