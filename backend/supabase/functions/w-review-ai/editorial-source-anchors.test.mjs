import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {makeEditorialSourceAnchors} from "./editorial-source-anchors.ts";
import {editorialQuoteInventory,editorialQuoteUsage} from "./editorial-quotes.ts";
const line=(id,title,refs)=>({id,title,claim:"Тезис",mechanism:"",
 counterpoint:"",limitation:"",significance:"",priority:"high",required:true,
 evidence_ids:refs,contrary_evidence_ids:[]});
const fakeDossier={
 version:3,coverage:[],inventory:{quotes:6,headlines:6,experts:4},
 trends:[
  {id:"T1",title:"Власть и оппозиция",summary:"",thesis:"",sources:["BBC","AP"],
   operator_optional:false,optional_reason:"",
   branches:[line("T1:B1","Правление и выборы",["P01:E03","P02:E02"])]},
  {id:"T2",title:"Коалиции",summary:"",thesis:"",sources:["Danas","Guardian"],
   operator_optional:false,optional_reason:"",
   branches:[line("T2:B1","Формирование правительства",["P03:E01","P04:E02"])]},
  {id:"T3",title:"Уличные протесты",summary:"",thesis:"",sources:["DW","Handelsblatt"],
   operator_optional:false,optional_reason:"",
   branches:[line("T3:B1","Общественные требования",["P05:E04","P06:E02"])]}
 ]
};
const mk=(i,source,ru)=>({
 id:"P"+String(i).padStart(2,"0")+":E01",source,quoteRu:ru,
 original:"The original published quotation about the source",
 speaker:"Эксперт "+i,role:"политолог"
});
const candidates=[
 mk(1,"BBC","Первый собеседник объясняет причины серьёзного политического конфликта в стране"),
 mk(2,"AP","Второй эксперт подчёркивает ограничения нынешней избирательной кампании"),
 mk(3,"Danas","Третий автор показывает слабости коалиционного формирования правительства"),
 mk(4,"Guardian","Четвёртый политолог рассматривает участие меньшинств в коалициях"),
 mk(5,"DW","Пятый комментатор оценивает перспективы протестного движения"),
 mk(6,"Handelsblatt","Шестой эксперт объясняет риски оспаривания результатов голосования")
];
test("six existing verified quotes are made visible under three POST-LEDE lines",()=>{
 const result=makeEditorialSourceAnchors(fakeDossier,["T1","T2","T3"],candidates);
 assert.equal(result.anchoredQuotes,6);
 assert.equal(result.unanchoredQuotes,0);
 assert.match(result.brief,/ПОСЛЕ УДАЧНОГО ЗАЧИНА/);
 assert.match(result.brief,/БЛОК line_1/);
 assert.match(result.brief,/БЛОК line_2/);
 assert.match(result.brief,/БЛОК line_3/);
 for(const q of candidates)assert.ok(result.brief.includes(q.quoteRu));
 assert.ok(result.brief.indexOf("P01:E01")<result.brief.indexOf("БЛОК line_2"));
 assert.ok(result.brief.indexOf("P05:E01")>result.brief.indexOf("БЛОК line_3"));
 assert.match(result.brief,/не гарантия, что слова относятся к конкретной ветке/);
 assert.match(result.brief,/без объявления одного опровержением другого/);
});
test("unselected publication quotes are not falsely assigned to a line",()=>{
 const result=makeEditorialSourceAnchors(fakeDossier,["T1"],candidates);
 assert.equal(result.anchoredQuotes,2);
 assert.equal(result.unanchoredQuotes,4);
 assert.doesNotMatch(result.brief,/P05:E01/);
});
test("a dossier with zero contrary refs must NOT fabricate opposing speech",()=>{
 const result=makeEditorialSourceAnchors(fakeDossier,["T1","T2","T3"],[]);
 assert.equal(result.anchoredQuotes,0);
 assert.match(result.brief,/Нет отдельной подтверждённой прямой цитаты/);
 assert.doesNotMatch(result.brief,/дословный RU: «/);
});
test("exact shortened source quotes count, paraphrases and media names do not",()=>{
 const q=[candidates[0]];
 const shortened="собеседник объясняет причины серьёзного политического конфликта";
 const actual="«"+shortened+"», – пояснил политолог («BBC»).";
 assert.equal(editorialQuoteUsage(actual,q).used,1);
 assert.equal(editorialQuoteUsage("Политолог отметил серьёзность кризиса («BBC»).",q).used,0);
 assert.equal(editorialQuoteUsage("«BBC» сообщает об участниках кампании.",q).used,0);
});
test("production uses line anchors AFTER evidence, logs body uptake, and does not retry",()=>{
 const s=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
 const synth=s.slice(s.indexOf('if (action === "synthesize")'));
 assert.ok(synth.includes("makeEditorialSourceAnchors("));
 assert.ok(synth.includes("ОПОРА ДЛЯ ОСНОВНОЙ ЧАСТИ ОБЗОРА"));
 assert.ok(synth.indexOf("EVIDENCE CARDS:\\n\${evidenceText}")<
   synth.indexOf("ОПОРА ДЛЯ ОСНОВНОЙ ЧАСТИ ОБЗОРА"));
 assert.ok(synth.includes("source_anchored_quote_candidates:editorialAnchors.anchoredQuotes"));
 assert.ok(synth.includes("quoteCandidates.length>=2 && quoteOutcome.used===0"));
 assert.ok(synth.includes("const planningTargetChars = Math.round(targetChars * 1.17)"));
 assert.ok(synth.includes('const synthesisRoute="gemini_first"'));
 assert.ok(synth.includes("SINGLE-PASS"));
});
