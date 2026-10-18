import test from 'node:test';
import assert from 'node:assert/strict';
import {structuredGeminiRequest,prepareEvidence,preparationBudget} from './preparation.ts';
import {wGeminiStructuredConfig} from './gemini-routing.ts';
import {makeEvidenceDocuments,evidenceQualityWarnings,verifyEvidenceCards} from './evidence-v2.ts';
const usage={prompt_tokens:10,completion_tokens:20,total_tokens:30};
const ok=data=>({ok:true,content:JSON.stringify(data),usage,finish_reason:'STOP'});
const bad=(status,kind='provider_error',retryAfter=null)=>({ok:false,status,detail:kind,retryAfter,diagnostic:{kind,retryable:kind==='minute_requests'}});
test('format 400 changes format on same model; every mode requests actual JSON',async()=>{
  const calls=[];
  const result=await structuredGeminiRequest({deadline:Date.now()+60000,call:async(mode,ms)=>{
    calls.push(mode);assert.ok(ms>0&&ms<=35000);
    const cfg=wGeminiStructuredConfig({type:'OBJECT'},mode,{maxOutputTokens:1000});
    assert.ok(cfg.responseFormat||cfg.responseMimeType==='application/json');
    return calls.length<3?bad(400):ok({cards:[]});
  }});
  assert.equal(result.ok,true);assert.deepEqual(calls,['schema','legacy_schema','json']);
});
test('malformed JSON switches format once; truncation does not repeat batch',async()=>{
  const calls=[];
  await structuredGeminiRequest({deadline:Date.now()+60000,call:async mode=>{
    calls.push(mode);return {...ok({}),content:'{"cards":'};
  }});
  assert.deepEqual(calls,['schema','json']);
  let n=0;
  await structuredGeminiRequest({deadline:Date.now()+60000,call:async()=>{n++;return {...ok({}),content:'{',finish_reason:'MAX_TOKENS'};}});
  assert.equal(n,1);
});
test('minute limit honors short provider delay, daily quota never retries',async()=>{
  const slept=[];let n=0;
  await structuredGeminiRequest({deadline:Date.now()+60000,sleep:async ms=>slept.push(ms),
    call:async()=>++n===1?bad(429,'minute_requests','2s'):ok({cards:[]})});
  assert.deepEqual(slept,[2000]);assert.equal(n,2);
  n=0;await structuredGeminiRequest({deadline:Date.now()+60000,call:async()=>{n++;return bad(429,'daily_quota','2s');}});
  assert.equal(n,1);
});
test('exhausted deadline never initiates an unbounded request',async()=>{
  assert.equal(preparationBudget(Date.now()-1,10000),0);
  await structuredGeminiRequest({deadline:Date.now()-1,call:async()=>{throw Error('must not call');}});
});
const docs=makeEvidenceDocuments([0,1].map(index=>({index,publication_id:'article-'+index,source:'Издание',title:'Заголовок',
  text:'Компания сообщила о росте выручки на двадцать процентов.'})));
const card=(index,n=2)=>({index,title_ru:'Заголовок',records:Array.from({length:n},(_,i)=>({kind:'fact',
  statement_ru:'Сообщение компании о результатах номер '+i,anchor_id:'P001',source_excerpt:'Компания сообщила о росте выручки',
  original_quote:'',quote_ru:'',speaker:'',role:''}))});
test('valid primary card survives peer failure; retry only peer with local index zero',async()=>{
  const calls=[];
  const result=await prepareEvidence({documents:docs,deadline:Date.now()+130000,
    available:{primary:true,cloudflare:true,fallback:true,groq:true},
    generate:async(provider,documents)=>{
      calls.push([provider,documents.map(d=>d.publication_id)]);
      if(calls.length===1)return {reply:ok({cards:[card(0,6)]}),model:'3.5'};
      assert.equal(documents[0].index,0);
      return {reply:ok({cards:[card(0,2)]}),model:'3.5'};
    }});
  assert.deepEqual(calls,[['primary',['article-0','article-1']],['primary',['article-1']]]);
  assert.equal(result.articles[0].card.records.length,6);
  assert.equal(result.articles[1].index,1);
  assert.equal(result.articles[1].card.publication_id,'article-1');
  assert.equal(result.usage.total_tokens,60);
});
test('quality reserve precedes emergency Lite and all returns remain validated',async()=>{
  const calls=[];
  const result=await prepareEvidence({documents:[docs[0]],deadline:Date.now()+130000,
    available:{primary:true,cloudflare:true,fallback:true,groq:true},
    generate:async provider=>{calls.push(provider);
      return provider==='fallback'?{reply:ok({cards:[card(0)]}),model:'3.1'}:
        {reply:bad(503),model:provider};}});
  assert.deepEqual(calls,['primary','cloudflare','fallback']);
  assert.equal(result.articles[0].model,'3.1');
});
test('weak long-article coverage is explicitly signalled, not certified complete',()=>{
  const doc=makeEvidenceDocuments([{...docs[0],text:Array.from({length:20},(_,i)=>
    'Раздел '+i+'. '+docs[0].passages[0].text.repeat(5)).join('\n\n')}])[0];
  const raw=card(0,5);raw.records[4].anchor_id='P002';
  const verified=verifyEvidenceCards({cards:[raw]},[doc]);
  assert.equal(verified.error,null);
  assert.deepEqual(evidenceQualityWarnings(verified.cards[0],doc),['sparse_records','uneven_article_coverage']);
});
test('logs never contain generated text or input articles',async()=>{
  const logs=[];
  await structuredGeminiRequest({deadline:Date.now()+60000,log:e=>logs.push(e),call:async()=>ok({secret:'PRIVATE_ARTICLE'})});
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_ARTICLE'));
});

test('production structured adapter uses GenerateContent enum and normalized compatibility schema',()=>{
 const schema={type:'OBJECT',properties:{cards:{type:'ARRAY',items:{type:'OBJECT',properties:{index:{type:'INTEGER'}},required:['index']}}},required:['cards']};
 const primary=wGeminiStructuredConfig(schema,'schema');
 assert.equal(primary.responseFormat.text.mimeType,'APPLICATION_JSON');
 assert.equal(primary.responseFormat.text.schema.properties.cards.items.properties.index.type,'integer');
 const compatibility=wGeminiStructuredConfig(schema,'legacy_schema');
 assert.equal(compatibility.responseMimeType,'application/json');
 assert.equal(compatibility.responseJsonSchema.type,'object');
 assert.equal(compatibility.responseSchema,undefined);
 assert.equal(wGeminiStructuredConfig(schema,'json').responseMimeType,'application/json');
});
