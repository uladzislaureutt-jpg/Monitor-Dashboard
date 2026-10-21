import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assignQueuedPublication,isTechnicalReviewQueue,
  pendingEditorialAssignments,availableEditorialTargets}
  from "./wReviewEditorialDistribution.ts";
const branch=(id,title,refs)=>({
  id,title,claim:"Проверенные публикации подтверждают смысловой сюжет.",
  mechanism:"",counterpoint:"",limitation:"",
  significance:"Содержание существенно для темы.",priority:"high",required:true,
  evidence_ids:refs,contrary_evidence_ids:[]
});
const build=()=>{
  const trends=[{
    id:"T1",title:"Международная экономика",summary:"",thesis:"",sources:["CNN"],
    operator_optional:false,optional_reason:"",
    branches:[branch("T1:B1","Финансовые риски",["P01:E01","P02:E01","P03:E01","P04:E01"])]
  },{
    id:"T2",title:"Политические последствия",summary:"",thesis:"",sources:["BBC"],
    operator_optional:false,optional_reason:"",
    branches:[branch("T2:B1","Реакция правительств",["P05:E01","P06:E01","P07:E01","P08:E01"])]
  },{
    id:"T3",title:"Технологии и ИИ",summary:"",thesis:"",sources:["FT"],
    operator_optional:false,optional_reason:"",
    branches:[branch("T3:B1","Финансирование инфраструктуры",["P09:E01","P10:E01","P11:E01"])]
  },{
    id:"T4",title:"Публикации для редакционного распределения",
    summary:"",thesis:"",sources:["Bloomberg"],
    operator_optional:true,optional_reason:"Не является оценкой второстепенности",
    branches:[{...branch("T4:B1","Материал P12 – Bloomberg",["P12:E04"]),required:false}]
  }];
  return {
    version:3,trends,
    coverage:Array.from({length:12},(_,i)=>({
      publication_id:"P"+String(i+1).padStart(2,"0"),
      status:i===11?"supporting":"used",
      reason:"Публикация должна подтверждать самостоятельный аспект темы.",
      evidence_ids:["P"+String(i+1).padStart(2,"0")+":E01"]
    })),
    inventory:{quotes:17,headlines:1,experts:8}
  };
};
test("12/12 saved, 11 main-linked: P12 is an existing pool publication, not a fourth topic",()=>{
 const state=build();
 const before=JSON.stringify(state);
 const queue=pendingEditorialAssignments(state);
 assert.deepEqual(queue.map(x=>x.publicationId),["P12"]);
 assert.equal(isTechnicalReviewQueue(state.trends[3]),true);
 assert.equal(isTechnicalReviewQueue(state.trends[2]),false);
 assert.equal(availableEditorialTargets(state).length,3);
 assert.equal(JSON.stringify(state),before);
});
test("operator explicitly binds verified P12:E04 to meaningful line, removes empty fake trend",()=>{
 const source=build(),before=JSON.stringify(source);
 const result=assignQueuedPublication(source,"P12","T3:B1");
 assert.equal(result.trends.length,3);
 assert.deepEqual(result.trends[2].branches[0].evidence_ids,
   ["P09:E01","P10:E01","P11:E01","P12:E04"]);
 assert.ok(result.trends[2].sources.includes("Bloomberg"));
 assert.equal(result.coverage[11].status,"supporting");
 assert.ok(result.coverage[11].evidence_ids.includes("P12:E04"));
 assert.match(result.coverage[11].reason,/Оператор распределил публикацию/);
 assert.equal(result.inventory.quotes,17);
 assert.equal(pendingEditorialAssignments(result).length,0);
 assert.equal(JSON.stringify(source),before,"saved original map must remain unchanged");
});
test("a truly peripheral model-authored optional topic is NOT treated as a technical queue",()=>{
 const map=build();
 map.trends[3].title="Альтернативные расчёты";
 assert.equal(isTechnicalReviewQueue(map.trends[3]),false);
 assert.equal(pendingEditorialAssignments(map).length,0);
});
test("no silent automatic inference; reject invalid target and evidence over-cap",()=>{
 const map=build();
 assert.throws(()=>assignQueuedPublication(map,"P12","T99:B1"),/Выберите содержательную/);
 assert.throws(()=>assignQueuedPublication(map,"P12","T4:B1"),/Выберите содержательную/);
 assert.throws(()=>assignQueuedPublication(map,"P11","T3:B1"),/не находится/);
 map.trends[2].branches[0].evidence_ids=Array.from({length:18},(_,i)=>
   "P09:E"+String(i+1).padStart(2,"0"));
 assert.throws(()=>assignQueuedPublication(map,"P12","T3:B1"),/лимит Evidence/);
});
test("frontend shows actual pool title/source and explicit button, not a generated extra trend",()=>{
 const ui=readFileSync(new URL("./views/WReviewView.tsx",import.meta.url),"utf8");
 assert.ok(ui.includes("Публикации, не распределённые по сюжетам"));
 assert.ok(ui.includes("item?.title||p.publicationId"));
 assert.ok(ui.includes("item?.source||"));
 assert.ok(ui.includes("Привязать к сюжету"));
 assert.ok(ui.includes("assignQueuedPublication(state.editorialMap,publicationId,target)"));
 assert.ok(ui.includes("disabled={busy!==\"\"||isTechnicalReviewQueue(trend)}"));
 assert.ok(ui.includes("!isTechnicalReviewQueue(trend)) : []"));
});
