import test from "node:test";
import assert from "node:assert/strict";
import { evidenceIndex, normalizeDossier, makeSynthesisDossier, dossierSchema, isRussianDossierProse } from "./editorial-dossier.ts";
const cards=[
  "ID: P01\nИСТОЧНИК: «Reuters»\nPUBLICATION_ID: story-A\nE01 [fact/P001] Прогноз снизился на 2%. | SOURCE: «Прогноз снизился на 2%.»\nE02 [counterposition/P002] Сценарий оспаривают эксперты. | SOURCE: «Сценарий оспаривают эксперты.»",
  "ID: P02\nИСТОЧНИК: «Bloomberg»\nPUBLICATION_ID: story-B\nE01 [expert/P003] Аналитик видит риск роста цен. | SOURCE: «Аналитик видит риск роста цен.»",
  "ID: P03\nИСТОЧНИК: «AP»\nPUBLICATION_ID: story-C\nE01 [fact/P001] Пересказывает пресс-релиз. | SOURCE: «Пересказывает пресс-релиз.»"
];
const branch=(ids=["P01:E01","P02:E01"])=>({
  id:"B1",title:"Ограничение роста",claim:"Прогноз снизился",
  mechanism:"Изменение мирового спроса",counterpoint:"Есть иные оценки",
  limitation:"Прогноз условен",significance:"Меняет риски",
  priority:"high",required:true,evidence_ids:ids,contrary_evidence_ids:["P01:E02"]
});
const draft=()=>({
  trends:[{id:"T1",title:"Замедление",summary:"Снижение прогноза",thesis:"Рост уязвим",
    branches:[branch()]}],
  coverage:[
    {publication_id:"P01",status:"used",reason:"Даёт центральную цифру"},
    {publication_id:"P02",status:"supporting",reason:"Независимая оценка эксперта"},
    {publication_id:"P03",status:"duplicate",reason:"Повторяет тот же релиз"}
  ],
  inventory:{quotes:0,headlines:0,experts:1}
});
test("references preserve identities when publication names repeat",()=>{
  const ix=evidenceIndex(cards);
  assert.deepEqual(ix.publications,["P01","P02","P03"]);
  assert.ok(ix.byId.has("P01:E01"));
  assert.ok(ix.byId.has("P02:E01"));
  assert.equal(ix.entries.length,4);
});
test("dossier requires full publication ledger and only valid evidence IDs",()=>{
  const good=normalizeDossier(draft(),cards);
  assert.equal(good.error,null);
  assert.equal(good.dossier.coverage.length,3);
  assert.deepEqual(good.dossier.trends[0].sources,["Reuters","Bloomberg"]);
  const incomplete=draft();incomplete.coverage.pop();
  assert.equal(normalizeDossier(incomplete,cards).error,"dossier_incomplete_publication_inventory");
  const fabricated=draft();fabricated.trends[0].branches[0].evidence_ids=["P03:E99"];
  assert.equal(normalizeDossier(fabricated,cards).error,"dossier_unknown_or_missing_evidence");
});
test("model cannot declare a publication used without a branch reference",()=>{
  const inconsistent=draft();inconsistent.coverage[2].status="used";
  assert.equal(normalizeDossier(inconsistent,cards).error,"dossier_unsubstantiated_publication");
  const excluded=draft();excluded.coverage[0].status="excluded";
  assert.equal(normalizeDossier(excluded,cards).error,"dossier_conflicting_disposition");
});
test("branch character budgets sum to target exactly",()=>{
  const d=normalizeDossier(draft(),cards).dossier;
  for(const target of [1000,3000,6000,8000]){
    const result=makeSynthesisDossier(d,["T1"],target,cards);
    assert.equal(result.allocatedChars,target);
    assert.equal(result.coveredPublications,2);
    assert.equal(result.totalPublications,3);
    assert.equal(result.requiredBranches,1);
    assert.match(result.text,/P01:E01/);
    assert.match(result.text,/ПРОСМОТРЕННЫЕ/);
  }
});
test("only selected lines enter the synthesis dossier",()=>{
  const sample=draft();sample.trends.push({id:"T2",title:"Дополнение",summary:"Ветвь",
    thesis:"Контраргумент",branches:[{...branch(["P03:E01"]),contrary_evidence_ids:[],required:false}]});
  sample.coverage[2]={publication_id:"P03",status:"used",reason:"Собственная аналитическая линия"};
  const checked=normalizeDossier(sample,cards);
  assert.equal(checked.error,null);
  const made=makeSynthesisDossier(checked.dossier,["T1"],8000,cards);
  assert.equal(made.coveredPublications,2);
  assert.doesNotMatch(made.text,/ЛИНИЯ 2:/);
});
test("schema has mandatory branch evidence and full ledger",()=>{
  const schema=dossierSchema(3);
  assert.equal(schema.properties.coverage.minItems,3);
  assert.equal(schema.properties.coverage.maxItems,3);
  const fields=schema.properties.trends.items.properties.branches.items;
  assert.ok(fields.required.includes("evidence_ids"));
  assert.ok(fields.required.includes("significance"));
});

test("rejects English trend captions and English branch analysis without additional translation",()=>{
  const sample=draft();
  sample.trends[0].title="Sanctions waiver and diesel fuel deal";
  assert.equal(normalizeDossier(sample,cards).error,"dossier_non_russian_trend_T1");
  const details=draft();
  details.trends[0].branches[0].significance="Changes the framework for European security policy";
  assert.equal(normalizeDossier(details,cards).error,"dossier_non_russian_branch_T1:B1_significance");
  const comment=draft();
  comment.coverage[0].reason="This story provides a source for the key claim";
  assert.equal(normalizeDossier(comment,cards).error,"dossier_non_russian_coverage_reason_P01");
});
test("Russian explanatory text may include unchanged Latin brand and source names",()=>{
  assert.equal(isRussianDossierProse("Давление США на Киев из-за Starlink"),true);
  assert.equal(isRussianDossierProse("Reuters и Bloomberg оценивают действия Трампа"),true);
  assert.equal(isRussianDossierProse("Trump’s rhetoric toward Zelensky and political fallout"),false);
  assert.equal(isRussianDossierProse(""),false);
  const d=draft();
  d.trends[0].title="Starlink и давление США на Украину";
  d.trends[0].summary="Reuters сообщает об ограничениях Starlink";
  assert.equal(normalizeDossier(d,cards).error,null);
});
