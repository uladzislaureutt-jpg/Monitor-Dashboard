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

test("Evidence Gemini starts in compatible JSON format without two known-invalid schema calls",()=>{
  assert.ok(evidence.includes('initialMode:"json"'));
  assert.ok(evidence.includes('jsonMode,maxOutputTokens:16000'));
  assert.ok(!evidence.includes('initialMode:"schema"'));
});
test("Evidence telemetry identifies absolute pool order and each response quality without recording text",()=>{
  const preparation=readFileSync(new URL("./preparation.ts",import.meta.url),"utf8");
  const api=readFileSync(new URL("../../../../src/views/WReviewView.tsx",import.meta.url),"utf8");
  assert.ok(evidence.includes("poolIndices:normalized.map(x=>x.pool_index)"));
  assert.ok(evidence.includes("source_chars:normalized.map(x=>x.text.length)"));
  assert.ok(evidence.includes("pool_index:normalized[c.index].pool_index"));
  assert.ok(preparation.includes("pool_indices"));
  assert.ok(preparation.includes("elapsed_ms:Date.now()-started"));
  assert.ok(preparation.includes("covered_passages:e.card.validation.covered_passages"));
  assert.ok(api.includes("pool_index:index+1"));
});
