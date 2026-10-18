import test from "node:test";
import assert from "node:assert/strict";
import {reconcileDossierDraft} from "./dossier-reconciliation.ts";
import {normalizeDossier,makeSynthesisDossier} from "./editorial-dossier.ts";
const cards=[
  ["Reuters","Договор о топливе","Вашингтон сообщил об обсуждении нового соглашения."],
  ["Bloomberg","Экономические последствия","Аналитики сравнивают последствия изменений на рынке."],
  ["Интерфакс-Украина","Украине потребуются дополнительные средства","Киев оценивает потребности в международном финансировании."],
  ["Интерфакс-Украина","Макрон выступил на саммите ЕС","Французский президент прокомментировал европейскую помощь Украине."]
].map(([source,title,statement],i)=>[
  "ID: P"+String(i+1).padStart(2,"0"),
  "TITLE_RU: "+title,
  "ИСТОЧНИК: «"+source+"»",
  "URL: https://press.example/story-"+i,
  "E01 [fact/P001] "+statement+" | SOURCE: «проверенный отрывок»"
].join("\n"));
const coreBranch=(ids)=>({
  id:"B1",title:"Действия Вашингтона и экономические последствия",
  claim:"СМИ рассматривают возможные последствия нового соглашения.",
  mechanism:"Оценки экономических последствий различаются.",
  counterpoint:"",limitation:"",
  significance:"Приводятся различные перспективы участников.",
  priority:"high",required:true,evidence_ids:ids,contrary_evidence_ids:[]
});
const draft=()=>({
  trends:[{id:"T1",title:"Договорённости и экономика",
    summary:"СМИ анализируют международное соглашение.",
    thesis:"Рассматриваются экономические и политические последствия.",
    operator_optional:false,optional_reason:"",
    branches:[coreBranch(["P01:E01","P02:E01"])]}],
  coverage:cards.map((_,i)=>({
    publication_id:"P"+String(i+1).padStart(2,"0"),
    status:i<2?"used":"excluded",
    reason:i<2?"Публикация анализирует основной сюжет.":
      "Сопутствующие обстоятельства рассматриваются отдельно от главной темы."
  })),
  inventory:{quotes:0,headlines:4,experts:0}
});
test("omitted sources are preserved in a transparently labelled editor-review queue, not called peripheral",()=>{
  const original=draft(),copy=JSON.stringify(original);
  const repaired=reconcileDossierDraft(original,cards);
  assert.ok(repaired);
  assert.deepEqual(repaired.additionalSources,["P03","P04"]);
  assert.equal(repaired.draft.trends.length,2);
  assert.equal(repaired.draft.trends[1].operator_optional,true);
  assert.match(repaired.draft.trends[1].title,/редакционного распределения/);
  assert.match(repaired.draft.trends[1].optional_reason,/не оценка их второстепенности/);
  assert.deepEqual(repaired.draft.trends[1].branches.map(b=>b.evidence_ids[0]),["P03:E01","P04:E01"]);
  assert.equal(normalizeDossier(repaired.draft,cards,{requireEveryDistinctSource:true}).error,null);
  assert.equal(JSON.stringify(original),copy);
});
test("invalid invented references are discarded, not silently remapped to a true claim",()=>{
  const corrupted=draft();
  corrupted.trends[0].branches[0].evidence_ids.push("P03:E01","P04:E01");
  corrupted.trends[0].branches.push({...coreBranch(["P03:E99"]),
    id:"B2",title:"Несуществующая ветка"});
  const res=reconcileDossierDraft(corrupted,cards);
  assert.ok(res);
  assert.equal(res.discardedEvidenceRefs,1);
  assert.equal(res.removedBranches,1);
  assert.ok(!JSON.stringify(res.draft).includes("P03:E99"));
  assert.equal(normalizeDossier(res.draft,cards,{requireEveryDistinctSource:true}).error,null);
});
test("cannot create a dossier without a genuine main branch",()=>{
  const empty=draft();
  empty.trends[0].branches=[coreBranch(["P01:E99"])];
  assert.equal(reconcileDossierDraft(empty,cards),null);
});
test("different URLs are independent and a model's incorrect duplicate status is not retained",()=>{
  const raw=draft();raw.coverage[2].status="duplicate";
  const result=reconcileDossierDraft(raw,cards);
  assert.ok(result);
  assert.equal(result.draft.coverage[2].status,"supporting");
  assert.ok(result.draft.trends[1].branches.some(b=>b.evidence_ids.includes("P03:E01")));
});
test("format-only variants are canonicalized, never invented references",()=>{
  const raw=draft();
  raw.trends[0].branches[0].evidence_ids=["P1:E1","P2-E1","P03:E01","P04:E1"];
  const repaired=reconcileDossierDraft(raw,cards);
  assert.ok(repaired);
  assert.deepEqual(repaired.draft.trends[0].branches[0].evidence_ids,
    ["P01:E01","P02:E01","P03:E01","P04:E01"]);
  assert.deepEqual(repaired.additionalSources,[]);
  assert.equal(normalizeDossier(repaired.draft,cards,{requireEveryDistinctSource:true}).error,null);
});
test("a genuinely fabricated citation is NEVER silently mapped to an existing one",()=>{
  const raw=draft();
  raw.trends[0].branches[0].evidence_ids=["P01:E99"];
  assert.equal(reconcileDossierDraft(raw,cards),null);
});
test("existing complete, valid maps pass through without compulsory repair",()=>{
  const raw=draft();
  raw.trends[0].branches[0].evidence_ids.push("P03:E01","P04:E01");
  raw.coverage[2].status="supporting";
  raw.coverage[3].status="supporting";
  const verified=normalizeDossier(raw,cards,{requireEveryDistinctSource:true});
  assert.equal(verified.error,null);
  const result=reconcileDossierDraft(raw,cards);
  assert.ok(result);
  assert.deepEqual(result.additionalSources,[]);
  assert.equal(result.repaired,false);
});

