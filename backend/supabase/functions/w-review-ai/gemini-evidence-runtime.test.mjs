import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const index=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const start=index.indexOf('if (action === "evidence_batch")');
const end=index.indexOf('if (action === "style_profile")',start);
const evidence=index.slice(start,end);
test("Gemini Evidence excludes model-thought parts when parsing final JSON",()=>{
  assert.ok(index.includes(".filter((part:any)=>part?.thought!==true)"));
  assert.ok(index.includes('const content = Array.isArray(parts)'));
});
test("Gemini 3.5 still has first attempt; its unparseable response never triggers duplicate call",()=>{
  assert.ok(evidence.includes('for (const model of models)'));
  assert.ok(evidence.includes('maxOutputTokens:12000,thinkingLevel:"minimal"'));
  assert.ok(evidence.includes('if(!data||!Array.isArray(data.cards))'));
  const shape=evidence.indexOf("w_review_gemini_evidence_shape");
  assert.ok(shape>0);
  assert.ok(evidence.slice(shape,shape+700).includes("break;"));
  assert.ok(evidence.includes('const verified=verifyEvidenceCards(data,documents)'));
});
test("shape logs report only numeric provider fields, never source materials",()=>{
  const begin=evidence.indexOf('console.warn("w_review_gemini_evidence_shape "');
  const end=evidence.indexOf('lastError=model+',begin);
  const diagnostic=evidence.slice(begin,end);
  for(const key of ["model","finish_reason","response_chars","completion_tokens","reasoning_tokens","requested_max_tokens"])
    assert.ok(diagnostic.includes(key),key);
  assert.ok(!diagnostic.includes("candidate.content,"));
  assert.ok(!diagnostic.includes("normalized"));
  assert.ok(!diagnostic.includes("prompt"));
});
test("fallback and evidence verification still required on every model",()=>{
  assert.ok(evidence.includes("verifyEvidenceCards(data,documents)"));
  assert.ok(evidence.includes("if ((!result || !parsed) && cfEvidenceId && cfEvidenceToken)"));
  assert.ok(evidence.includes("if ((!result || !parsed) && groqApiKey)"));
});
