import test from "node:test";
import assert from "node:assert/strict";
import {
  makeEvidencePassages,makeEvidenceDocuments,verifyEvidenceCards,
  formatEvidenceCard,evidenceV2Schema,renderEvidenceMaterials,verifyEvidenceCardsIndividually
} from "./evidence-v2.ts";
const text1="После встречи стороны сообщили об условиях соглашения. По данным ведомства, расходы выросли на 18 процентов.\n\nЭксперт Павел Сидоров отметил, что сроки остаются неопределёнными.";
const text2="Вторая редакция критикует предложенный механизм финансирования. Министерство считает, что риски ограничены.";
const docs=makeEvidenceDocuments([
  {index:0,publication_id:"article-a",source:"Издание А",title:"Новый договор",text:text1},
  {index:1,publication_id:"article-b",source:"Издание Б",title:"Спор о расходах",text:text2}
]);
const rec=(kind,statement_ru,anchor_id,source_excerpt,original_quote="")=>({
  kind,statement_ru,anchor_id,source_excerpt,original_quote,quote_ru:"",
  speaker:"",role:""
});
test("passages retain all authored material, including late paragraphs",()=>{
  const chunks=makeEvidencePassages(("Одна новая информация. ".repeat(700))+"\n\nКонечная оговорка.");
  assert.ok(chunks.length>4);
  assert.ok(chunks[0].id==="P001");
  assert.ok(chunks.at(-1).text.includes("Конечная оговорка"));
  assert.equal(chunks.map(x=>x.text).join(" ").replace(/\s+/g," "),("Одна новая информация. ".repeat(700)+"\n\nКонечная оговорка.").replace(/\s+/g," ").trim());
});
test("indexed facts in different articles retain publication identity",()=>{
  const raw={cards:[
    {index:0,title_ru:"Новый договор",records:[
      rec("fact","Ведомство сообщило об увеличении расходов на 18 процентов.","P001","расходы выросли на 18 процентов"),
      rec("expert","Эксперт считает сроки неопределёнными.","P002","сроки остаются неопределёнными")
    ]},
    {index:1,title_ru:"Спор о расходах",records:[
      rec("counterposition","Редакция критикует механизм финансирования.","P001","критикует предложенный механизм финансирования")
    ]}
  ]};
  const checked=verifyEvidenceCards(raw,docs);
  assert.equal(checked.error,null);
  assert.equal(checked.cards.length,2);
  assert.equal(checked.cards[0].publication_id,"article-a");
  assert.equal(checked.cards[1].publication_id,"article-b");
  assert.match(formatEvidenceCard(checked.cards[0]),/E02 \[expert\/P002\]/);
  assert.match(renderEvidenceMaterials(docs),/\[P002\] Эксперт/);
});
test("fabricated quotations and facts from another article are rejected",()=>{
  const raw={cards:[
    {index:0,title_ru:"Новый договор",records:[
      rec("fact","Ведомство сообщило об увеличении расходов.","P001","расходы выросли на 18 процентов"),
      rec("quote","Руководитель якобы заявил о полном согласии.","P001","стороны сообщили об условиях соглашения","Мы всегда побеждаем"),
      rec("fact","Взятая из другого источника критика.","P001","предложенный механизм финансирования")
    ]},
    {index:1,title_ru:"Спор о расходах",records:[
      rec("fact","Министерство считает риски ограниченными.","P001","Министерство считает, что риски ограничены")
    ]}
  ]};
  const checked=verifyEvidenceCards(raw,docs);
  assert.equal(checked.error,null);
  assert.equal(checked.cards[0].validation.rejected,2);
  assert.equal(checked.cards[0].validation.accepted,1);
  assert.equal(checked.cards[1].validation.accepted,1);
});
test("the first passage alone cannot validate a long article",()=>{
  const longText=Array.from({length:8},(_,i)=>"Фрагмент "+i+". "+("Вопрос расширен конкретными параметрами и оценками. ".repeat(18))).join("\n\n");
  const longDoc=makeEvidenceDocuments([{index:0,publication_id:"long",source:"A",title:"Long",text:longText}]);
  const excerpt=longDoc[0].passages[0].text.slice(0,55);
  const raw={cards:[{index:0,title_ru:"Long",records:Array.from({length:6},(_,i)=>
    rec("fact","Развёрнутая заметка об информации под номером "+i,"P001",excerpt))}]};
  const checked=verifyEvidenceCards(raw,longDoc);
  assert.match(checked.error||"",/insufficient_verified_coverage/);
});
test("schema requires structured individual records instead of opaque text",()=>{
  const schema=evidenceV2Schema(2);
  const fields=schema.properties.cards.items.properties;
  assert.ok(fields.records);
  assert.equal(fields.records.items.properties.source_excerpt.type,"STRING");
  assert.equal(schema.properties.cards.minItems,2);
});

