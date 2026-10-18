import test from "node:test";
import assert from "node:assert/strict";
import {writeEvidenceCheckpoint} from "./wReviewEvidenceCheckpoint.ts";
const store=()=>({activeSlot:1,names:["Тема 1","Тема 2","Тема 3"],
  slots:[{items:[{id:"x"}],editorialMap:{version:3}},
         {items:[{id:"p1",evidence:"OLD",evidenceData:{validation:{accepted:124}}}],editorialMap:{version:3}},
         {items:[{id:"y"}],editorialMap:null}]});
test("persist all verified cards synchronously before an async dossier request",()=>{
  const original=store(),updates=[];
  const storage={setItem:(key,value)=>updates.push([key,JSON.parse(value)])};
  const nextState={...original.slots[1],
    items:[{id:"p1",evidence:"NEW",evidenceData:{validation:{accepted:152}}}],
    editorialMap:null};
  const result=writeEvidenceCheckpoint("wReviewWorkspaces",original,1,nextState,storage);
  assert.equal(updates.length,1);
  assert.equal(updates[0][0],"wReviewWorkspaces");
  assert.equal(updates[0][1].slots[1].items[0].evidence,"NEW");
  assert.equal(updates[0][1].slots[1].editorialMap,null);
  assert.deepEqual(updates[0][1].slots[0],original.slots[0]);
  assert.deepEqual(updates[0][1].slots[2],original.slots[2]);
  assert.deepEqual(result.slots[1],nextState);
  assert.equal(original.slots[1].items[0].evidence,"OLD");
  // A subsequently rejected / timed-out dossier cannot roll back the snapshot.
  assert.equal(updates[0][1].slots[1].items[0].evidenceData.validation.accepted,152);
});
test("a storage quota failure does not mutate in-memory previous workspace",()=>{
  const previous=store();
  assert.throws(()=>writeEvidenceCheckpoint("key",previous,1,
    {items:[],editorialMap:null},{setItem:()=>{throw new Error("QuotaExceededError");}}),
    /QuotaExceededError/);
  assert.equal(previous.slots[1].items[0].evidence,"OLD");
});
test("a workspace switch while processing cannot commit to the wrong slot",()=>{
  const previous=store();
  assert.throws(()=>writeEvidenceCheckpoint("key",previous,0,
    {items:[]},{setItem:()=>assert.fail("must not write")}),
    /workspace_changed/);
});
