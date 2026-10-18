import test from "node:test";
import assert from "node:assert/strict";
import {writeEvidenceCheckpoint} from "./wReviewEvidenceCheckpoint.ts";
import {isEvidencePrepared,pendingEvidenceEntries} from "./wReviewEvidenceProgress.ts";

const CONTRACT=6;
const draft=(index)=>({id:"P"+index,editorialText:"Source "+index,evidence:"",evidenceData:undefined,evidenceContract:0});
const verified=(item,model="gemini-3.5-flash-lite")=>({...item,
  evidence:"Verified "+item.id,evidenceData:{model,validation:{accepted:7}},
  evidenceContract:CONTRACT});
const store=()=>({activeSlot:1,names:["Тема 1","Тема 2","Тема 3"],
  slots:[{items:[{id:"x"}],editorialMap:{version:3}},
         {items:Array.from({length:18},(_,i)=>draft(i+1)),editorialMap:null},
         {items:[{id:"y"}]}]});
const storage=()=>{let raw="";let count=0;return {
  setItem:(key,value)=>{assert.equal(key,"wReviewWorkspaces");raw=value;count++},
  current:()=>raw?JSON.parse(raw):null,
  get count(){return count;}
}};
const save=(original,items,storageApi)=>{
  const changed={...original.slots[original.activeSlot],items,editorialMap:null};
  return writeEvidenceCheckpoint("wReviewWorkspaces",original,original.activeSlot,changed,storageApi);
};

test("save each of six successful batches, reopen and resume only P13-P18",()=>{
  let current=store();
  const disk=storage();
  for(let i=0;i<12;i+=2){
    const next=current.slots[1].items.map((item,index)=>
      index===i||index===i+1?verified(item):item);
    current=save(current,next,disk);
  }
  assert.equal(disk.count,6);
  const reopened=disk.current();
  assert.equal(reopened.slots[1].items.filter(x=>isEvidencePrepared(x,CONTRACT)).length,12);
  const pending=pendingEvidenceEntries(reopened.slots[1].items,CONTRACT);
  assert.deepEqual(pending.map(x=>x.index+1),[13,14,15,16,17,18]);
  // Previously accepted Evidence and the other workspaces survive the retry.
  assert.equal(reopened.slots[1].items[0].evidence,"Verified P1");
  assert.deepEqual(reopened.slots[0],store().slots[0]);
  assert.deepEqual(reopened.slots[2],store().slots[2]);
  let finished=reopened;
  for(let i=12;i<18;i+=2){
    const next=finished.slots[1].items.map((item,index)=>
      index===i||index===i+1?verified(item,"@cf/openai/gpt-oss-120b"):item);
    finished=save(finished,next,disk);
  }
  assert.equal(disk.count,9);
  assert.equal(pendingEvidenceEntries(disk.current().slots[1].items,CONTRACT).length,0);
  assert.equal(disk.current().slots[1].items[0].evidenceData.model,"gemini-3.5-flash-lite");
  assert.equal(disk.current().slots[1].items[17].evidenceData.model,"@cf/openai/gpt-oss-120b");
});
test("a partial one-of-two response saves the verified first item and retries just the second",()=>{
  const disk=storage();let current=store();
  current=save(current,current.slots[1].items.map((item,index)=>
    index===0?verified(item):item),disk);
  assert.deepEqual(pendingEvidenceEntries(disk.current().slots[1].items,CONTRACT)
    .slice(0,2).map(x=>x.index+1),[2,3]);
  assert.equal(disk.current().slots[1].items[0].evidence,"Verified P1");
});
test("force reset clears all old cards before re-extraction so only new-run cards remain",()=>{
  const disk=storage();let current=store();
  current=save(current,current.slots[1].items.map(item=>verified(item,"old")),disk);
  const reset=current.slots[1].items.map(item=>({...item,evidence:"",
    evidenceData:undefined,evidenceContract:0}));
  current=save(current,reset,disk);
  assert.equal(pendingEvidenceEntries(disk.current().slots[1].items,CONTRACT).length,18);
  current=save(current,current.slots[1].items.map((item,i)=>
    i<2?verified(item,"gemini-3.5-flash-lite"):item),disk);
  assert.equal(disk.current().slots[1].items.filter(x=>isEvidencePrepared(x,CONTRACT)).length,2);
  assert.equal(disk.current().slots[1].items[0].evidenceData.model,"gemini-3.5-flash-lite");
  assert.equal(disk.current().slots[1].items[2].evidence,"");
});
test("storage quota error never changes prior durable state",()=>{
  const original=store();
  assert.throws(()=>save(original,original.slots[1].items.map(item=>verified(item)),
    {setItem:()=>{throw new Error("QuotaExceededError");}}),/QuotaExceededError/);
  assert.equal(original.slots[1].items[0].evidence,"");
});
test("workspace mismatch aborts checkpoint before touching disk",()=>{
  const previous=store();
  assert.throws(()=>writeEvidenceCheckpoint("key",previous,0,
    {items:[]},{setItem:()=>assert.fail("must not write")}),/workspace_changed/);
});
