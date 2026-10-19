import test from "node:test";
import assert from "node:assert/strict";
import {parseEvidenceJson} from "./evidence-json-recovery.ts";
import {makeEvidenceDocuments,verifyEvidenceCardsIndividually} from "./evidence-v2.ts";

const articleText="В материале сказано: Компания увеличила выручку на двадцать процентов.";
const input=makeEvidenceDocuments([0,1].map(index=>({
 index,publication_id:"src-"+index,source:"Редакция",title:"Событие",
 text:articleText
})));
const card=index=>({
 index,title_ru:"Сообщение "+index,records:[{
   kind:"fact",statement_ru:"Компания увеличила выручку на двадцать процентов.",
   anchor_id:"P001",source_excerpt:"Компания увеличила выручку на двадцать процентов",
   original_quote:"",quote_ru:"",speaker:"",role:""
 }]
});
function checked(text){
 const result=parseEvidenceJson(text,2);
 return {result,verified:verifyEvidenceCardsIndividually(result.payload,input)};
}
test("preserves standard JSON, no rescue needed",()=>{
 const {result,verified}=checked(JSON.stringify({cards:[card(0),card(1)]}));
 assert.equal(result.method,"direct");
 assert.equal(result.recovered_cards,2);
 assert.deepEqual(verified.accepted.map(a=>a.index),[0,1]);
});
test("recovers BOTH top-level array cards, not just its first object",()=>{
 const {result,verified}=checked(JSON.stringify([card(0),card(1)]));
 assert.equal(result.method,"top_level_cards");
 assert.equal(result.recovered_cards,2);
 assert.deepEqual(verified.accepted.map(a=>a.index),[0,1]);
});
test("accepts one complete single-card object only in its matching slot",()=>{
 const {result,verified}=checked(JSON.stringify(card(1)));
 assert.equal(result.method,"single_card");
 assert.deepEqual(verified.accepted.map(a=>a.index),[1]);
 assert.deepEqual(verified.failed.map(a=>a.index),[0]);
});
test("unwraps complete nested responses from JSON-compatible output formats",()=>{
 for(const outer of [{result:[card(0),card(1)]},{data:{cards:[card(0),card(1)]}},{
   output:[card(0),card(1)]}]){
   const {result,verified}=checked(JSON.stringify(outer));
   assert.equal(result.method,"wrapped");
   assert.equal(verified.accepted.length,2);
 }
});
test("recovers only complete cards when outer envelope is cut off",()=>{
 const unfinished='{"cards":['+JSON.stringify(card(0))+','+JSON.stringify(card(1))+']';
 const {result,verified}=checked(unfinished);
 assert.equal(result.method,"complete_card_objects");
 assert.deepEqual(verified.accepted.map(a=>a.index),[0,1]);
});
test("long 18k response with broken final JSON rescues complete verified preceding card",()=>{
 const longText='Дополнительный поясняющий контекст { } и "кавычки". '.repeat(345);
 const first=card(0);first.records[0].statement_ru+=longText;
 const malformed='{"cards":['+JSON.stringify(first)+',{"index":1,"title_ru":"не завершено","records":[{"kind":"fact"';
 assert.ok(malformed.length>18000);
 const {result,verified}=checked(malformed);
 assert.equal(result.method,"complete_card_objects");
 assert.equal(result.recovered_cards,1);
 assert.deepEqual(verified.accepted.map(a=>a.index),[0]);
 assert.deepEqual(verified.failed.map(a=>a.index),[1]);
});
test("salvaged but unverifiable content is still rejected by source anchor validation",()=>{
 const fake=card(0);fake.records[0].source_excerpt="Этого в исходном тексте никогда не было";
 const {result,verified}=checked('{"cards":['+JSON.stringify(fake)+']');
 assert.equal(result.method,"complete_card_objects");
 assert.equal(verified.accepted.length,0);
 assert.equal(verified.failed.length,2);
});
test("never fabricate a truncated inner card or parse standalone record as a card",()=>{
 const partial='{"cards":[{"index":0,"title_ru":"не завершено","records":[{"kind":"fact",';
 const r=parseEvidenceJson(partial,2);
 assert.equal(r.recovered_cards,0);
 assert.equal(r.payload,null);
});
test("discards ambiguous duplicate indices when decoding concatenated replies",()=>{
 const first=card(0),second=card(0);
 const mixed=JSON.stringify(first)+"\n"+JSON.stringify(second)+"\n"+JSON.stringify(card(1));
 const r=parseEvidenceJson(mixed,2);
 // Even if the generic parser accepts first card, the safe scanner must
 // prevent treating two different P01 records as an authoritative choice.
 assert.equal(r.method,"complete_card_objects");
 assert.deepEqual(r.payload.cards.map(c=>c.index),[1]);
});
test("does not log or modify text; retains escaped quotes and exact original fragments",()=>{
 const inputText='Примечание: { не структура } и "внутренние кавычки"';
 const c=card(0);c.records[0].statement_ru=inputText;
 const r=parseEvidenceJson('{"cards":['+JSON.stringify(c)+']',2);
 assert.equal(r.payload.cards[0].records[0].statement_ru,inputText);
});
