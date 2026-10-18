import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const view=readFileSync(new URL("./views/WReviewView.tsx",import.meta.url),"utf8");
const reanalysis=view.slice(view.indexOf("  async function analyzePool()"),view.indexOf("  async function recalculateTrends()"));
test("Pереанализировать forces fresh two-article Evidence batches",()=>{
  assert.ok(view.includes("function buildBatches(items: WItem[], force=false)"));
  assert.ok(view.includes(".filter(({ item }) => force || !("));
  assert.ok(reanalysis.includes("const force=Boolean(state.items.length>0 && prepared===state.items.length && mapReady)"));
  assert.ok(reanalysis.includes("buildBatches(next,force)"));
});
test("full 18-article Evidence is persisted BEFORE a failure-prone dossier request",()=>{
  assert.ok(reanalysis.includes('writeEvidenceCheckpoint(WORKSPACES_KEY,workspaces,activeSlot,checkpoint,localStorage)'));
  const saved=reanalysis.indexOf('writeEvidenceCheckpoint(');
  const map=reanalysis.indexOf('const mapResult = await wEditorialMap(');
  assert.ok(saved>0&&map>saved);
  assert.ok(reanalysis.includes('evidenceSaved=true'));
  assert.ok(reanalysis.includes('if(evidenceSaved)setMessage('));
  assert.ok(reanalysis.includes('Новые Evidence Cards сохранены. Повторите только расчёт тенденций'));
  assert.ok(reanalysis.includes('setState(currentState=>invalidateMap({...currentState,items:[...next]}))'));
});
test("checkpoint happens only after all article batches complete and verified Evidence is present",()=>{
  const completed=reanalysis.indexOf("if (done !== next.length)");
  const checkpoint=reanalysis.indexOf("writeEvidenceCheckpoint(");
  assert.ok(completed>=0&&checkpoint>completed);
  assert.ok(reanalysis.includes('const previousBackup=previous.evidenceContract'));
  assert.ok(reanalysis.includes('evidenceAlternative:previousBackup'));
  assert.ok(reanalysis.includes("if (done !== next.length)"));
});
test("failed map can retry just map, without another AI Evidence extraction",()=>{
  const button=view.indexOf('onClick={prepared===state.items.length && !mapReady ? recalculateTrends : analyzePool}');
  assert.ok(button>0);
  assert.ok(view.includes('Рассчитать тенденции'));
  assert.ok(view.includes('Две проверенные версии Evidence'));
  assert.ok(view.includes('evidenceAlternative:{evidence:item.evidence'));
});
test("compares prior and new verified coverage and records model choice per batch",()=>{
  assert.ok(reanalysis.includes("previousAccepted="));
  assert.ok(reanalysis.includes("batchesProviders.push(result.model)"));
  assert.ok(reanalysis.includes("processed.add(target.index)"));
  assert.ok(reanalysis.includes("previousAccepted+\" → \"+evidenceAccepted"));
});
test("reanalysis does not download articles or alter source originals",()=>{
  assert.ok(reanalysis.includes("text: item.editorialText"));
  assert.ok(reanalysis.includes("region:item.region"));
  assert.ok(!reanalysis.includes("fetchKnownSourceArticle"));
  assert.ok(!reanalysis.includes("sourceText:"));
});
