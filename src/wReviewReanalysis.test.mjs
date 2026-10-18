import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const view=readFileSync(new URL("./views/WReviewView.tsx",import.meta.url),"utf8");
const reanalysis=view.slice(view.indexOf("  async function analyzePool(forceRequested=false)"),view.indexOf("  async function recalculateTrends()"));
test("Pереанализировать forces fresh two-article Evidence batches",()=>{
  assert.ok(view.includes("function buildBatches(items: WItem[], force=false)"));
  assert.ok(view.includes(".filter(({ item }) => force || !("));
  assert.ok(reanalysis.includes('const force=Boolean(forceRequested && state.items.length>0 &&'));
  assert.ok(reanalysis.includes('prepared===state.items.length);'));
  assert.ok(!reanalysis.includes('mapReady);'));
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
  assert.ok(reanalysis.includes('setState(currentState=>invalidateMap({...currentState,items:[...next],'));
  assert.ok(reanalysis.includes('lastReanalysis:checkpoint.lastReanalysis'));
});
test("checkpoint happens only after all article batches complete and verified Evidence is present",()=>{
  const completed=reanalysis.indexOf("if (done !== next.length)");
  const checkpoint=reanalysis.indexOf("writeEvidenceCheckpoint(");
  assert.ok(completed>=0&&checkpoint>completed);
  assert.ok(reanalysis.includes('const previousBackup=previous.evidenceContract'));
  assert.ok(reanalysis.includes('evidenceAlternative:previousBackup'));
  assert.ok(reanalysis.includes("if (done !== next.length)"));
});
test("map calculation and full reanalysis remain separate without a dossier",()=>{
  assert.ok(view.includes('onClick={()=>allEvidenceReady?recalculateTrends():analyzePool(false)}'));
  assert.ok(view.includes('onClick={()=>analyzePool(true)}'));
  assert.ok(view.includes('allEvidenceReady&&<button className="secondary-button small-button"'));
  assert.ok(view.includes('Рассчитать тенденции'));
  assert.ok(view.includes('Переанализировать пул'));
  assert.ok(view.includes('Две проверенные версии Evidence'));
  assert.ok(view.includes('evidenceAlternative:{evidence:item.evidence'));
  assert.ok(view.includes('Сохранены Evidence:'));
  assert.ok(view.includes('тенденции не рассчитаны'));
});
test("failed explicit reanalysis preserves prior cards and reports failed run separately",()=>{
  assert.ok(reanalysis.includes('if(force&&!evidenceSaved)'));
  assert.ok(reanalysis.includes('status:"failed",processed:processed.size,total:next.length,verifiedRecords:previousAccepted'));
  assert.ok(reanalysis.includes('Прежние проверенные Evidence сохранены'));
  assert.ok(reanalysis.includes('lastReanalysis:checkpoint.lastReanalysis'));
  assert.ok(view.includes('Последний переанализ не завершён'));
  assert.ok(reanalysis.includes('const checkpoint=invalidateMap('));
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
