import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const code=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const synth=code.slice(code.indexOf('if (action === "synthesize")'));
test("both synthesis routes preserve one-pass generation and commit quota only after finished review",()=>{
  assert.ok(synth.includes('w_review_synthesis_start'));
  assert.ok(synth.includes('w_review_synthesis_route_result'));
  assert.ok(synth.includes('w_review_synthesis_failed'));
  assert.ok(synth.indexOf("w_review_synthesis_start")<synth.indexOf("for(const route of routes)"));
  assert.ok(synth.indexOf("finishQuota(true)")>synth.indexOf("w_review_single_pass"));
  assert.ok(synth.includes("finishQuota(false)"));
  assert.ok(synth.includes('synthesisRoute==="gemini_first"'));
});
test("Gemini-first and Cloudflare-first prioritize configured providers without Groq",()=>{
  assert.ok(synth.includes('["gemini_3_5","cloudflare_primary","cloudflare_backup"]'));
  assert.ok(synth.includes('["cloudflare_primary","cloudflare_backup","gemini_3_5"]'));
  assert.ok(synth.includes('callGemini(geminiApiKey,W_REVIEW_GEMINI_PRIMARY'));
  assert.ok(synth.includes("callCloudflare(isBackup?cfBackupId:cfId"));
  assert.ok(!synth.includes("await callGroq(groqApiKey,groqPayload"));
  assert.ok(synth.includes('model:selectedModel,provider:selectedProvider,cloudflare_route:cloudflareRoute,requested_route:synthesisRoute'));
});
test("each provider is time-bounded below the Edge request limit",()=>{
  assert.ok(synth.includes("deadline=synthesisStart+135000"));
  assert.ok(synth.includes("remaining=()=>Math.max(0,deadline-Date.now()-9000)"));
  assert.ok(synth.includes("if(!configured||budget<10000)continue"));
  assert.ok(synth.includes("callCloudflare(isBackup?cfBackupId:cfId"));
});
test("unhandled errors return sanitized JSON, not a broken CORS connection",()=>{
  assert.ok(code.includes("w_review_unhandled_exception"));
  assert.ok(code.includes("return json({error:\"w_review_internal_error\""));
  assert.ok(code.includes("Access-Control-Allow-Origin"));
});
