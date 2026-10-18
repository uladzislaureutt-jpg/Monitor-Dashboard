import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {prepareEvidence} from "./preparation.ts";
import {makeEvidenceDocuments} from "./evidence-v2.ts";
const index=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const preparation=readFileSync(new URL("./preparation.ts",import.meta.url),"utf8");
const dossier=index.slice(index.indexOf('if (action === "editorial_map")'),index.indexOf('if (action === "expand_review")'));
const extraction=index.slice(index.indexOf('if (action === "evidence_batch")'),index.indexOf('if (action === "style_profile")'));
test("Dossier gives Gemini first slot, then bounded CF120 and Groq120 windows",()=>{
  assert.ok(dossier.indexOf('if(geminiApiKey&&availableTime()')<dossier.indexOf('if(!selected&&cfRoute'));
  assert.ok(dossier.indexOf('if(!selected&&cfRoute')<dossier.indexOf('if(!selected&&groqApiKey'));
  assert.ok(dossier.includes('Math.min(42000,availableTime())'));
  assert.ok(dossier.includes('Math.min(46000,availableTime())'));
  assert.ok(dossier.includes('Math.min(34000,availableTime())'));
  assert.ok(dossier.includes('preparationDeadline=Date.now()+130000'));
  assert.ok(dossier.includes('preparationDeadline-Date.now()-7000'));
  assert.ok(dossier.includes('w_review_map_cloudflare_result'));
  assert.ok(dossier.includes('w_review_map_groq_result'));
});
test("Evidence reserves time for Groq 120B and does not spend 75s on CF first",()=>{
  assert.ok(extraction.includes("cloudflareFirst:false"));
  assert.ok(preparation.includes('input.cloudflareFirst?70000:42000'));
  assert.ok(preparation.includes('input.cloudflareFirst?68000:37000'));
  assert.ok(preparation.includes('input.cloudflareFirst?18000:35000'));
  assert.ok(extraction.includes('preparationBudget(attemptDeadline,45000)'));
  assert.ok(extraction.includes('preparationBudget(attemptDeadline,31000)'));
  assert.ok(preparation.includes("elapsed_ms"));
});
test("Cloudflare-first Evidence allows primary >60 seconds without removing fallback",async()=>{
  const docs=makeEvidenceDocuments([{index:0,publication_id:"a",source:"Публикация",title:"Тема",text:"В материале приведены проверяемые данные."}]);
  const calls=[];
  const result=await prepareEvidence({documents:docs,deadline:Date.now()+130000,
    cloudflareFirst:true,available:{primary:true,cloudflare:true,fallback:true,groq:false},
    generate:async(provider,docs,deadline)=>{
      calls.push({provider,remaining:deadline-Date.now()});
      return {model:provider,reply:{ok:false,status:503,retryAfter:null,detail:"simulated"}};
    }
  });
  assert.deepEqual(calls.map(c=>c.provider),["primary","cloudflare","fallback"]);
  assert.ok(calls[0].remaining>60000);
  assert.ok(calls[0].remaining<=68000);
  assert.ok(calls[1].remaining<=112000);
  assert.ok(result.articles.length===0);
});

test("Gemini-first Evidence reaches CF then Groq when no provider yields verified cards",async()=>{
  const docs=makeEvidenceDocuments([{index:0,publication_id:"x",source:"СМИ",title:"Публикация",text:"Данные о публикации."}]);
  const calls=[];
  await prepareEvidence({documents:docs,deadline:Date.now()+130000,
    cloudflareFirst:false,available:{primary:true,cloudflare:true,fallback:false,groq:true},
    generate:async(provider,articles,deadline)=>{
      calls.push({provider,remaining:deadline-Date.now()});
      return {model:provider,reply:{ok:false,status:503,retryAfter:null,detail:"mock"}};
    }
  });
  assert.deepEqual(calls.map(c=>c.provider),["primary","cloudflare","groq"]);
  assert.ok(calls[0].remaining<=42000);
  assert.ok(calls[1].remaining<=48000);
  assert.ok(calls[2].remaining<=31000);
});
