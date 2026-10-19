import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {prepareEvidence} from "./preparation.ts";
import {makeEvidenceDocuments} from "./evidence-v2.ts";
const index=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const preparation=readFileSync(new URL("./preparation.ts",import.meta.url),"utf8");
const dossier=index.slice(index.indexOf('if (action === "editorial_map")'),index.indexOf('if (action === "expand_review")'));
const extraction=index.slice(index.indexOf('if (action === "evidence_batch")'),index.indexOf('if (action === "style_profile")'));
test("Dossier prioritizes CF GPT-OSS-120B, then Gemini 3.5, then Groq 120B",()=>{
  assert.ok(dossier.indexOf('if(!selected&&cfRoute')>=0);
  assert.ok(dossier.indexOf('if(!selected&&geminiApiKey')>=0);
  assert.ok(dossier.indexOf('if(!selected&&cfRoute')<dossier.indexOf('if(!selected&&geminiApiKey'));
  assert.ok(dossier.indexOf('if(!selected&&geminiApiKey')<dossier.indexOf('if(!selected&&groqApiKey'));
  assert.ok(dossier.includes('Math.min(42000,availableTime())'));
  assert.ok(dossier.includes('Math.min(46000,availableTime())'));
  assert.ok(dossier.includes('Math.min(34000,availableTime())'));
  assert.ok(dossier.includes('preparationDeadline=Date.now()+W_REVIEW_REQUEST_BUDGET_MS'));
  assert.ok(dossier.includes('preparationDeadline-Date.now()-7000'));
  assert.ok(dossier.includes('w_review_map_cloudflare_result'));
  assert.ok(dossier.includes('w_review_map_groq_result'));
  assert.ok(index.includes('max_tokens:9000,'));
  assert.ok(index.includes('max_completion_tokens:9000'));
  const evidence=index.slice(index.indexOf('if (action === "evidence_batch")'),
     index.indexOf('if (action === "editorial_map")'));
  assert.ok(evidence.includes('cloudflareFirst:false'));
  assert.ok(evidence.includes('routes:["gemini_3.5","cloudflare_120b","groq_120b"]'));
});
test("Evidence reserves time for Groq 120B and does not spend 75s on CF first",()=>{
  assert.ok(extraction.includes("cloudflareFirst:false"));
  assert.ok(preparation.includes('input.cloudflareFirst?70000:60000'));
  assert.ok(preparation.includes('input.cloudflareFirst?68000:37000'));
  assert.ok(preparation.includes('input.cloudflareFirst?18000:35000'));
  assert.ok(extraction.includes('preparationBudget(attemptDeadline,45000)'));
  assert.ok(extraction.includes('preparationBudget(attemptDeadline,31000)'));
  assert.ok(preparation.includes("elapsed_ms"));
});
test("Cloudflare-first Evidence allows primary >60 seconds without removing fallback",async()=>{
  const docs=makeEvidenceDocuments([{index:0,publication_id:"a",source:"Публикация",title:"Тема",text:"В материале приведены проверяемые данные."}]);
  const calls=[];
  const result=await prepareEvidence({documents:docs,deadline:Date.now()+140000,
    cloudflareFirst:true,available:{primary:true,cloudflare:true,fallback:true,groq:false},
    generate:async(provider,docs,deadline)=>{
      calls.push({provider,remaining:deadline-Date.now()});
      return {model:provider,reply:{ok:false,status:503,retryAfter:null,detail:"simulated"}};
    }
  });
  assert.deepEqual(calls.map(c=>c.provider),["primary","cloudflare","fallback"]);
  assert.ok(calls[0].remaining>60000);
  assert.ok(calls[0].remaining<=68000);
  assert.ok(calls[1].remaining<=112000);
  assert.ok(result.articles.length===0);
});

test("Gemini-first Evidence reaches CF then Groq when no provider yields verified cards",async()=>{
  const docs=makeEvidenceDocuments([{index:0,publication_id:"x",source:"СМИ",title:"Публикация",text:"Данные о публикации."}]);
  const calls=[];
  await prepareEvidence({documents:docs,deadline:Date.now()+140000,
    cloudflareFirst:false,available:{primary:true,cloudflare:true,fallback:false,groq:true},
    generate:async(provider,articles,deadline)=>{
      calls.push({provider,remaining:deadline-Date.now()});
      return {model:provider,reply:{ok:false,status:503,retryAfter:null,detail:"mock"}};
    }
  });
  assert.deepEqual(calls.map(c=>c.provider),["primary","cloudflare","groq"]);
  assert.ok(calls[0].remaining<=37000);
  assert.ok(calls[1].remaining<=35000);
  assert.ok(calls[2].remaining<=31000);
});

