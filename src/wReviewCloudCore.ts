// Pure merge logic shared with Node regressions, no Tauri or network imports.
export type CloudWorkspaces<T>={
  names:string[];slots:T[];
};
export type CloudRow<T>={
  revision:number;payload:CloudWorkspaces<T>;updated_at:string;
};
export type SyncBaseline={revision:number;fingerprint:string};
export type SyncOutcome<T>={
  kind:"uploaded"|"downloaded"|"merged"|"unchanged"|"conflict";
  payload:CloudWorkspaces<T>;baseline:SyncBaseline;detail?:string;
};
export const CLOUD_LIMIT_BYTES=4_800_000;
const MAX_ITEMS=30;
const MAX_SAMPLES=5;

function canonical(value:any):string{
  if(value===null||typeof value!=="object")return JSON.stringify(value)??"null";
  if(Array.isArray(value))return "["+value.map(v=>canonical(v)).join(",")+"]";
  return "{"+Object.keys(value).filter(k=>value[k]!==undefined).sort()
    .map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";
}
export function fingerprint(value:unknown):string{
  // Postgres jsonb may reorder object keys. Compare canonical content, not
  // incidental JS serialization order.
  const str=canonical(value);
  let h1=2166136261,h2=2166136261;
  for(let i=0;i<str.length;i++){
    const code=str.charCodeAt(i);
    h1=Math.imul(h1^code,16777619);
    h2=Math.imul(h2^(code+i),16777619);
  }
  return [str.length,h1>>>0,h2>>>0].join(":");
}
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const own=(v:unknown)=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const articleCount=(s:any)=>Array.isArray(s?.items)?s.items.length:0;
export function isNonemptyWorkspace(s:any):boolean{
  return articleCount(s)>0||Boolean(String(s?.topic||"").trim())||
    Boolean(String(s?.reviewText||"").trim())||Boolean(s?.editorialMap);
}
function mergeSamples(local:any,remote:any){
  const both=[...(Array.isArray(local)?local:[]),...(Array.isArray(remote)?remote:[])];
  const seen=new Map<string,any>();
  for(const x of both){
    const key=String(x?.id||"")+"::"+String(x?.name||"");
    if(seen.has(key)&&!equal(seen.get(key),x))return null;
    seen.set(key,x);
  }
  if(seen.size>MAX_SAMPLES)return null;
  return [...seen.values()];
}
function mergeWorkspace(local:any,remote:any):{value:any|null;reason?:string}{
  if(equal(local,remote))return {value:local};
  if(!isNonemptyWorkspace(local))return {value:remote};
  if(!isNonemptyWorkspace(remote))return {value:local};
  // Separate articles can be combined WITHOUT throwing away any Evidence.
  // But existing analyses/drafts cannot be rebuilt by concatenation, and
  // repeated IDs may refer to different edits; both are explicit conflicts.
  const a=Array.isArray(local.items)?local.items:[],b=Array.isArray(remote.items)?remote.items:[];
  const byId=new Map<string,any>(a.map((x:any)=>[String(x.id),x]));
  for(const item of b){
    const id=String(item.id);
    if(byId.has(id)&&!equal(byId.get(id),item))
      return {value:null,reason:"Один материал отредактирован по-разному на двух компьютерах."};
    if(!byId.has(id))byId.set(id,item);
  }
  if(byId.size>MAX_ITEMS)
    return {value:null,reason:"Объединённый пул превысил безопасный предел 30 материалов."};
  if(local.topic&&remote.topic&&local.topic!==remote.topic)
    return {value:null,reason:"В одном слоте находятся две разные темы."};
  if(local.reviewText&&remote.reviewText&&local.reviewText!==remote.reviewText)
    return {value:null,reason:"На двух устройствах сохранены разные варианты итогового обзора."};
  if(local.editorialMap&&remote.editorialMap&&!equal(local.editorialMap,remote.editorialMap))
    return {value:null,reason:"На двух устройствах отличаются рассчитанные тенденции."};
  // If material sets differ, the previously calculated trends cannot claim to
  // cover both sets. Stop instead of silently discarding an editorial dossier.
  if((local.editorialMap||remote.editorialMap)&&!equal(a,b))
    return {value:null,reason:"Для объединения пулов нужно сохранить обе рассчитанные карты тенденций отдельно."};
  const keys=["tasks","exclusions","targetChars","density","selectedTrendIds","reviewVariants"];
  for(const key of keys){
    const x=local[key],y=remote[key];
    if(x!==undefined&&y!==undefined&&!equal(x,y)){
      const defaults:Record<string,unknown>={tasks:[""],exclusions:"",targetChars:3000,
        density:{quotes:"moderate",headlines:"moderate",experts:"moderate"},
        selectedTrendIds:[],reviewVariants:{}};
      if(!equal(x,defaults[key])&&!equal(y,defaults[key]))
        return {value:null,reason:"В теме отличаются редакционные настройки ("+key+")."};
    }
  }
  const winner={...remote,...local,items:[...byId.values()],
    topic:local.topic||remote.topic,
    reviewText:local.reviewText||remote.reviewText,
    editorialMap:local.editorialMap||remote.editorialMap
  };
  return {value:winner};
}
export function mergeCloudPayload<T>(local:CloudWorkspaces<T>,remote:CloudWorkspaces<T>):
  {value:CloudWorkspaces<T>|null;reason?:string}{
  if(equal(local,remote))return {value:remote};
  if(!Array.isArray(local?.slots)||!Array.isArray(remote?.slots)||
     local.slots.length!==3||remote.slots.length!==3)
    return {value:null,reason:"Несовместимый формат облачных рабочих тем."};
  // A home machine and an office machine often both use "Тема 1" for
  // DIFFERENT subjects. Preserve both completed drafts and their Evidence
  // by relocating one complete subject to a jointly vacant slot. Never
  // silently reassign when all three slots are occupied.
  const localSlots=[...local.slots] as any[];
  const localNames=[...local.names];
  for(let i=0;i<3;i++){
    const lhs=localSlots[i],rhs=remote.slots[i] as any;
    if(!isNonemptyWorkspace(lhs)||!isNonemptyWorkspace(rhs)||
       !lhs.topic||!rhs.topic||lhs.topic===rhs.topic)continue;
    const free=[0,1,2].find(j=>j!==i&&!isNonemptyWorkspace(localSlots[j])&&
      !isNonemptyWorkspace(remote.slots[j]));
    if(free===undefined)continue;
    localSlots[free]=lhs;
    localNames[free]=localNames[i];
    localSlots[i]=rhs;
    localNames[i]=remote.names[i];
  }
  const ls=own(localSlots[0]),rs=own(remote.slots[0]); 
  const samples=mergeSamples(ls.samples,rs.samples);
  if(!samples)return {value:null,reason:"В профилях устройств более пяти образцов или разные редакции одного образца."};
  if(ls.styleProfile&&rs.styleProfile&&ls.styleProfile!==rs.styleProfile)
    return {value:null,reason:"На устройствах разные построенные профили авторского стиля."};
  const values:any[]=[];
  for(let i=0;i<3;i++){
    const result=mergeWorkspace(localSlots[i],remote.slots[i]);
    if(!result.value)return {value:null,reason:"Тема "+(i+1)+": "+result.reason};
    values.push(result.value);
  }
  const profile=ls.styleProfile||rs.styleProfile||"";
  const contract=ls.styleContract||rs.styleContract||0;
  const slots=values.map(v=>({...v,samples,styleProfile:profile,styleContract:contract}));
  const names=remote.names.map((n,i)=>n.startsWith("Тема ")&&localNames[i]?localNames[i]:n);
  return {value:{names,slots}};
}
