import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const edge=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const ev=edge.slice(edge.indexOf('if (action === "evidence_batch")'),edge.indexOf('if (action === "style_profile")'));
const map=edge.slice(edge.indexOf('if (action === "editorial_map")'),edge.indexOf('if (action === "expand_review")'));
const prep=readFileSync(new URL("./preparation.ts",import.meta.url),"utf8");
const ui=readFileSync(new URL("../../../../src/views/WReviewView.tsx",import.meta.url),"utf8");
const api=readFileSync(new URL("../../../../src/wReviewAi.ts",import.meta.url),"utf8");
test("Evidence routes Gemini 3.5 -> one Cloudflare 120B -> Groq 120B",()=>{
  assert.ok(ev.includes('cloudflareFirst:false'));
  assert.ok(ev.includes('primary:Boolean(geminiApiKey),cloudflare:Boolean(cfEvidenceRoute)'));
  assert.ok(ev.includes('fallback:false,groq:Boolean(groqApiKey)'));
  assert.ok(ev.includes('const model=W_REVIEW_GEMINI_PRIMARY'));
  assert.ok(ev.includes('const model="openai/gpt-oss-120b"'));
  assert.ok(ev.includes('cfEvidenceBackupId!==cfEvidencePrimaryId'));
  assert.ok(ev.includes('cfEvidencePrimaryReady?"primary":cfEvidenceBackupReady?"backup":null'));
  assert.ok(prep.indexOf('attempt("primary"')<prep.indexOf('attempt("cloudflare"'));
  assert.ok(prep.indexOf('attempt("cloudflare"')<prep.indexOf('attempt("groq"'));
  assert.ok(!ev.includes('W_REVIEW_GEMINI_FALLBACK'));
});
test("Dossier prefers Gemini 3.5, one Cloudflare account, then Groq 120B",()=>{
  assert.ok(map.indexOf('if(geminiApiKey&&availableTime()')<map.indexOf('if(!selected&&cfRoute'));
  assert.ok(map.indexOf('if(!selected&&cfRoute')<map.indexOf('if(!selected&&groqApiKey'));
  assert.ok(map.includes('W_REVIEW_GEMINI_PRIMARY'));
  assert.ok(map.includes('model="openai/gpt-oss-120b"'));
  assert.ok(!map.includes('W_REVIEW_GEMINI_FALLBACK'));
  assert.ok(map.includes('requireEveryDistinctSource:true'));
  assert.ok(map.includes('w_review_dossier_shape'));
});
test("Two UI buttons are true independent syntheses, not duplicated actions",()=>{
  assert.ok(ui.includes('onClick={()=>synthesize("cloudflare_first")}'));
  assert.ok(ui.includes('onClick={()=>synthesize("gemini_first")}'));
  assert.ok(ui.includes('activeReviewRoute:route'));
  assert.ok(ui.includes('reviewVariants:{...current.reviewVariants'));
  assert.ok(ui.includes('draft.text.length.toLocaleString()'));
  assert.ok(ui.includes('reviewVariants:current.activeReviewRoute?'));
  assert.ok(api.includes('synthesis_route: input.synthesisRoute'));
});
test("No global Evidence cap of 124 or destructive replay of 18 original documents",()=>{
  assert.ok(!ev.includes('max_cards:124'));
  assert.ok(!ev.includes('limit(124)'));
  assert.ok(ev.includes('max_items:2'));
  assert.ok(ev.includes('formatEvidenceCard(entry.card)'));
});
