import test from "node:test";
import assert from "node:assert/strict";
import {evidenceRouteKey,routesWithoutCircuit,suspendStructuralFailure,circuitExpiry,W_EVIDENCE_CIRCUIT_MINUTES} from "./provider-circuit.ts";
test("structural 400 suspends model; quota, overload and invalid evidence never suspend",()=>{
  assert.equal(suspendStructuralFailure(400,"INVALID_ARGUMENT"),true);
  for(const [code,status] of [[429,"RESOURCE_EXHAUSTED"],[503,"UNAVAILABLE"],[422,"INVALID_ARGUMENT"],[400,"PERMISSION_DENIED"]])
    assert.equal(suspendStructuralFailure(code,status),false);
});
test("one Gemini structural failure is skipped on every later batch",()=>{
  const candidates=["gemini-3.5-flash-lite","gemini-3.1-flash-lite"];
  const disabled=[evidenceRouteKey(candidates[0])];
  assert.deepEqual(routesWithoutCircuit(candidates,disabled),[candidates[1]]);
  assert.deepEqual(routesWithoutCircuit(candidates,[...disabled,evidenceRouteKey(candidates[1])]),[]);
});
test("circuit is scoped only to Evidence, not translation or OCR",()=>{
  assert.equal(evidenceRouteKey("gemini-3.5-flash-lite"),"evidence_batch:gemini-3.5-flash-lite");
  assert.deepEqual(routesWithoutCircuit(["model"],["ocr:model"]),["model"]);
});
test("circuit expires after a bounded fifteen-minute period",()=>{
  const now=new Date("2026-10-18T08:28:00.000Z");
  assert.equal(W_EVIDENCE_CIRCUIT_MINUTES,15);
  assert.equal(circuitExpiry(now),"2026-10-18T08:43:00.000Z");
});
