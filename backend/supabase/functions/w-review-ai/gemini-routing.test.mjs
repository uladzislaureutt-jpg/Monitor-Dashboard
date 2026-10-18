import test from "node:test";
import assert from "node:assert/strict";
import {W_REVIEW_GEMINI_PRIMARY,W_REVIEW_GEMINI_FALLBACK,W_REVIEW_GEMINI_ROUTES,wGeminiGenerationConfig,normalizeGeminiJsonSchema,wGeminiPromptJsonConfig,parseModelJsonObject,W_GEMINI_JSON_ONLY_SUFFIX} from "./gemini-routing.ts";
import {evidenceV2Schema} from "./evidence-v2.ts";
import {dossierSchema} from "./editorial-dossier.ts";
test("Gemini Evidence uses 3.5 Flash-Lite first and never 3.6",()=>{
  assert.deepEqual([...W_REVIEW_GEMINI_ROUTES],["gemini-3.5-flash-lite","gemini-3.1-flash-lite"]);
  assert.equal(W_REVIEW_GEMINI_PRIMARY,"gemini-3.5-flash-lite");
  assert.equal(W_REVIEW_GEMINI_FALLBACK,"gemini-3.1-flash-lite");
});
test("GenerateContent uses modern responseFormat, NOT deprecated responseSchema",()=>{
  const schema={type:"OBJECT",properties:{cards:{type:"ARRAY",items:{type:"STRING"}}},required:["cards"]};
  const config=wGeminiGenerationConfig(schema,{maxOutputTokens:8192,thinkingLevel:"low"});
  assert.deepEqual(config.responseFormat,{text:{mimeType:"APPLICATION_JSON",schema:{
    type:"object",properties:{cards:{type:"array",items:{type:"string"}}},required:["cards"]}}});
  assert.equal(config.maxOutputTokens,8192);
  assert.equal(config.thinkingConfig.thinkingLevel,"low");
  for(const name of ["responseMimeType","responseSchema","responseJsonSchema","temperature","topP","topK"])
    assert.ok(!(name in config),name);
});
test("real Evidence v2 schema recursively converts all OpenAPI types",()=>{
  const input=evidenceV2Schema(2);
  const schema=wGeminiGenerationConfig(input).responseFormat.text.schema;
  const fields=schema.properties.cards.items.properties;
  assert.equal(schema.type,"object");
  assert.equal(schema.properties.cards.type,"array");
  assert.equal(schema.properties.cards.minItems,2);
  assert.equal(fields.records.items.properties.anchor_id.type,"string");
  assert.equal(fields.index.type,"integer");
  assert.ok(fields.records.items.required.includes("source_excerpt"));
  assert.equal(input.type,"OBJECT"); // Do not mutate provider-neutral schema.
});
test("dossier boolean fields and nested arrays use JSON Schema type names",()=>{
  const schema=normalizeGeminiJsonSchema(dossierSchema(18));
  const b=schema.properties.trends.items.properties.branches.items.properties;
  assert.equal(b.required.type,"boolean");
  assert.equal(b.evidence_ids.items.type,"string");
  assert.equal(schema.properties.coverage.minItems,18);
  assert.equal(schema.type,"object");
});
test("normalization retains enum values, descriptions and property names",()=>{
  const normalized=normalizeGeminiJsonSchema({type:"OBJECT",properties:{
    TYPE:{type:"STRING",enum:["OBJECT","ARRAY"],description:"TYPE of media"},
    optional:{type:["STRING","NULL"]}}});
  assert.deepEqual(normalized.properties.TYPE.enum,["OBJECT","ARRAY"]);
  assert.deepEqual(normalized.properties.optional.type,["string","null"]);
  assert.equal(normalized.properties.TYPE.description,"TYPE of media");
});

test("Gemini prompt-JSON fallback omits ALL structured response schema fields",()=>{
  const config=wGeminiPromptJsonConfig({maxOutputTokens:16384});
  assert.deepEqual(config,{maxOutputTokens:16384});
  for(const field of ["responseFormat","responseSchema","responseMimeType","responseJsonSchema","temperature"])
    assert.ok(!(field in config),"must omit "+field);
  assert.ok(W_GEMINI_JSON_ONLY_SUFFIX.includes("JSON"));
});
test("prompt JSON fallback tolerates fenced JSON but never treats prose as verified evidence",()=>{
  assert.deepEqual(parseModelJsonObject('{"trends":[{"id":"T1"}]}'),{trends:[{id:"T1"}]});
  const fence=String.fromCharCode(96).repeat(3);
  assert.deepEqual(parseModelJsonObject(fence+"json\n"+'{"cards":[]}'+"\n"+fence),{cards:[]});
  assert.equal(parseModelJsonObject("Ответ без JSON"),null);
  assert.equal(parseModelJsonObject('[{"index":0}]'),null);
  assert.equal(parseModelJsonObject('{"trends":'),null);
});

test("Gemini complete JSON object is recovered when surrounded by short markdown preface",()=>{
  const json='{"cards":[{"index":0,"title_ru":"Аналитический обзор","records":[]}]}';
  const examples=[
    json,"\uFEFF"+json,
    "\x60\x60\x60json\n"+json+"\n\x60\x60\x60",
    "Результат JSON:\n"+json+"\nВсё готово.",
    "Here is the output:\n\x60\x60\x60json\n"+json+"\n\x60\x60\x60"
  ];
  for(const reply of examples){
    const parsed=parseModelJsonObject(reply);
    assert.ok(Array.isArray(parsed?.cards));
    assert.equal(parsed.cards[0].index,0);
  }
});
test("Gemini parser never pretends a truncated response is valid JSON",()=>{
  for(const reply of ['{"cards":[{"index":0}',"There was an error", "[]", "{not json}",
    "Output: { \"cards\": [\"bad\" ]"]){
    assert.equal(parseModelJsonObject(reply),null);
  }
});
test("Gemini parser handles braces inside quoted source material without truncation",()=>{
  const sample='{"cards":[{"statement_ru":"Цитата со скобками { и } и кавычками \\"да\\"","records":[]}]}';
  assert.equal(parseModelJsonObject("JSON:\n"+sample+"\n--",)?.cards[0].records.length,0);
});
