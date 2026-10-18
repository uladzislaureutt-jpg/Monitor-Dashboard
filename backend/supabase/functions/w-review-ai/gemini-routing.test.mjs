import test from "node:test";
import assert from "node:assert/strict";
import {W_REVIEW_GEMINI_PRIMARY,W_REVIEW_GEMINI_FALLBACK,W_REVIEW_GEMINI_ROUTES,wGeminiGenerationConfig} from "./gemini-routing.ts";
test("Evidence starts on 3.5 Flash-Lite and never routes to 3.6",()=>{
  assert.equal(W_REVIEW_GEMINI_PRIMARY,"gemini-3.5-flash-lite");
  assert.equal(W_REVIEW_GEMINI_FALLBACK,"gemini-3.1-flash-lite");
  assert.deepEqual([...W_REVIEW_GEMINI_ROUTES],["gemini-3.5-flash-lite","gemini-3.1-flash-lite"]);
  assert.ok(!W_REVIEW_GEMINI_ROUTES.some(model=>model.includes("3.6")));
  assert.ok(!W_REVIEW_GEMINI_ROUTES.some(model=>model==="gemini-3.5-flash")); // Alias now goes to 3.6.
});
test("GenerateContent removes deprecated sampling parameters without losing structured JSON",()=>{
  const schema={type:"OBJECT",properties:{cards:{type:"ARRAY",items:{type:"STRING"}}},required:["cards"]};
  const result=wGeminiGenerationConfig(schema,{maxOutputTokens:8192,thinkingLevel:"minimal"});
  assert.equal(result.responseMimeType,"application/json");
  assert.equal(result.responseSchema,schema);
  assert.equal(result.maxOutputTokens,8192);
  assert.equal(result.thinkingConfig.thinkingLevel,"minimal");
  for(const key of ["temperature","topP","topK","top_p","top_k","candidateCount"])assert.ok(!(key in result));
});
test("default Gemini JSON payload contains no obsolete options",()=>{
  const value=wGeminiGenerationConfig({type:"STRING"});
  assert.deepEqual(value,{responseMimeType:"application/json",responseSchema:{type:"STRING"}});
});
