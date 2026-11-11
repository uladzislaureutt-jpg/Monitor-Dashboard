import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {distinctGeminiCredentials,makeGeminiKeyFailover} from './gemini-key-failover.ts';

const keys=[{name:'GEMINI_API_KEY',key:'secret-one'}, {name:'GOOGLE_GEMINI_API_KEY',key:'secret-two'}];
const minuteLimit={ok:false,status:429,retryAfter:'60s',diagnostic:{retryable:true}};
const success={ok:true};
const cooling=()=>({ok:false,status:429,retryAfter:'60',diagnostic:{retryable:true}});

test('duplicate aliases do not cause extra Gemini requests',()=>{
  assert.deepEqual(distinctGeminiCredentials([keys[0],{name:'alias',key:'secret-one'},keys[1],{name:'empty',key:''}]),keys);
});
test('minute 429 switches to second credential, skips cooling key, then recovers primary',async()=>{
  let t=0;
  const route=makeGeminiKeyFailover(()=>t);
  const observed=[];
  const call=async({name})=>{observed.push(name);return name==='GEMINI_API_KEY' ? minuteLimit : success;};
  assert.equal((await route(keys,call,cooling)).ok,true);
  assert.deepEqual(observed,['GEMINI_API_KEY','GOOGLE_GEMINI_API_KEY']);
  t=30_000;
  assert.equal((await route(keys,call,cooling)).ok,true);
  assert.deepEqual(observed,['GEMINI_API_KEY','GOOGLE_GEMINI_API_KEY','GOOGLE_GEMINI_API_KEY']);
  t=61_000;
  assert.equal((await route(keys,call,cooling)).ok,true);
  assert.deepEqual(observed.slice(-2),['GEMINI_API_KEY','GOOGLE_GEMINI_API_KEY']);
});
test('two minute-429s cool down both keys without retry storm',async()=>{
  let t=0;
  const route=makeGeminiKeyFailover(()=>t);
  let attempts=0;
  const call=async()=>{attempts++;return minuteLimit;};
  assert.equal((await route(keys,call,cooling)).status,429);
  assert.equal(attempts,2);
  t=5_000;
  assert.equal((await route(keys,call,cooling)).status,429);
  assert.equal(attempts,2);
  t=61_000;
  await route(keys,call,cooling);
  assert.equal(attempts,4);
});
test('daily quotas or unknown errors do NOT switch keys',async()=>{
  const route=makeGeminiKeyFailover();
  let attempts=0;
  const fail=async()=>{attempts++;return {ok:false,status:429,diagnostic:{retryable:false}};};
  assert.equal((await route(keys,fail,cooling)).status,429);
  assert.equal(attempts,1);
});
test('time budget prevents starting second call too late',async()=>{
  let t=0;
  const route=makeGeminiKeyFailover(()=>t);
  let attempts=0;
  await route(keys,async()=>{attempts++;t=8_000;return minuteLimit;},cooling,{budgetMs:10_000});
  assert.equal(attempts,1);
});
test('production Gemini calls use key failover wrapper, not direct single credential',()=>{
  const index=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
  assert.ok(index.includes('const routeGeminiKeys=makeGeminiKeyFailover()'));
  assert.ok(index.includes('return routeGeminiKeys('));
  assert.ok(index.includes('callGeminiOnce(credential.key,model,prompt,schema'));
  assert.ok(index.includes('Deno.env.get("GOOGLE_GEMINI_API_KEY")'));
});
