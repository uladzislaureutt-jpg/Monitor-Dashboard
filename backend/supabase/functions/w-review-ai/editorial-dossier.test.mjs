import test from "node:test";
import assert from "node:assert/strict";
import { evidenceIndex, normalizeDossier, makeSynthesisDossier, dossierSchema, isRussianDossierProse, compactDossierCards, DOSSIER_INSTRUCTIONS } from "./editorial-dossier.ts";
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

test("new dossier rejects unjustified omission but old saved dossier remains compatible",()=>{
  const raw=draft();
  // P03 carries verified substantive Evidence but the model labelled it duplicate.
  assert.equal(normalizeDossier(raw,cards).error,null);
  assert.equal(normalizeDossier(raw,cards,{requireEveryDistinctSource:true}).error,
    "dossier_unlinked_sources_P03");
  raw.trends[0].branches[0].evidence_ids.push("P03:E01");
  raw.coverage[2].status="supporting";
  assert.equal(normalizeDossier(raw,cards,{requireEveryDistinctSource:true}).error,null);
});
test("same topic at different news outlets is not a source duplicate",()=>{
  const marked=draft();
  const differentUrls=cards.map((v,i)=>v+"\nURL: https://press.example/story-"+i);
  assert.equal(normalizeDossier(marked,differentUrls,{requireEveryDistinctSource:true}).error,
    "dossier_unlinked_sources_P03");
  // Exact same URL (not just same news story), with a previously linked copy.
  const identical=[differentUrls[0],differentUrls[1],
    cards[2]+"\nURL: https://press.example/story-0"];
  assert.equal(normalizeDossier(marked,identical,{requireEveryDistinctSource:true}).error,null);
});
test("the last two of 18 publications are required even when Evidence was prepared separately",()=>{
  const full=Array.from({length:18},(_,i)=>{
    const src=i>=16?"Поздний резервный провайдер":"Основной провайдер";
    return "ID: P"+String(i+1).padStart(2,"0")+"\nИСТОЧНИК: «"+src+"»\n"+
      "URL: https://example.org/story-"+(i+1)+"\n"+
      "E01 [fact/P001] Факт "+(i+1)+" подтверждён по материалу. | SOURCE: «Факт подтверждён.»";
  });
  const raw=draft();
  raw.trends=[{id:"T1",title:"Анализ международного кризиса",
    summary:"Факторы и ограничения кризиса",thesis:"Определены самостоятельные последствия",
    branches:[{...branch(Array.from({length:16},(_,i)=>
      "P"+String(i+1).padStart(2,"0")+":E01")),contrary_evidence_ids:[]}]}];
  raw.coverage=Array.from({length:18},(_,i)=>({
    publication_id:"P"+String(i+1).padStart(2,"0"),
    status:i<16?"used":"reserve",
    reason:i<16?"Использованы сведения публикации":"Публикация оставлена за рамками плана"
  }));
  assert.equal(normalizeDossier(raw,full,{requireEveryDistinctSource:true}).error,
    "dossier_unlinked_sources_P17_P18");
  raw.trends[0].branches[0].evidence_ids.push("P17:E01","P18:E01");
  // Max 18 references per branch; all 18 are a valid set.
  raw.coverage[16].status="supporting";raw.coverage[17].status="supporting";
  assert.equal(normalizeDossier(raw,full,{requireEveryDistinctSource:true}).error,null);
  // Even when a model reorders the ledger, IDs are the source of truth.
  raw.coverage.reverse();
  assert.equal(normalizeDossier(raw,full,{requireEveryDistinctSource:true}).error,null);
});
test("headline-only references do not falsely count an article as substantively covered",()=>{
  const sample=draft(), changed=[...cards];
  changed[2]+="\nE02 [headline/TITLE] Заголовок о рисках. | SOURCE: «Заголовок о рисках.»";
  sample.trends[0].branches[0].evidence_ids.push("P03:E02");
  sample.coverage[2].status="supporting";
  assert.equal(normalizeDossier(sample,changed,{requireEveryDistinctSource:true}).error,
    "dossier_unlinked_sources_P03");
  sample.trends[0].branches[0].evidence_ids.push("P03:E01");
  assert.equal(normalizeDossier(sample,changed,{requireEveryDistinctSource:true}).error,null);
});