test("accepted first article survives when second lacks sufficient evidence",()=>{
  const raw={cards:[
    {index:0,title_ru:"Новый договор",records:[
      rec("fact","Расходы выросли по сведениям ведомства.","P001","расходы выросли на 18 процентов"),
      rec("expert","Эксперт отметил неопределенность сроков.","P002","сроки остаются неопределёнными")
    ]},
    {index:1,title_ru:"Спор о расходах",records:[
      rec("fact","Неподтвержденное сообщение отсутствует в тексте.","P001","фантазия о расходах")
    ]}
  ]};
  assert.match(verifyEvidenceCards(raw,docs).error||"",/material_2/);
  const partial=verifyEvidenceCardsIndividually(raw,docs);
  assert.deepEqual(partial.accepted.map(x=>x.index),[0]);
  assert.deepEqual(partial.failed.map(x=>x.index),[1]);
  assert.equal(partial.accepted[0].card.publication_id,"article-a");
  assert.ok(partial.failed[0].reason.includes("_records_0_of_1"));
});
test("accepted second article retains batch index 1 even if article 0 fails",()=>{
  const raw={cards:[
    {index:0,title_ru:"Новый договор",records:[]},
    {index:1,title_ru:"Спор о расходах",records:[
      rec("fact","Министерство считает риски ограниченными.","P001","Министерство считает, что риски ограничены")
    ]}
  ]};
  const partial=verifyEvidenceCardsIndividually(raw,docs);
  assert.deepEqual(partial.accepted.map(x=>x.index),[1]);
  assert.deepEqual(partial.failed.map(x=>x.index),[0]);
  assert.equal(partial.accepted[0].card.publication_id,"article-b");
});
test("fabricated evidence in both articles cannot be salvaged",()=>{
  const raw={cards:[
    {index:0,title_ru:"Новый договор",records:[
      rec("fact","Полностью ложная деталь публикации.","P001","не существующий фрагмент")
    ]},
    {index:1,title_ru:"Спор о расходах",records:[
      rec("fact","Другая неподтвержденная деталь.","P001","невозможная дословная выдержка")
    ]}
  ]};
  const partial=verifyEvidenceCardsIndividually(raw,docs);
  assert.equal(partial.accepted.length,0);
  assert.equal(partial.failed.length,2);
});

test("catalog region travels only as context, without changing source passages or evidence schema",()=>{
  const docs=makeEvidenceDocuments([
    {publication_id:"known-1",index:0,source:"Reuters",region:"Великобритания",title:"Заявление политика",text:"Редакция цитирует слова зарубежного эксперта."},
    {publication_id:"unknown-1",index:1,source:"Неизвестный журнал",title:"Реплика",text:"Исследователь пояснил проблему."}
  ]);
  assert.equal(docs[0].region,"Великобритания");
  assert.equal(docs[1].region,"");
  const input=renderEvidenceMaterials(docs);
  assert.match(input,/ИЗДАНИЕ: Reuters\nКАТАЛОЖНЫЙ_РЕГИОН: Великобритания/);
  assert.match(input,/КАТАЛОЖНЫЙ_РЕГИОН: не указан/);
  assert.equal(docs[0].passages[0].text,"Редакция цитирует слова зарубежного эксперта.");
  assert.ok(!("region" in evidenceV2Schema(2).properties.cards.items.properties));
});

test("21 Oct regression: 28 short paragraphs do not demand five distinct facts",()=>{
  const text=Array.from({length:28},(_,i)=>"Сведения о событии "+i+": участник высказал конкретную позицию.").join("\n\n");
  const d=makeEvidenceDocuments([{index:0,publication_id:"short",source:"СМИ",title:"Краткий материал",text}]);
  assert.equal(d[0].passages.length,28);
  assert.ok(text.length>1000&&text.length<3500);
  const records=[0,5,10,20].map(i=>rec("fact","Зафиксирована позиция участника номер "+i,
    d[0].passages[i].id,d[0].passages[i].text.slice(0,42)));
  const verified=verifyEvidenceCards({cards:[{index:0,title_ru:"Краткий материал",records}]},d);
  assert.equal(verified.error,null);
  assert.equal(verified.cards[0].validation.accepted,4);
});
test("21 Oct regression: four source-anchored records remain insufficient for 8k article",()=>{
  const text=Array.from({length:30},(_,i)=>"Абзац "+i+": "+("Редакция приводит проверяемые оценки и существенные подробности события. ".repeat(4))).join("\n\n");
  const d=makeEvidenceDocuments([{index:0,publication_id:"long",source:"СМИ",title:"Большая статья",text}]);
  assert.ok(d[0].passages.length>=20);
  assert.ok(text.length>3500);
  const build=n=>({cards:[{index:0,title_ru:"Большая статья",records:
    Array.from({length:n},(_,i)=>rec("fact","Статья содержит наблюдение под номером "+i,
      d[0].passages[i].id,d[0].passages[i].text.slice(0,46)))}]});
  const rejected=verifyEvidenceCards(build(4),d);
  assert.match(rejected.error||"",/records_4_of_5_passages_4_of_2/);
  const accepted=verifyEvidenceCards(build(8),d);
  assert.equal(accepted.error,null);
  assert.equal(accepted.cards[0].validation.accepted,8);
});
