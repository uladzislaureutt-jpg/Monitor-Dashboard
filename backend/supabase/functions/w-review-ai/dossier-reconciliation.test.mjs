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
test("P03 and P04 become a separate optional trend, not a forced paragraph",()=>{
  const original=draft();
  assert.equal(normalizeDossier(original,cards,{requireEveryDistinctSource:true}).error,
    "dossier_unlinked_sources_P03_P04");
  const reconciled=reconcileDossierDraft(original,cards);
  assert.ok(reconciled);
  assert.deepEqual(reconciled.additionalSources,["P03","P04"]);
  assert.equal(reconciled.draft.trends.length,2);
  assert.equal(reconciled.draft.trends[0].operator_optional,false);
  assert.equal(reconciled.draft.trends[1].operator_optional,true);
  assert.equal(reconciled.draft.trends[1].branches.length,2);
  assert.equal(reconciled.draft.coverage.filter(v=>v.status==="excluded").length,0);
  const valid=normalizeDossier(reconciled.draft,cards,{requireEveryDistinctSource:true});
  assert.equal(valid.error,null);
  const standard=makeSynthesisDossier(valid.dossier,["T1"],8000,cards);
  const withExtras=makeSynthesisDossier(valid.dossier,["T1","T2"],8000,cards);
  assert.equal(standard.coveredPublications,2);
  assert.equal(withExtras.coveredPublications,4);
  assert.doesNotMatch(standard.text,/Дополнительная линия:/);
  assert.match(withExtras.text,/Дополнительная линия:/);
});
test("invalid invented references are discarded, not silently remapped to a true claim",()=>{
  const corrupted=draft();
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
test("separate URLs about the same event remain independent",()=>{
  const raw=draft();
  const result=reconcileDossierDraft(raw,cards);
  assert.deepEqual(result.additionalSources,["P03","P04"]);
  assert.equal(result.draft.coverage[2].status,"supporting");
  assert.equal(result.draft.coverage[3].status,"supporting");
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
