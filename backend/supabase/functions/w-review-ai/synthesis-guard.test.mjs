import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const code=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const synth=code.slice(code.indexOf('if (action === "synthesize")'));
test("final synthesis never references removed paragraphMinChars",()=>{
  assert.ok(synth.includes("paragraphFloor"));
  assert.ok(synth.includes("paragraphCeiling"));
  assert.ok(!synth.includes("paragraphMinChars"));
  assert.match(synth,/paragraph_floor:paragraphFloor,paragraph_ceiling:paragraphCeiling/);
});
test("final route logs start and primary result before response and counts quota only on success",()=>{
  assert.ok(synth.includes('w_review_synthesis_start'));
  assert.ok(synth.includes('w_review_synthesis_primary_result'));
  assert.ok(synth.includes('w_review_synthesis_failed'));
  assert.ok(synth.indexOf("w_review_synthesis_start")<synth.indexOf("await callCloudflare(cfId,cfToken,cloudflareSynthesisPayload,firstBudget)"));
  assert.ok(synth.indexOf("finishQuota(true)")>synth.indexOf("w_review_single_pass"));
  assert.ok(synth.includes("finishQuota(false)"));
});
test("sequential provider calls use bounded timeouts beneath Supabase Edge 150 seconds",()=>{
  assert.ok(synth.includes("deadline=synthesisStart+135000"));
  assert.match(synth,/providerBudget\(112000\)/);
  assert.match(synth,/callCloudflare\(cfBackupId,cfBackupToken,cloudflareSynthesisPayload,providerBudget\(85000\)\)/);
  assert.match(synth,/callGroq\(groqApiKey,groqPayload,providerBudget\(35000\)\)/);
  assert.ok(!synth.includes("callCloudflare(cfId,cfToken,cloudflareSynthesisPayload)"));
  assert.ok(!synth.includes("callCloudflare(cfBackupId,cfBackupToken,cloudflareSynthesisPayload)"));
  assert.ok(!synth.includes("callGroq(groqApiKey,groqPayload)"));
});
test("unhandled errors return sanitized JSON, not a broken CORS connection",()=>{
  assert.ok(code.includes("w_review_unhandled_exception"));
  assert.ok(code.includes("return json({error:\"w_review_internal_error\""));
  assert.ok(code.includes("Access-Control-Allow-Origin"));
});
