import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const view=readFileSync(new URL("./views/WReviewView.tsx",import.meta.url),"utf8");
const analysis=view.slice(view.indexOf("  async function analyzePool(forceRequested=false)"),view.indexOf("  async function recalculateTrends()"));
const dossier=view.slice(view.indexOf("  async function recalculateTrends()"),view.indexOf("  function clearPool()"));
const batches=view.slice(view.indexOf("  function buildBatches(items: WItem[])"),view.indexOf("  async function analyzePool("));

test("normal run and post-interruption resume select pending publications only",()=>{
  assert.ok(batches.includes("pendingEvidenceEntries(items,W_EVIDENCE_CONTRACT_VERSION)"));
  assert.ok(!batches.includes("force ||"));
  assert.ok(analysis.includes("const batches=buildBatches(next)"));
  assert.ok(analysis.includes("pool_index:index+1"));
  assert.ok(view.includes("BATCH_MAX_ITEMS = 2"));
  assert.ok(analysis.includes("const target=batch[card.index]"));
});

test("checkpoint every accepted batch before proceeding to the next AI batch",()=>{
  const loop=analysis.slice(analysis.indexOf("      for(const batch of batches){"),analysis.indexOf("      const ready=countReady();\n      if(ready!==next.length)"));
  assert.ok(loop.includes("await wEvidenceBatch("));
  assert.ok(loop.includes("if(acceptedInBatch){"));
  assert.ok(loop.includes('checkpoint(countReady()===next.length?"saved":"partial")'));
  assert.ok(analysis.includes("checkpointStore=writeEvidenceCheckpoint("));
  assert.ok(analysis.includes("setWorkspaces(checkpointStore)"));
  assert.ok(analysis.includes("const ready=checkpointStore.slots[activeSlot].items.filter(isReady).length"));
  assert.ok(!analysis.includes("wEditorialMap("));
  assert.ok(dossier.includes("wEditorialMap("));
});

test("partial progress remains in pool and user can continue instead of restarting",()=>{
  assert.ok(view.includes('prepared>0'));
  assert.ok(view.includes("Продолжить анализ (осталось "));
  assert.ok(view.includes("remainingArticles=state.items.length-prepared"));
  assert.ok(analysis.includes("savedThisRun+=acceptedInBatch"));
  assert.ok(analysis.includes("Сохранено "));
  assert.ok(analysis.includes("Нажмите «Продолжить анализ»"));
  assert.ok(view.includes("onClick={()=>allEvidenceReady?recalculateTrends():analyzePool(false)}"));
});

test("rare full reanalysis clears old cards at its start and accumulates only new cards",()=>{
  assert.ok(analysis.includes('const force=Boolean(forceRequested'));
  assert.ok(analysis.includes('next=next.map(item=>({...item,evidence:"",evidenceData:undefined,evidenceContract:0}))'));
  const reset=analysis.indexOf('checkpoint("partial")');
  const call=analysis.indexOf('await wEvidenceBatch(');
  assert.ok(reset>=0&&reset<call);
  assert.ok(view.includes('window.confirm('));
  assert.ok(view.includes('onClick={()=>{if(window.confirm('));
  assert.ok(analysis.includes("next[target.index]={...next[target.index],"));
  assert.ok(!analysis.includes("evidenceRegression"));
  assert.ok(!analysis.includes("evidenceAlternative"));
});

test("all cards must finish before model calculations for editorial trends are enabled",()=>{
  assert.ok(view.includes("prepared===state.items.length"));
  assert.ok(dossier.includes("prepared !== state.items.length) return"));
  assert.ok(!analysis.includes("wEditorialMap("));
  assert.ok(view.includes('Рассчитать тенденции'));
});

test("source edits and card removal cannot race with in-flight Evidence checkpoints",()=>{
  assert.ok(view.includes('if(busy==="analyze")return; // Freeze source edits'));
  assert.ok(view.includes('disabled={busy==="analyze"} value={state.topic}'));
  assert.ok(view.includes('disabled={busy==="analyze"} value={value}'));
  assert.ok(view.includes('disabled={busy==="analyze"} value={state.exclusions}'));
  assert.ok(view.includes('w-review-edit-input" lang={be?"be":"ru"} spellCheck={true} disabled={busy==="analyze"}'));
  assert.ok(analysis.includes("text:item.editorialText"));
  assert.ok(!analysis.includes("fetchKnownSourceArticle"));
});

test("legacy alternative Evidence are purged on loading; single current model remains",()=>{
  assert.ok(view.includes("const {evidenceAlternative: _legacyAlternative,...current}=item"));
  assert.ok(!view.includes("evidenceRegression"));
  assert.ok(view.includes("evidenceModelLabel(item.evidenceData?.model)"));
});
