import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {EVIDENCE_MODELS,testCorpus,identicalEvidencePrompt,evaluateEvidence,
  callEvidenceModel,runEvidenceComparison} from "./evidence-model-benchmark.mjs";

const makeRecords=(d)=>d.passages.slice(0,5).map(p=>({
  kind:"fact",statement_ru:"Тестовое утверждение по фрагменту "+p.id+" содержит конкретные сведения о расходах и оценках.",
  anchor_id:p.id,source_excerpt:p.text.slice(0,Math.min(60,p.text.length)),
  original_quote:"",quote_ru:"",speaker:"",role:""
}));
const payload=(docs)=>JSON.stringify({cards:docs.map((d,index)=>({
  index,title_ru:"Тестовое описание",records:makeRecords(d)
}))});
test("two published synthetic pairs have matching API-usable Evidence v2 prompts",()=>{
 const corpora=testCorpus();
 assert.deepEqual(corpora.map(x=>x.name),["short_pair","long_pair"]);
 assert.deepEqual(corpora.map(x=>x.docs.length),[2,2]);
 assert.ok(corpora[0].docs.every(d=>d.passages.length>=4));
 assert.ok(corpora[1].docs.every(d=>d.passages.length>=15));
 assert.ok(corpora[1].docs.every(d=>d.passages.reduce((n,p)=>n+p.text.length,0)>4500));
 for(const cohort of corpora){
   const prompt=identicalEvidencePrompt(cohort.docs);
   assert.ok(prompt.includes("CARD_INDEX: 0"));
   assert.ok(prompt.includes("CARD_INDEX: 1"));
   assert.ok(prompt.includes("source_excerpt"));
   assert.ok(prompt.includes("MATERIAL_1"));
   assert.ok(prompt.includes("MATERIAL_2"));
 }
 assert.equal(EVIDENCE_MODELS.length,3);
});
test("actual Evidence validation retains source anchors and warns on sparse long cards",()=>{
 for(const cohort of testCorpus()){
   const good=evaluateEvidence(payload(cohort.docs),cohort.docs);
   assert.equal(good.cards_accepted,2);
   assert.equal(good.records_accepted,10);
   assert.equal(good.records_rejected,0);
   assert.equal(good.cards_requested,2);
   assert.equal(good.failures.length,0);
 }
 const cohort=testCorpus()[0];
 const edited=JSON.parse(payload(cohort.docs));
 edited.cards[0].records[0].source_excerpt="Событие, которого вообще не было в исходной статье";
 const checked=evaluateEvidence(JSON.stringify(edited),cohort.docs);
 assert.ok(checked.records_rejected>=1||checked.cards_accepted<2);
});
test("three API models see identical input and identical anchored verifier",async()=>{
 const cohort=testCorpus()[0],seen=[];
 const mock=async(url,options)=>{
   const request=JSON.parse(options.body);
   const prompt=url.includes("generativelanguage")?
     request.contents[0].parts[0].text:request.messages[0].content;
   seen.push({url,prompt,body:request});
   const content=payload(cohort.docs);
   return new Response(JSON.stringify(url.includes("generativelanguage")?
     {candidates:[{finishReason:"STOP",content:{parts:[{text:content}]}}],
      usageMetadata:{promptTokenCount:700,candidatesTokenCount:350}}:
     {success:true,result:{response:content,usage:{prompt_tokens:700,completion_tokens:350}}}),
     {status:200,headers:{"content-type":"application/json"}});
 };
 const keys={gemini:"mock",cfAccount:"account",cfToken:"mock"};
 for(const spec of EVIDENCE_MODELS){
   const r=await callEvidenceModel(spec,cohort.docs,keys,mock,2000);
   assert.equal(r.status,200);
   assert.equal(r.cards_accepted,2);
   assert.equal(r.records_accepted,10);
   assert.equal(r.input_tokens,700);
   assert.ok(r.elapsed_ms>=0);
 }
 assert.equal(new Set(seen.map(x=>x.prompt)).size,1);
 assert.equal(seen.find(x=>x.url.includes("nemotron"))?.body.chat_template_kwargs.enable_thinking,false);
 assert.equal(seen.find(x=>x.url.includes("gpt-oss"))?.body.response_format.type,"json_object");
 assert.equal(seen.find(x=>x.url.includes("generativelanguage"))?.body.generationConfig.responseMimeType,"application/json");
});
test("403, 429 and timeout do not get counted as low-quality Evidence",async()=>{
 const docs=testCorpus()[0].docs;
 const keys={cfAccount:"a",cfToken:"k"};
 for(const status of [403,429]){
   const row=await callEvidenceModel(EVIDENCE_MODELS[2],docs,keys,
     async()=>new Response(JSON.stringify({error:"unavailable"}),{status}),1000);
   assert.equal(row.status,status);
   assert.ok(row.error_category);
   assert.equal(row.cards_accepted,undefined);
 }
});
test("six-call diagnostic saves synthetic metrics without touching production",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"w-evidence-model-"));
 const corpus=testCorpus();
 try{
   const rows=await runEvidenceComparison({
     keys:{},models:EVIDENCE_MODELS,cohorts:corpus,
     fetchImpl:()=>{throw Error("NETWORK_SHOULD_NOT_BE_CALLED")},delayMs:0,output:folder
   });
   assert.equal(rows.length,6);
   assert.ok(rows.every(x=>x.eligibility==="not_tested"));
   const text=readFileSync(join(folder,"metrics.json"),"utf8");
   assert.equal(JSON.parse(text).requests,0);
 }finally{rmSync(folder,{recursive:true,force:true});}
 await assert.rejects(runEvidenceComparison({keys:{},models:EVIDENCE_MODELS,
   cohorts:[...corpus,...corpus],delayMs:0,output:"ignored"}),/REQUEST_LIMIT_EXCEEDED/);
});