test("Gemini-first has time for two separately verified article repairs after malformed joint JSON",async()=>{
  const docs=makeEvidenceDocuments([0,1].map(index=>({index,
    publication_id:"a"+index,source:"СМИ",title:"Проверка",
    text:"Компания увеличила выручку на двадцать процентов."})));
  const mk=index=>({index,title_ru:"Проверка",records:[{
    kind:"fact",statement_ru:"Выручка компании увеличилась на двадцать процентов.",
    anchor_id:"P001",source_excerpt:"Компания увеличила выручку на двадцать процентов",
    original_quote:"",quote_ru:"",speaker:"",role:""
  }]});
  const savedNow=Date.now;let now=1_800_000_000_000;Date.now=()=>now;
  try{
    const called=[];
    const res=await prepareEvidence({documents:docs,deadline:now+140000,cloudflareFirst:false,
      available:{primary:true,cloudflare:true,fallback:false,groq:true},
      generate:async(provider,articles,deadline)=>{
        called.push([provider,articles.map(a=>a.publication_id),deadline-now]);
        if(provider==="primary"&&articles.length===2){
          now+=19000;
          return {model:"gemini-3.5-flash-lite",reply:{ok:true,
            content:'{"cards":[{"index":0,"title_ru":"broken"',
            usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2},finish_reason:"STOP"}};
        }
        if(provider==="primary"){
          now+=17000;
          return {model:"gemini-3.5-flash-lite",reply:{ok:true,content:JSON.stringify({cards:[mk(0)]}),
            usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2},finish_reason:"STOP"}};
        }
        throw Error("Gemini had enough repair time: no reserve provider required");
      }});
    assert.deepEqual(called.map(v=>v[0]),["primary","primary","primary"]);
    assert.deepEqual(called.map(v=>v[1]),[["a0","a1"],["a0"],["a1"]]);
    assert.ok(called[2][2]>=15000);
    assert.equal(res.articles.length,2);
    assert.ok(res.articles.every(x=>x.model==="gemini-3.5-flash-lite"));
  }finally{Date.now=savedNow;}
});
test("never waste quota on a 2.8 second Gemini repair; move to bounded Cloudflare",async()=>{
  const docs=makeEvidenceDocuments([0,1].map(index=>({index,publication_id:"a"+index,
    source:"СМИ",title:"Проверка",text:"Компания увеличила выручку на двадцать процентов."})));
  const mk=()=>({index:0,title_ru:"Проверка",records:[{
    kind:"fact",statement_ru:"Выручка компании увеличилась на двадцать процентов.",
    anchor_id:"P001",source_excerpt:"Компания увеличила выручку на двадцать процентов",
    original_quote:"",quote_ru:"",speaker:"",role:""
  }]});
  const savedNow=Date.now;let now=1_800_000_000_000;Date.now=()=>now;
  try{
    const called=[];
    const res=await prepareEvidence({documents:docs,deadline:now+140000,
      available:{primary:true,cloudflare:true,fallback:false,groq:false},
      generate:async(provider,articles,deadline)=>{
        called.push([provider,articles.map(a=>a.publication_id),deadline-now]);
        if(provider==="primary"&&articles.length===2){now+=35000;return {model:provider,reply:{
          ok:true,content:'not-json',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}};}
        if(provider==="primary"){now+=17000;return {model:provider,reply:{
          ok:true,content:JSON.stringify({cards:[mk()]}),
          usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}};}
        now+=15000;
        return {model:provider,reply:{ok:true,content:JSON.stringify({cards:[mk()]}),
          usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}};
      }});
    assert.deepEqual(called.map(x=>x[0]),["primary","primary","cloudflare"]);
    assert.deepEqual(called[2][1],["a1"]);
    assert.ok(called[2][2]>=30000);
    assert.equal(res.articles.length,2);
  }finally{Date.now=savedNow;}
});

test("shared 140s W-Review budget applies to Evidence, dossier and synthesis under Supabase's 150s ceiling",()=>{
  assert.ok(index.includes("const W_REVIEW_REQUEST_BUDGET_MS = 140_000;"));
  assert.ok(extraction.includes("const deadline=Date.now()+W_REVIEW_REQUEST_BUDGET_MS"));
  assert.ok(dossier.includes("const preparationDeadline=Date.now()+W_REVIEW_REQUEST_BUDGET_MS"));
  assert.ok(index.includes("const deadline=synthesisStart+W_REVIEW_REQUEST_BUDGET_MS"));
  assert.ok(dossier.includes("preparationDeadline-Date.now()-7000"));
  assert.ok(index.includes("remaining=()=>Math.max(0,deadline-Date.now()-9000)"));
});
