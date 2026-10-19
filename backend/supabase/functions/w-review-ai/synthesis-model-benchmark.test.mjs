import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {synthesisFixture,TARGET_CHARS,TARGETS_FOR_OFFLINE,
  BENCHMARK_ROUTES,outputBudget,checkReview,callProvider,runBenchmark}
  from "./synthesis-model-benchmark.mjs";
import {readFileSync as readSource} from "node:fs";
const runtime=readSource(new URL("./index.ts",import.meta.url),"utf8");
test("exact synthetic pool size and real v3 source-grounded plan for 3000-8000",()=>{
 for(const target of TARGETS_FOR_OFFLINE){
  const fx=synthesisFixture(target);
  assert.equal(fx.cards.length,18);
  assert.equal(fx.plan.coveredPublications,18);
  assert.equal(fx.plan.totalPublications,18);
  assert.equal(fx.plan.blocks.reduce((n,b)=>n+b.targetChars,0),target);
  assert.deepEqual(fx.plan.blocks.map(x=>x.id),[
    "opening","line_1","line_2","line_3","line_4","line_5","ending"]);
  assert.equal(fx.plan.requiredBranches,5);
  assert.ok(fx.evidenceChars>25000);
  assert.ok(fx.user.includes("P18:E09"));
  assert.ok(fx.user.includes("P01:E10"));
  assert.equal(fx.sourceNames.length,18);
  assert.ok(fx.bodyChars>25000);
  assert.ok(fx.expectedRefs.length>=25);
 }
});
test("both route-specific model configurations preserve production output budgets",()=>{
 assert.deepEqual(BENCHMARK_ROUTES,["cloudflare_first","gemini_first"]);
 assert.equal(TARGET_CHARS,6000);
 for(const target of TARGETS_FOR_OFFLINE)assert.ok(outputBudget(target)<=11000);
 assert.ok(runtime.includes("Math.min(11000,"));
 assert.ok(runtime.includes("temperature:0.36"));
 assert.ok(runtime.includes('reasoning_effort:"medium"'));
 assert.ok(runtime.includes('maxOutputTokens:16000'));
 assert.ok(runtime.includes("synthesisResponseSchema(synthesisDossier.blocks)"));
 assert.ok(runtime.includes("readSynthesisBlocks(raw,synthesisDossier.blocks)"));
 assert.ok(runtime.includes("normalizeReviewSourceLabels(parsed.review_text.trim(),cards)"));
 assert.ok(runtime.includes("actualChars>=lengthMinimum"));
 assert.ok(runtime.includes("actualChars<=lengthMaximum"));
});
test("small output and wrong blocks are measured without making up missing prose",()=>{
 const fx=synthesisFixture();
 const text=JSON.stringify({blocks:[{block_id:"opening",paragraphs:[
   "Краткая проверка исходных данных редакции «Северная деловая редакция»."]}],
   section_titles:[],bold_phrases:[]});
 const m=checkReview(text,fx);
 assert.equal(m.json_parsed,true);
 assert.ok(!m.within_tolerance);
 assert.ok(m.blocks_underfilled>0);
 assert.ok(m.block_warnings.length>0);
 assert.ok(m.sources_named>=1);
});
test("one direct API request per provider; no Supabase, no automatic fallback or retries",async()=>{
 const fx=synthesisFixture(),seen=[];
 const mock=async(url,opts)=>{
  const req=JSON.parse(opts.body);
  const gemini=url.includes("generativelanguage");
  const prompt=gemini?req.contents[0].parts[0].text:req.messages.map(x=>x.content).join("\n");
  seen.push({url,gemini,req,prompt});
  const v=JSON.stringify({
    blocks:fx.plan.blocks.map(b=>({block_id:b.id,
      paragraphs:["Обзор вымышленной программы модернизации затрагивает самостоятельные оценки нескольких изданий."]})),
    section_titles:[],bold_phrases:[]
  });
  const response=gemini?
   {candidates:[{finishReason:"STOP",content:{parts:[{text:v}]}}],
      usageMetadata:{promptTokenCount:999,candidatesTokenCount:222}}
   :{success:true,result:{response:v,choices:[{finish_reason:"stop"}],
      usage:{prompt_tokens:999,completion_tokens:222}}};
  return new Response(JSON.stringify(response),{status:200,
    headers:{"content-type":"application/json"}});
 };
 const keys={gemini:"test",cfAccount:"dummy",cfToken:"test"};
 const cf=await callProvider("cloudflare_first",fx,keys,mock,2000);
 const gem=await callProvider("gemini_first",fx,keys,mock,2000);
 assert.deepEqual(seen.map(x=>x.gemini),[false,true]);
 assert.equal(cf.http_status,200);assert.equal(gem.http_status,200);
 assert.equal(cf.json_parsed,true);assert.equal(gem.json_parsed,true);
 assert.equal(cf.output_tokens,222);assert.equal(gem.output_tokens,222);
 assert.equal(seen[0].req.max_tokens,outputBudget(TARGET_CHARS));
 assert.equal(seen[0].req.reasoning_effort,"medium");
 assert.equal(seen[0].req.response_format.type,"json_schema");
 assert.equal(seen[1].req.generationConfig.responseMimeType,"application/json");
 assert.equal(seen[1].req.generationConfig.maxOutputTokens,16000);
 assert.ok(seen.every(x=>x.prompt.includes("SOURCE_REGISTRY")));
 assert.ok(seen.every(x=>x.prompt.includes("РЕДАКЦИОННОЕ ДОСЬЕ")));
 assert.ok(seen.every(x=>x.prompt.includes("STYLE_ONLY")));
 assert.ok(seen.every(x=>x.prompt.includes("P18:E09")));
 assert.ok(!seen.some(x=>/supabase\.co|service_role/i.test(x.url)));
});
test("both success and provider failure persist machine-readable metrics without claiming quality pass",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"w-review-final-"));
 try{
  const rows=await runBenchmark({output:folder,keys:{},
    fetchImpl:()=>{throw Error("network without keys")},delayMs:0});
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(x=>x.error_category),["missing_secret","missing_secret"]);
  const report=readFileSync(join(folder,"report.md"),"utf8");
  const metrics=JSON.parse(readFileSync(join(folder,"metrics.json"),"utf8"));
  assert.equal(metrics.provider_requests,0);
  assert.equal(metrics.evidence_total,167);
  assert.equal(metrics.source_publications,18);
  assert.match(report,/6000/);
  assert.match(report,/Cloudflare/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
