import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,rmSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
 MODEL_SPECS,FULL_TEST_IDS,GOLD_OPPOSITION_PAIRS,ANALYTIC_CONTRAST_CONTRACT,fixtureCards,fixtureSet,evaluateDossier,extractCloudflareText,
 callCandidate,runComparison
} from "./trend-model-benchmark.mjs";

const makeDossier=(cards)=>{
 const ids=cards.map((_,i)=>"P"+String(i+1).padStart(2,"0")+":E01");
 const branches=[];
 for(let i=0;i<ids.length;i+=9){
   branches.push({id:"B"+(i+1),title:"Различия экономических оценок",
     claim:"Редакции приводят самостоятельные оценки модернизации",
     mechanism:"Разные финансовые и инфраструктурные ограничения",
     counterpoint:"Другие редакции приводят противоположные оценки",
     limitation:"Выводы условны",significance:"Важная линия медиаполя",
     priority:"high",required:true,evidence_ids:ids.slice(i,i+9),
     contrary_evidence_ids:[]});
 }
 return {
   trends:[{id:"T1",title:"Модернизация и оценки расходов",
     summary:"Редакции освещают риски проектов и спорят об их перспективах",
     thesis:"Существуют различия в аргументах разных источников",
     operator_optional:false,optional_reason:"",branches}],
   coverage:cards.map((_,i)=>({publication_id:"P"+String(i+1).padStart(2,"0"),
     status:"used",reason:"Представлена самостоятельная оценка проекта"})),
   inventory:{quotes:0,headlines:0,experts:0}
 };
};
test("full synthetic source-anchored dossier has 18 unique outlets and 167 Evidence",()=>{
 const small=fixtureSet("small"),full=fixtureSet("full");
 assert.equal(small.source_count,8);
 assert.equal(small.evidence_count,80);
 assert.equal(full.source_count,18);
 assert.equal(full.evidence_count,167);
 assert.ok(full.input_characters>small.input_characters);
 assert.equal((new Set(full.cards.map(c=>c.match(/^ИСТОЧНИК:\s*(.+)$/m)?.[1]))).size,18);
 assert.match(full.evidenceText,/P18:E09/);
 assert.match(full.evidenceText,/P01:E10/);
 assert.doesNotMatch(full.evidenceText,/P18:E10/);
 assert.equal(full.rareSource,"P18");
 for(const f of [small,full])assert.ok(f.prompt.includes("ЗАДАНИЕ ОПЕРАТОРА"));
});
test("strict grounding checks publication coverage, wrong IDs and a rare source",()=>{
 const f=fixtureSet("full"),d=makeDossier(f.cards);
 const clean=evaluateDossier(JSON.stringify(d),f.cards,"P18");
 assert.equal(clean.strict_valid,true);
 assert.equal(clean.linked_publications,18);
 assert.equal(clean.coverage_complete,true);
 assert.equal(clean.rare_source_linked,true);
 assert.equal(clean.invalid_references,0);
 assert.equal(clean.branches,2);
 d.trends[0].branches[1].evidence_ids[0]="P10:E99";
 const broken=evaluateDossier(JSON.stringify(d),f.cards,"P18");
 assert.equal(broken.strict_valid,false);
 assert.ok(broken.invalid_references>0);
 assert.ok(broken.strict_error.includes("unknown_or_missing_evidence"));
});
test("cloudflare response extraction handles structured and chat completion forms",()=>{
 assert.equal(extractCloudflareText({result:{response:"{}"}}),"{}");
 assert.equal(extractCloudflareText({result:{response:{trends:[]}}}),JSON.stringify({trends:[]}));
 assert.equal(extractCloudflareText({result:{choices:[{message:{content:"{}"}}]}}),"{}");
});
test("each supported model sends identical synthetic evidence, no real operator data",async()=>{
 const f=fixtureSet("small"),body=JSON.stringify(makeDossier(f.cards));
 const seen=[];
 const mock=async(url,req)=>{
   const payload=JSON.parse(req.body);
   seen.push({url,payload});
   return new Response(JSON.stringify(
     url.includes("generativelanguage")
       ? {candidates:[{finishReason:"STOP",content:{parts:[{text:body}]}}],
          usageMetadata:{promptTokenCount:100,candidatesTokenCount:210}}
       : {success:true,result:{response:body,usage:{prompt_tokens:100,completion_tokens:210}}}
   ),{status:200,headers:{"content-type":"application/json"}});
 };
 const keyset={gemini:"mock",cfAccount:"test-account",cfToken:"mock-token"};
 for(const spec of MODEL_SPECS){
   const result=await callCandidate(spec,f,keyset,mock,1000);
   assert.equal(result.http_status,200);
   assert.equal(result.strict_valid,true,spec.id);
   assert.equal(result.rare_source_linked,true);
   assert.equal(result.linked_publications,8);
   assert.ok(Number.isFinite(result.elapsed_ms));
 }
 assert.equal(seen.length,5);
 const gemini=seen.find(x=>x.url.includes("generativelanguage"));
 assert.ok(gemini.payload.contents[0].parts[0].text.includes("P08:E01"));
 for(const item of seen.filter(x=>x.url.includes("cloudflare"))){
   assert.ok(item.payload.messages[1].content.includes("P08:E01"));
   assert.ok(item.payload.messages[1].content.includes("Тестовая редакция")===false);
 }
});
test("status 403 and 429 are reported as eligibility/limit, not bad dossier",async()=>{
 const f=fixtureSet("small"),keys={gemini:"fake",cfAccount:"123",cfToken:"fake"};
 const spec=MODEL_SPECS.find(x=>x.id==="gemma4");
 const denied=await callCandidate(spec,f,keys,async()=>new Response(
   JSON.stringify({errors:[{code:5035,message:"Upgrade to paid"}]}),
   {status:403,headers:{"content-type":"application/json"}}),1000);
 assert.equal(denied.http_status,403);
 assert.equal(denied.model_eligible,"free_tier_rejected");
 assert.equal(denied.error_category,"free_tier_or_permission");
 const limit=await callCandidate(spec,f,keys,async()=>new Response("{}",{status:429}),1000);
 assert.equal(limit.error_category,"rate_or_daily_limit");
});
test("never attempt live calls when both GitHub secrets are missing",async()=>{
 const root=mkdtempSync(join(tmpdir(),"w-review-model-"));
 try{
 const r=await runComparison({keys:{},models:MODEL_SPECS.slice(0,2),
   cohorts:["small"],delayMs:0,output:root,fetchImpl:()=>{throw Error("NO NETWORK");}});
 assert.equal(r.requests,0);
 assert.ok(r.rows.every(x=>x.model_eligible==="not_tested"));
 assert.ok(existsSync(join(root,"metrics.json")));
 assert.ok(existsSync(join(root,"report.md")));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("bounded live experiment forbids more than ten model calls",async()=>{
 await assert.rejects(runComparison({keys:{},cohorts:["small","full","small"],delayMs:0,
   output:"unused-output"}),/TEST_CALL_LIMIT_EXCEEDED/);
});

test("full experiment is exactly 3 models, 18 sources and 167 Evidence",()=>{
 assert.deepEqual(FULL_TEST_IDS,["gemini35","oss120","nemotron120"]);
 const f=fixtureSet("full");
 assert.equal(f.evidence_count,167);
 assert.equal(f.source_count,18);
 assert.ok(f.prompt.includes("ПРОВЕРЯЕМАЯ РЕДАКЦИОННАЯ ДИСЦИПЛИНА"));
 assert.ok(ANALYTIC_CONTRAST_CONTRACT.includes("contrary_evidence_ids"));
 assert.equal(GOLD_OPPOSITION_PAIRS.length,5);
 for(const [positive,opposing] of GOLD_OPPOSITION_PAIRS){
   assert.ok(f.evidenceText.includes(positive),"Missing "+positive);
   assert.ok(f.evidenceText.includes(opposing),"Missing "+opposing);
 }
});
test("five gold disagreements are evaluated from anchored references, not raw output size",()=>{
 const f=fixtureSet("full"),d=makeDossier(f.cards);
 const base=evaluateDossier(JSON.stringify(d),f.cards,"P18");
 assert.equal(base.gold_opposition_pairs_total,5);
 assert.equal(base.gold_opposition_pairs_contrasted,0);
 assert.equal(base.facets_with_all_publications,5);
 assert.equal(base.invalid_references,0);
 const b=d.trends[0].branches[0];
 b.evidence_ids.push("P01:E05");
 b.contrary_evidence_ids=["P04:E05"];
 const withDisagreement=evaluateDossier(JSON.stringify(d),f.cards,"P18");
 assert.equal(withDisagreement.gold_opposition_pairs_linked,1);
 assert.equal(withDisagreement.gold_opposition_pairs_contrasted,1);
 assert.equal(withDisagreement.contrary_evidence_distinct,1);
 assert.equal(withDisagreement.contrary_publications_distinct,1);
});
test("repeated titles and IDs are flagged as possible duplicate branches, not silently removed",()=>{
 const f=fixtureSet("small"),d=makeDossier(f.cards);
 const original=d.trends[0].branches[0];
 const copy={...original,id:"B_DUPLICATE",evidence_ids:[...original.evidence_ids]};
 d.trends[0].branches.push(copy);
 const q=evaluateDossier(JSON.stringify(d),f.cards,"P08");
 assert.ok(q.suspicious_duplicate_text_pairs>=1);
 assert.ok(q.suspicious_duplicate_evidence_pairs>=1);
});
test("three providers all see the SAME amplified contract, and synthetic outputs remain reviewable",async()=>{
 const f=fixtureSet("full"),seen=[],outputs=[];
 const modelIds=FULL_TEST_IDS.map(id=>MODEL_SPECS.find(model=>model.id===id));
 const mock=async (_url,opts)=>{
   const body=JSON.parse(opts.body);
   seen.push(_url.includes("generativelanguage")?body.contents[0].parts[0].text:
     body.messages[0].content+"\n\n"+body.messages[1].content);
   const reply=JSON.stringify(makeDossier(f.cards));
   return new Response(JSON.stringify(_url.includes("generativelanguage")
     ?{candidates:[{finishReason:"STOP",content:{parts:[{text:reply}]}}]}
     :{success:true,result:{response:reply}}),{status:200,headers:{"content-type":"application/json"}});
 };
 for(const spec of modelIds){
   const r=await callCandidate(spec,f,{gemini:"dummy",cfAccount:"test",cfToken:"dummy"},
     mock,5000,x=>outputs.push(x));
   assert.equal(r.http_status,200);
   assert.equal(r.gold_opposition_pairs_total,5);
 }
 assert.equal(new Set(seen).size,1);
 assert.equal(outputs.length,3);
 assert.ok(outputs.every(x=>x.cohort==="full"&&x.content.includes('"trends"')));
});