test("peripheral stories form separately selectable trends without forced inclusion",()=>{
  const data=draft();
  data.trends[0].operator_optional=false;
  data.trends[0].optional_reason="";
  data.trends.push({id:"T2",title:"Европейская поддержка и потребности Украины",
    summary:"Вне центрального сюжета о действиях США",
    thesis:"Европейские партнёры обсуждают поддержку Украины",
    operator_optional:true,
    optional_reason:"Связано с кризисом, но не является центральным сюжетом политики США",
    branches:[{...branch(["P03:E01"]),contrary_evidence_ids:[],
      title:"Роль европейских союзников",claim:"Отдельные политические позиции",
      significance:"Дополняет международную картину",required:false}]});
  data.coverage[2].status="supporting";
  data.coverage[2].reason="Отдельная линия европейской поддержки и финансирования";
  const checked=normalizeDossier(data,cards,{requireEveryDistinctSource:true});
  assert.equal(checked.error,null);
  assert.equal(checked.dossier.trends[0].operator_optional,false);
  assert.equal(checked.dossier.trends[1].operator_optional,true);
  const mainOnly=makeSynthesisDossier(checked.dossier,["T1"],8000,cards);
  assert.equal(mainOnly.coveredPublications,2);
  assert.doesNotMatch(mainOnly.text,/Европейская поддержка и потребности Украины/);
  const includingExtra=makeSynthesisDossier(checked.dossier,["T1","T2"],8000,cards);
  assert.equal(includingExtra.coveredPublications,3);
  assert.match(includingExtra.text,/Европейская поддержка и потребности Украины/);
});
test("optional trend must explain editorial discretion in Russian",()=>{
  const data=draft();
  data.trends[0].operator_optional=true;
  data.trends[0].optional_reason="";
  assert.equal(normalizeDossier(data,cards).error,"dossier_optional_reason_required_T1");
  data.trends[0].optional_reason="This is a peripheral editorial line";
  assert.equal(normalizeDossier(data,cards).error,"dossier_optional_reason_required_T1");
  data.trends[0].optional_reason="Отдельная линия, оператор может её исключить";
  assert.equal(normalizeDossier(data,cards).error,null);
  const schema=dossierSchema(3).properties.trends.items;
  assert.ok(schema.required.includes("operator_optional"));
  assert.ok(schema.required.includes("optional_reason"));
});
test("compact dossier transport preserves every verified Evidence ID even beyond 14 records",()=>{
  const long=["ID: P01","ИСТОЧНИК: «Издание»","ЗАГОЛОВОК: Новости",
    "URL: https://example.test/a"];
  for(let n=1;n<=24;n++)long.push("E"+String(n).padStart(2,"0")+
    " [fact/P"+String(n).padStart(3,"0")+"] Релевантный факт номер "+n+
    " подтверждён. | SOURCE: «Длинная дословная выдержка "+n+
    " из оригинального текста без подмены.»");
  const original=long.join("\n"),compact=compactDossierCards([original])[0];
  assert.ok(compact.length<original.length);
  assert.match(compact,/P01:E01 \[fact\/P001\]/);
  assert.match(compact,/P01:E24 \[fact\/P024\]/);
  assert.equal((compact.match(/^P01:E\d+ /gm)||[]).length,24);
  assert.doesNotMatch(compact,/\| SOURCE: /);
  assert.match(compact,/https:\/\/example\.test\/a/);
});

test("compact dossier preserves existing catalog region but never infers outlet nationality",()=>{
  const named=["ID: P01","ИСТОЧНИК: «BBC News»","КАТАЛОЖНЫЙ_РЕГИОН: Великобритания",
    "ЗАГОЛОВОК: Обзор","E01 [fact/P001] Эксперт приводит уточнение. | SOURCE: «Цитата.»"].join("\n");
  const unknown=["ID: P02","ИСТОЧНИК: «Media X»","КАТАЛОЖНЫЙ_РЕГИОН: не указан",
    "ЗАГОЛОВОК: Обзор","E01 [fact/P001] Эксперт приводит оговорку. | SOURCE: «Цитата.»"].join("\n");
  const result=compactDossierCards([named,unknown]);
  assert.match(result[0],/КАТАЛОЖНЫЙ_РЕГИОН: Великобритания/);
  assert.match(result[1],/КАТАЛОЖНЫЙ_РЕГИОН: не указан/);
  assert.match(result[0],/P01:E01/);
  assert.match(result[1],/P02:E01/);
});

test('JSON-only dossier contract includes all nested fields and full pool cardinality',async()=>{
 const {dossierOutputContract,dossierShape}=await import('./editorial-dossier.ts');
 const contract=dossierOutputContract(18);
 const example=JSON.parse(contract.split('\n')[1]);
 assert.deepEqual(Object.keys(example),['trends','coverage','inventory']);
 assert.ok(example.trends[0].branches[0].evidence_ids.length);
 assert.match(contract,/ровно 18 записей/);
 assert.deepEqual(dossierShape({trends:[{branches:[{},{}]}],coverage:[{}]}),{parsed_object:true,trends_array:true,trends_count:1,branch_counts:[2],coverage_count:1});
});

test("dossier one-pass editorial protocol requires grounded counterpositions, expert attribution, late evidence and nonduplicated branches",()=>{
  const contract=DOSSIER_INSTRUCTIONS;
  for(const phrase of ["ВНУТРЕННЯЯ РЕДАКЦИОННАЯ СВЕРКА","значимые поздние Evidence","contrary_evidence_ids",
     "публикации действительно оспаривают","Не включай один Evidence ID",
     "НЕ ДУБЛИРУЙ ВЕТКИ","АТРИБУЦИЯ","ФИНАЛЬНАЯ СВЕРКА"]){
    assert.ok(contract.includes(phrase),"Missing editorial safeguard: "+phrase);
  }
  assert.ok(contract.includes("Верни только JSON"));
  assert.ok(!contract.includes("в ответе покажи ход рассуждений"));
});
