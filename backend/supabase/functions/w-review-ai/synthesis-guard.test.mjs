import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const code=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const synth=code.slice(code.indexOf('if (action === "synthesize")'));
test("production synthesis preserves one-pass generation and commit quota only after finished review",()=>{
  assert.ok(synth.includes('w_review_synthesis_start'));
  assert.ok(synth.includes('w_review_synthesis_route_result'));
  assert.ok(synth.includes('w_review_synthesis_failed'));
  assert.ok(synth.indexOf("w_review_synthesis_start")<synth.indexOf("for(const route of routes)"));
  assert.ok(synth.indexOf("finishQuota(true)")>synth.indexOf("w_review_single_pass"));
  assert.ok(synth.includes("finishQuota(false)"));
  assert.ok(synth.includes('const synthesisRoute="gemini_first"'));
});
test("Gemini is always first, Cloudflare primary and backup follow on failure",()=>{
  assert.ok(synth.includes('["gemini_3_5","cloudflare_primary","cloudflare_backup"]'));
  assert.ok(!synth.includes('["cloudflare_primary","cloudflare_backup","gemini_3_5"]'));
  assert.ok(synth.includes('route==="gemini_3_5"?40000:'));
  assert.ok(synth.includes('route==="cloudflare_primary"?70000:25000'));
  assert.ok(synth.includes('callGemini(geminiApiKey,W_REVIEW_GEMINI_PRIMARY'));
  assert.ok(synth.includes("callCloudflare(isBackup?cfBackupId:cfId"));
  assert.ok(!synth.includes("await callGroq(groqApiKey,groqPayload"));
  assert.ok(synth.includes('model:selectedModel,provider:selectedProvider,cloudflare_route:cloudflareRoute,requested_route:synthesisRoute'));
});
test("each provider is time-bounded below the Edge request limit",()=>{
  assert.ok(synth.includes("deadline=synthesisStart+W_REVIEW_REQUEST_BUDGET_MS"));
  assert.ok(synth.includes("remaining=()=>Math.max(0,deadline-Date.now()-9000)"));
  assert.ok(synth.includes("if(!configured||budget<10000)continue"));
  assert.ok(synth.includes("callCloudflare(isBackup?cfBackupId:cfId"));
});
test("unhandled errors return sanitized JSON, not a broken CORS connection",()=>{
  assert.ok(code.includes("w_review_unhandled_exception"));
  assert.ok(code.includes("return json({error:\"w_review_internal_error\""));
  assert.ok(code.includes("Access-Control-Allow-Origin"));
});

test("Cloudflare final synthesis uses proven simple JSON mode without changing checked 8000-char target",()=>{
 const cloudflare=synth.slice(synth.indexOf('const cloudflareSynthesisPayload = {'),
   synth.indexOf('const topicKeyRaw'));
 assert.ok(cloudflare.includes('response_format:{type:"json_object"}'));
 assert.ok(cloudflare.includes('...groqPayload'));
 assert.ok(cloudflare.includes('reasoning_effort:"medium"'));
 assert.ok(cloudflare.includes('max_tokens:synthesisOutputTokenBudget'));
 const strictGroq=synth.slice(synth.indexOf('const groqPayload = {'),
   synth.indexOf('const estimatedVisibleTokens'));
 assert.ok(strictGroq.includes('response_format:payload.response_format'));
 assert.ok(synth.includes('synthesisResponseSchema(synthesisDossier.blocks)'),
   "the schema remains in Gemini/Groq and regression validation");
 assert.ok(synth.includes("readSynthesisBlocks(raw,synthesisDossier.blocks)"));
 assert.ok(synth.includes("normalizeReviewSourceLabels(parsed.review_text.trim(),cards)"));
 assert.ok(synth.includes('const lengthMinimum=Math.round(targetChars*0.95)'));
 assert.ok(synth.includes('const lengthMaximum=Math.round(targetChars*1.05)'));
 assert.ok(synth.includes("lengthOk=actualChars>=lengthMinimum"));
 assert.ok(synth.includes("&& actualChars<=lengthMaximum"));
 assert.ok(synth.includes('cloudflare_response_format:cloudflareSynthesisPayload.response_format.type'));
 // Operator target 8000, internal model plan 9360 (+17%).
 // The output budget is a ceiling, not a promised result length.
 const target=8000;
 const planning=Math.round(target*1.17);
 const visible=Math.ceil(planning/1.25);
 const reasoning=Math.max(1000,Math.min(3000,Math.ceil(visible*0.4)));
 const cap=Math.min(11000,Math.max(1500,Math.ceil((visible+reasoning+450)/500)*500));
 assert.equal(cap,11000);
});

test("all five operator presets use 17% higher model plan without changing acceptance limits",()=>{
 assert.ok(synth.includes("const planningTargetChars = Math.round(targetChars * 1.17)"));
 assert.ok(synth.includes("selectedIds,planningTargetChars,cards,measuredMedian"));
 assert.ok(synth.includes("Внутренний ориентир модели — ${planningTargetChars}"));
 assert.ok(synth.includes("const estimatedVisibleTokens=Math.ceil(planningTargetChars/1.25)"));
 assert.ok(synth.includes("model_target_chars:planningTargetChars"));
 assert.ok(synth.includes("const lengthMinimum=Math.round(targetChars*0.95)"));
 assert.ok(synth.includes("const lengthMaximum=Math.round(targetChars*1.05)"));
 assert.deepEqual([3000,4000,5000,6000,8000].map(n=>Math.round(n*1.17)),
   [3510,4680,5850,7020,9360]);
});

test("author style prioritizes confirmed comparisons and no rhetorical inventions",()=>{
 assert.ok(synth.includes("СТИЛЕВОЙ ПРИОРИТЕТ W-REVIEW"));
 assert.ok(synth.includes("ЗАПРЕТ ПУСТОЙ РИТОРИКИ"));
 assert.ok(synth.includes("тектонический сдвиг"));
 assert.ok(synth.includes("КАНОНИЧЕСКОЕ НАПИСАНИЕ"));
 assert.ok(synth.includes("«CFR.org»"));
});
