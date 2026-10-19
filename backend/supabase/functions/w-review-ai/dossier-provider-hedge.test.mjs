import test from "node:test";
import assert from "node:assert/strict";
import {scheduleHedgedBackup,groqDossierBudget} from "./dossier-provider-hedge.ts";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test("Cloudflare completes before hedge: do not make an unnecessary Gemini request",async()=>{
 let started=0;
 const h=scheduleHedgedBackup(async()=>{started++;return "gemini";},30);
 await sleep(4);
 h.cancel();
 await sleep(38);
 assert.equal(started,0);
 assert.equal(h.started(),false);
});
test("Slow Cloudflare starts Gemini once and reuses in-flight result",async()=>{
 let started=0;
 const h=scheduleHedgedBackup(async()=>{started++;await sleep(15);return "verified map";},3);
 await sleep(7);
 assert.equal(h.started(),true);
 const [a,b]=await Promise.all([h.waitOrStart(),h.waitOrStart()]);
 assert.equal(a,"verified map");
 assert.equal(b,"verified map");
 assert.equal(started,1);
});
test("Failed fast Cloudflare starts Gemini immediately, without waiting the hedge window",async()=>{
 const h=scheduleHedgedBackup(async()=>5,9999);
 const value=await h.waitOrStart();
 assert.equal(value,5);
 assert.equal(h.started(),true);
 h.cancel();
});
test("Groq Free budget preflight rejects oversized 18-publication dossier, allows short ones",()=>{
 const large=groqDossierBudget([{role:"user",content:"Контроль источников. ".repeat(2600)}]);
 assert.equal(large.eligible,false);
 assert.equal(large.maxCompletionTokens,0);
 const small=groqDossierBudget([{role:"user",content:"Проанализируй два СМИ."}]);
 assert.equal(small.eligible,true);
 assert.ok(small.maxCompletionTokens>=1300&&small.maxCompletionTokens<=3300);
 assert.ok(small.estimatedInputTokens>0);
});
test("Budget output allowance decreases monotonically with increasing input",()=>{
 const xs=[100,2500,7000,13000,18000].map(n=>
   groqDossierBudget([{role:"user",content:"а".repeat(n)}]));
 for(let i=1;i<xs.length;i++)assert.ok(xs[i].maxCompletionTokens<=xs[i-1].maxCompletionTokens);
});