test("genuine model-authored peripheral trend stays optional",()=>{
  const raw=draft();
  raw.trends.push({...raw.trends[0],id:"T2",operator_optional:true,
    optional_reason:"Эта линия относится к дополнительному вопросу оператора.",
    branches:[coreBranch(["P03:E01","P04:E01"])]});
  raw.coverage[2].status="supporting";raw.coverage[3].status="supporting";
  const res=reconcileDossierDraft(raw,cards);
  assert.ok(res);assert.equal(res.draft.trends[1].operator_optional,true);
});

test("18 publications and two invalid Gemini citations preserve sound branches in two review queues",()=>{
  const manyCards=Array.from({length:18},(_,i)=>[
    "ID: P"+String(i+1).padStart(2,"0"),
    "TITLE_RU: Материал об экономических и политических последствиях",
    "ИСТОЧНИК: «Издание "+(i+1)+"»",
    "URL: https://stories.example/item-"+(i+1),
    "E01 [fact/P001] Публикация содержит проверенный факт для самостоятельной редакционной оценки. | SOURCE: «проверяемая выдержка»"
  ].join("\n"));
  const makeTrend=(n,refs)=>({id:"T"+n,title:"Аналитическая линия "+n,
    summary:"Издания освещают различные аспекты международной ситуации.",
    thesis:"Эксперты сравнивают факты и приводят проверяемые оценки.",
    operator_optional:false,optional_reason:"",
    branches:[coreBranch(refs)]});
  const raw={
    trends:[makeTrend(1,["P01:E01","P02:E01"]),
      makeTrend(2,["P03:E01","P04:E01"]),
      makeTrend(3,["P05:E01","P06:E01"])],
    coverage:manyCards.map((_,i)=>({
      publication_id:"P"+String(i+1).padStart(2,"0"),
      status:i<6?"used":"excluded",
      reason:"Публикация самостоятельно рассматривает текущие события."
    })),
    inventory:{quotes:8,headlines:18,experts:4}
  };
  raw.trends[0].branches.push({...coreBranch(["P07:E10"]),
    id:"B2",title:"Некорректная ссылка на седьмой источник"});
  raw.trends[1].branches.push({...coreBranch(["P16:E20"]),
    id:"B2",title:"Некорректная ссылка на шестнадцатый источник"});
  assert.equal(normalizeDossier(raw,manyCards,{requireEveryDistinctSource:true}).error,
    "dossier_unknown_or_missing_evidence");
  const repaired=reconcileDossierDraft(raw,manyCards);
  assert.ok(repaired,"do not reject 12 uncited sources when two queue slots are available");
  assert.equal(repaired.discardedEvidenceRefs,2);
  assert.equal(repaired.removedBranches,2);
  assert.equal(repaired.draft.trends.length,5);
  assert.equal(repaired.draft.trends[3].operator_optional,true);
  assert.equal(repaired.draft.trends[4].operator_optional,true);
  assert.equal(repaired.draft.trends[3].branches.length,9);
  assert.equal(repaired.draft.trends[4].branches.length,3);
  assert.deepEqual(repaired.additionalSources,
    Array.from({length:12},(_,i)=>"P"+String(i+7).padStart(2,"0")));
  assert.ok(!JSON.stringify(repaired.draft).includes("P07:E10"));
  assert.ok(!JSON.stringify(repaired.draft).includes("P16:E20"));
  assert.equal(normalizeDossier(repaired.draft,manyCards,{requireEveryDistinctSource:true}).error,null);
  const synthesis=makeSynthesisDossier(
    normalizeDossier(repaired.draft,manyCards,{requireEveryDistinctSource:true}).dossier,
    ["T1","T2","T3"],8000,manyCards);
  assert.equal(synthesis.coveredPublications,6);
  assert.equal(synthesis.totalPublications,18);
});
test("never exceed five dossier trends merely to force a technical review queue",()=>{
  const manyCards=Array.from({length:18},(_,i)=>[
    "ID: P"+String(i+1).padStart(2,"0"),
    "ИСТОЧНИК: «Газета "+i+"»",
    "E01 [fact/P001] Издание сообщает проверенную информацию. | SOURCE: «фрагмент»"
  ].join("\n"));
  const raw=draft();
  raw.trends=Array.from({length:5},(_,i)=>({
    ...raw.trends[0],id:"T"+(i+1),branches:[coreBranch(["P"+String(i+1).padStart(2,"0")+":E01"])]
  }));
  assert.equal(reconcileDossierDraft(raw,manyCards),null);
});
