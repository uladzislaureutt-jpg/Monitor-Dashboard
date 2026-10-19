import test from "node:test";
import assert from "node:assert/strict";
import {dossierQualityMetrics} from "./dossier-quality-metrics.ts";
const card=(id)=>[
  "ID: "+id,"ИСТОЧНИК: «Тестовый источник»",
  "ЗАГОЛОВОК: Тестовая публикация",
  "URL: https://synthetic.invalid/"+id,
  "E01 [fact/P001] Проверенный факт; данные опубликованы редакцией | SOURCE: «Фрагмент»",
  "E02 [counterposition/P002] Другая сторона не согласилась | SOURCE: «Фрагмент»",
  "E03 [expert/P003] Содержательная экспертная оценка | SOURCE: «Фрагмент»",
].join("\n");
const docs=[card("P01"),card("P02"),card("P03")];
const branch=(ids,contrary=[],text="Другие источники оспаривают оценку")=>({
  id:"B",title:"Позиции",claim:"Содержание",
  mechanism:"Сравнение",counterpoint:text,limitation:"",
  significance:"Важно",priority:"high",required:true,
  evidence_ids:ids,contrary_evidence_ids:contrary
});
const dossier=(branches,coverage=[])=>({
  version:3,trends:[{id:"T1",title:"Сюжет",summary:"Тема",thesis:"Вывод",sources:[],
    operator_optional:false,optional_reason:"",branches}],
  coverage:coverage.length?coverage:["P01","P02","P03"].map(x=>({publication_id:x,status:"used",reason:"Материал учтён",evidence_ids:[]})),
  inventory:{quotes:0,headlines:0,experts:0}
});
test("Counts 3-publication coverage, distinct IDs, and accurate contrary reference stats",()=>{
  const metric=dossierQualityMetrics(dossier([
    branch(["P01:E01","P02:E01"],["P02:E02"]),
    branch(["P03:E03"],[],"")
  ]),docs);
  assert.equal(metric.publications_total,3);
  assert.equal(metric.source_evidence_total,9);
  assert.equal(metric.unique_used_evidence,4);
  assert.equal(metric.linked_publications,3);
  assert.equal(metric.unlinked_publications,0);
  assert.equal(metric.contrary_unique_evidence,1);
  assert.equal(metric.branches_with_contrary,1);
  assert.equal(metric.same_id_on_both_sides,0);
  assert.equal(metric.counterpoint_text_without_contrary_refs,0);
});
test("Separately flags superficial text-only contradiction, reused IDs and highly overlapping branches",()=>{
 const m=dossierQualityMetrics(dossier([
   branch(["P01:E01","P02:E01"],["P01:E02"]),
   branch(["P01:E01","P02:E01"],["P01:E01"])
 ]),docs);
 assert.equal(m.linked_publications,2);
 assert.equal(m.unlinked_publications,1);
 assert.equal(m.branches_with_counterpoint_text,2);
 assert.ok(m.same_id_on_both_sides>=1);
 assert.ok(m.suspicious_high_overlap_branch_pairs>=1);
 assert.equal(m.publications_with_one_or_fewer_refs>=1,true);
});
test("No operator text or addresses are included in metric fields",()=>{
 const m=dossierQualityMetrics(dossier([branch(["P01:E01","P02:E01","P03:E01"])]),docs);
 const out=JSON.stringify(m);
 assert.ok(!out.includes("synthetic.invalid"));
 assert.ok(!out.includes("Тестовый"));
 assert.ok(!out.includes("Позиции"));
 assert.ok(!out.includes("P01:E01"));
});
