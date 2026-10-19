import test from "node:test";
import assert from "node:assert/strict";
import {fixtureSets,benchmarkSchema,requestBody,runExperiment,MODEL,VARIANTS} from "./schema-benchmark.mjs";

test("A/B/C preserve the same source prompt and model settings; only schema differs",()=>{
  const fixtures=fixtureSets();
  assert.equal(fixtures.length,2);
  for(const f of fixtures){
    assert.equal(f.docs.length,2);
    const [a,b,c]=VARIANTS.map(variant=>requestBody(variant,f.docs));
    assert.deepEqual(a.contents,b.contents);
    assert.deepEqual(b.contents,c.contents);
    assert.equal(a.generationConfig.responseMimeType,"application/json");
    assert.equal(b.generationConfig.responseMimeType,"application/json");
    assert.equal(c.generationConfig.responseMimeType,"application/json");
    assert.equal(a.generationConfig.responseJsonSchema,undefined);
    assert.ok(b.generationConfig.responseJsonSchema);
    assert.ok(c.generationConfig.responseJsonSchema);
    for(const request of [a,b,c]){
      assert.equal(request.generationConfig.maxOutputTokens,16000);
      assert.deepEqual(request.generationConfig.thinkingConfig,{thinkingLevel:"low"});
    }
    assert.ok(f.docs.every(d=>d.passages.length>=4));
  }
  assert.equal(MODEL,"gemini-3.5-flash-lite");
});

test("B uses simple required types; C adds enum, descriptions and count constraints",()=>{
  const b=benchmarkSchema("B_minimal");
  const c=benchmarkSchema("C_extended",2);
  assert.equal(b.properties.cards.minItems,undefined);
  assert.equal(b.additionalProperties,undefined);
  const cardB=b.properties.cards.items;
  assert.deepEqual(cardB.required,["index","title_ru","records"]);
  assert.equal(cardB.properties.records.items.properties.kind.type,"string");
  assert.equal(c.additionalProperties,false);
  assert.equal(c.properties.cards.minItems,2);
  assert.equal(c.properties.cards.maxItems,2);
  const recordC=c.properties.cards.items.properties.records.items;
  assert.equal(recordC.properties.kind.enum.length,10);
  assert.equal(recordC.additionalProperties,false);
  assert.equal(recordC.properties.source_excerpt.type,"string");
});

test("12 offline fake requests collect metrics and source-verify synthetic Evidence without any network",async()=>{
  const docs=fixtureSets(), requests=[];
  const mockFetch=async(_url,args)=>{
    assert.ok(_url.includes(MODEL));
    assert.equal(args.headers["x-goog-api-key"],"test-dummy-key");
    const request=JSON.parse(args.body);
    requests.push(request);
    const original=docs.find(x=>x.docs[0].source===request.contents[0].parts[0].text.split("\n").find(y=>y.startsWith("ИЗДАНИЕ: "))?.slice(9));
    // A deterministic mock response: one strictly anchored record for each article.
    // A sparse card should be diagnosed as insufficient, never falsely certified.
    const cards=[{index:0,title_ru:"Тестовая публикация",
      records:[{kind:"fact",statement_ru:"В тестовой публикации приведены конкретные сведения.",
        anchor_id:"P001",source_excerpt:"Несуществующий источник",original_quote:"",
        quote_ru:"",speaker:"",role:""}]}];
    const payload={candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({cards})}]}}],
      usageMetadata:{promptTokenCount:120,candidatesTokenCount:80}};
    return new Response(JSON.stringify(payload),{status:200,headers:{"content-type":"application/json"}});
  };
  const root=(await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(),"w-schema-"));
  const result=await runExperiment({key:"test-dummy-key",repeats:2,delayMs:0,
    output:root,fetchImpl:mockFetch});
  assert.equal(result.requests,12);
  assert.equal(requests.length,12);
  assert.deepEqual(result.summary.map(s=>s.runs),[4,4,4]);
  assert.deepEqual(result.summary.map(s=>s.http_200),[4,4,4]);
  assert.deepEqual(result.summary.map(s=>s.accepted_records),[0,0,0]);
  assert.ok((await import("node:fs")).existsSync(root+"/report.md"));
  assert.ok((await import("node:fs")).existsSync(root+"/metrics.json"));
  (await import("node:fs")).rmSync(root,{recursive:true,force:true});
});

test("no API key means experiment cannot quietly claim live verification",async()=>{
  await assert.rejects(runExperiment({key:""}),/GEMINI_API_KEY_IS_REQUIRED/);
});
