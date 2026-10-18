import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {prepareEvidence} from "./preparation.ts";
import {makeEvidenceDocuments} from "./evidence-v2.ts";
const index=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const preparation=readFileSync(new URL("./preparation.ts",import.meta.url),"utf8");
const dossier=index.slice(index.indexOf('if (action === "editorial_map")'),index.indexOf('if (action === "expand_review")'));
const extraction=index.slice(index.indexOf('if (action === "evidence_batch")'),index.indexOf('if (action === "style_profile")'));
test("CF120 dossier timeout is 75 seconds, backup bounded to 32s, Gemini last",()=>{
  assert.match(dossier,/if\(cfPrimaryReady\)await callCfMap\("primary",75000\)/);
  assert.match(dossier,/if\(!selected&&cfBackupReady\)await callCfMap\("backup",32000\)/);
  assert.ok(dossier.indexOf('await callCfMap("primary"')<dossier.indexOf('await callCfMap("backup"'));
  assert.ok(dossier.indexOf('await callCfMap("backup"')<dossier.indexOf('if(!selected&&geminiApiKey'));
  assert.ok(dossier.includes("preparationDeadline=Date.now()+130000"));
  assert.ok(dossier.includes("preparationDeadline-Date.now()-7000"));
  assert.ok(dossier.includes("w_review_map_cloudflare_result"));
});
test("Evidence cap rises from ~35s to ~65s for primary CF, with backup time protected",()=>{
  assert.ok(extraction.includes("cloudflareFirst:true"));
  assert.ok(preparation.includes('input.cloudflareFirst?70000:65000'));
  assert.ok(preparation.includes('input.cloudflareFirst?68000:35000'));
  assert.ok(extraction.includes('backup?43000:70000'));
  assert.ok(preparation.includes('input.deadline-18000'));
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
