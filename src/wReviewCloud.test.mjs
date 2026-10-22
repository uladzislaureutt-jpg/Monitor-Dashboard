import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {mergeCloudPayload,fingerprint,CLOUD_LIMIT_BYTES,isNonemptyWorkspace} from "./wReviewCloud.ts";
const item=(id,text="text")=>({id,title:"Статья "+id,source:"CNN",region:"США",
  url:"https://example.org/"+id,sourceText:text,editorialText:text,
  evidence:"P01:E01",evidenceData:{records:[],version:2},evidenceContract:6});
const empty=()=>({items:[],topic:"",tasks:[""],exclusions:"",targetChars:3000,
  samples:[],styleProfile:"",styleContract:0,editorialMap:null,selectedTrendIds:[],
  density:{quotes:"moderate",headlines:"moderate",experts:"moderate"},reviewText:"",
  reviewVariants:{},sectionTitles:[],boldPhrases:[],factCheck:null});
const slots=(contents,styles=[])=>{
 const states=[empty(),empty(),empty()];
 contents.forEach(([slot,items,topic])=>{states[slot]={...states[slot],items,topic};});
 return {names:["Тема 1","Тема 2","Тема 3"],
   slots:states.map(s=>({...s,samples:styles}))};
};
test("payload fingerprint is stable under PostgreSQL jsonb object-key reordering",()=>{
 const one={z:3,a:{f:1,c:[{y:2,x:1}]}};
 const two={a:{c:[{x:1,y:2}],f:1},z:3};
 assert.equal(fingerprint(one),fingerprint(two));
});
test("two offline computers contribute different articles to the SAME topic without losing Evidence",()=>{
 const a=slots([[0,[item("home")],"Мировая экономика"]]);
 const b=slots([[0,[item("office")],"Мировая экономика"]]);
 const r=mergeCloudPayload(a,b);
 assert.ok(r.value,r.reason);
 const ids=r.value.slots[0].items.map(x=>x.id);
 assert.deepEqual(ids.sort(),["home","office"]);
 assert.ok(r.value.slots[0].items.every(x=>x.evidenceContract===6));
});
test("second PC with empty pool downloads the populated canonical state",()=>{
 const home=slots([]);
 const office=slots([[0,[item("work")],"Лукашенко"]]);
 const r=mergeCloudPayload(home,office);
 assert.deepEqual(r.value,office);
});
test("preexisting different slot topics cannot overwrite each other",()=>{
 const home=slots([[0,[item("home")],"Тема А"]]);
 const office=slots([[0,[item("office")],"Тема Б"]]);
 const r=mergeCloudPayload(home,office);
 assert.equal(r.value,null);
 assert.match(r.reason,/разные темы/);
});
test("different edits to the same Evidence article block rather than overwriting",()=>{
 const home=slots([[0,[item("x","Локальные правки")],"Одна тема"]]);
 const office=slots([[0,[item("x","Иные правки")],"Одна тема"]]);
 const r=mergeCloudPayload(home,office);
 assert.equal(r.value,null);
 assert.match(r.reason,/по-разному/);
});
test("five local and five remote samples never cause silent truncation",()=>{
 const home=slots([],Array.from({length:5},(_,i)=>({id:"h"+i,name:"Образец "+i,text:"авторский текст"})));
 const office=slots([],Array.from({length:5},(_,i)=>({id:"o"+i,name:"Образец "+i,text:"другой текст"})));
 const r=mergeCloudPayload(home,office);
 assert.equal(r.value,null);
 assert.match(r.reason,/более пяти/);
});
test("identical author sample IDs consolidate across workspace slots",()=>{
 const shared=[{id:"style-1",name:"ШОС_Бишкек",text:"Текст авторского образца"}];
 const home=slots([[1,[item("x")],"Сюжет"]],shared);
 const office=slots([[2,[item("y")],"Другой сюжет"]],shared);
 const r=mergeCloudPayload(home,office);
 assert.ok(r.value,r.reason);
 assert.equal(r.value.slots[0].samples.length,1);
 assert.equal(r.value.slots[1].samples.length,1);
 assert.equal(r.value.slots[2].samples.length,1);
 assert.equal(r.value.slots[1].items[0].id,"x");
 assert.equal(r.value.slots[2].items[0].id,"y");
});
test("never destroy a computed trend map while joining two independent pools",()=>{
 const home=slots([[0,[item("x")],"Тема"]]);
 const office=slots([[0,[item("y")],"Тема"]]);
 home.slots[0].editorialMap={version:3,trends:[{id:"T1"}]};
 const r=mergeCloudPayload(home,office);
 assert.equal(r.value,null);
 assert.match(r.reason,/сохранить обе рассчитанные карты/);
});
test("sync is per authenticated account with offline checkpoint and strict RLS",()=>{
 const ui=readFileSync(new URL("./views/WReviewView.tsx",import.meta.url),"utf8");
 const app=readFileSync(new URL("./App.tsx",import.meta.url),"utf8");
 const sql=readFileSync(new URL("../backend/supabase/migrations/20261022_w_review_cloud_state.sql",import.meta.url),"utf8");
 assert.ok(ui.includes("accountKey(userId),checkpointStore"));
 assert.ok(ui.includes("syncCloudOnce(userId,payload,baselineRef.current)"));
 assert.ok(ui.includes("localStorage.setItem(accountKey(userId)"));
 assert.ok(app.includes("key={access.session!.userId} userId={access.session!.userId}"));
 assert.ok(sql.includes("enable row level security"));
 assert.ok(sql.includes("user_id=(select auth.uid())"));
 assert.ok(sql.includes("grant select,insert,update"));
 assert.ok(sql.includes("revoke all on public.w_review_cloud_state from anon"));
 assert.ok(CLOUD_LIMIT_BYTES<=4_800_000);
 assert.equal(isNonemptyWorkspace(empty()),false);
});
