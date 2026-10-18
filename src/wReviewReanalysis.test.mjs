import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const view=readFileSync(new URL("./views/WReviewView.tsx",import.meta.url),"utf8");
const reanalysis=view.slice(view.indexOf("  async function analyzePool()"),view.indexOf("  async function recalculateTrends()"));
test("Pереанализировать forces fresh two-article Evidence batches",()=>{
  assert.ok(view.includes("function buildBatches(items: WItem[], force=false)"));
  assert.ok(view.includes(".filter(({ item }) => force || !("));
  assert.ok(reanalysis.includes("const force=Boolean(state.items.length>0 && prepared===state.items.length)"));
  assert.ok(reanalysis.includes("buildBatches(next,force)"));
});
test("old workspace survives a failed full reanalysis and is committed only with completed new map",()=>{
  assert.ok(reanalysis.includes("if(!force) setState((currentState) => invalidateMap("));
  assert.ok(reanalysis.includes("if (done !== next.length)"));
  const boundary=reanalysis.indexOf("const mapResult = await wEditorialMap(");
  assert.ok(boundary>0);
  const before=reanalysis.slice(0,boundary);
  assert.ok(!before.includes("if(force) setState("));
  assert.ok(reanalysis.slice(boundary).includes("editorialMap: mapResult.editorialMap"));
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
