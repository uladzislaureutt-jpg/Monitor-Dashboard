import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const view=readFileSync(new URL("./views/WReviewView.tsx",import.meta.url),"utf8");
const analysis=view.slice(view.indexOf("  async function analyzePool(forceRequested=false)"),view.indexOf("  async function recalculateTrends()"));
const dossier=view.slice(view.indexOf("  async function recalculateTrends()"),view.indexOf("  function clearPool()"));

test("analysis handles all articles in arrival order, batches of at most two",()=>{
  assert.ok(view.includes("BATCH_MAX_ITEMS = 2"));
  assert.ok(view.includes("const pending = items.map((item, index) => ({ item, index }))"));
  assert.ok(view.includes(".filter(({ item }) => force || !("));
  assert.ok(analysis.includes("const batches = buildBatches(next,force)"));
  assert.ok(analysis.includes("pool_index:index+1"));
  assert.ok(!analysis.includes(".sort(() =>"));
  assert.ok(!analysis.includes(".reverse()"));
});

test("Evidence analysis stops after a complete durable checkpoint, without running editorial map",()=>{
  const done=analysis.indexOf("if (done !== next.length)");
  const saved=analysis.indexOf("writeEvidenceCheckpoint(");
  assert.ok(done>=0&&saved>done);
  assert.ok(analysis.includes("evidenceSaved=true"));
  assert.ok(!analysis.includes("wEditorialMap("));
  assert.ok(dossier.includes("wEditorialMap("));
  assert.ok(view.includes('onClick={()=>allEvidenceReady?recalculateTrends():analyzePool(false)}'));
  assert.ok(view.includes('onClick={()=>analyzePool(true)}'));
  assert.ok(analysis.includes("Теперь отдельно нажмите «Рассчитать тенденции»"));
});

test("fresh verified Evidence always replaces old cards; no previous-vs-new comparison",()=>{
  assert.ok(analysis.includes("next[target.index]={...previous,evidence:card.evidence,"));
  assert.ok(analysis.includes("evidenceData:card.evidenceData,evidenceContract:W_EVIDENCE_CONTRACT_VERSION"));
  assert.ok(!view.includes("evidenceRegression"));
  assert.ok(!analysis.includes("previousBackup"));
  assert.ok(!analysis.includes("preserved"));
  assert.ok(!view.includes('evidenceAlternative?"'));
  assert.ok(view.includes("const {evidenceAlternative: _legacyAlternative,...current}=item"));
});

test("failed reanalysis never commits partial replacements or rolls back valid stored pool",()=>{
  assert.ok(analysis.includes("if(force&&!evidenceSaved)"));
  assert.ok(analysis.includes('status:"failed",processed:processed.size,total:next.length,verifiedRecords:previousAccepted'));
  assert.ok(analysis.includes("Прежние проверенные Evidence сохранены"));
  assert.ok(analysis.includes("if(!force) setState("));
  assert.ok(analysis.includes("lastReanalysis:checkpoint.lastReanalysis"));
});

test("pool reanalysis does not redownload original articles or alter their source text",()=>{
  assert.ok(analysis.includes("text: item.editorialText"));
  assert.ok(analysis.includes("region:item.region"));
  assert.ok(!analysis.includes("fetchKnownSourceArticle"));
  assert.ok(!analysis.includes("sourceText:"));
});

test("the UI surfaces true pool-sized reanalysis and independent trends action",()=>{
  assert.ok(view.includes("`Переанализировать пул (${state.items.length} публикаций)`"));
  assert.ok(view.includes("Рассчитать тенденции"));
  assert.ok(view.includes("Сохранены Evidence:"));
  assert.ok(view.includes("Последний переанализ не завершён"));
});
