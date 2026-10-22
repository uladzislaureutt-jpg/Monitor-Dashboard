// Secure transport for an authenticated user's W-Review cloud state.
import {ensureWorkroomSession,loadWorkroomConfig,loadWorkroomSession} from "./workroom";
import {fingerprint,mergeCloudPayload,CLOUD_LIMIT_BYTES,type CloudWorkspaces,type CloudRow,
  type SyncBaseline,type SyncOutcome} from "./wReviewCloudCore";
export {fingerprint,mergeCloudPayload,CLOUD_LIMIT_BYTES,isNonemptyWorkspace} from "./wReviewCloudCore";
export type {CloudWorkspaces,CloudRow,SyncBaseline,SyncOutcome} from "./wReviewCloudCore";
const baseUrl=()=>loadWorkroomConfig().url.replace(/\/+$/,"");
async function request(userId:string,path:string,init:RequestInit={}):Promise<any>{
  const session=loadWorkroomSession();
  if(!session||session.userId!==userId)throw Error("W_REVIEW_SYNC_ACCOUNT_CHANGED");
  const config=loadWorkroomConfig(),active=await ensureWorkroomSession(config,session);
  if(active.userId!==userId)throw Error("W_REVIEW_SYNC_ACCOUNT_CHANGED");
  const response=await fetch(baseUrl()+"/rest/v1/"+path,{
    ...init,headers:{apikey:config.anonKey,Authorization:"Bearer "+active.accessToken,
      "Content-Type":"application/json",...(init.headers||{})}
  });
  const raw=await response.text();
  let payload:any;try{payload=raw?JSON.parse(raw):null;}catch{payload=raw;}
  if(!response.ok)throw Error("W_REVIEW_SYNC_HTTP_"+response.status+":"+String(payload?.message||payload?.hint||raw||"").slice(0,180));
  return payload;
}
export async function fetchCloud<T>(userId:string):Promise<CloudRow<T>|null>{
  const params=new URLSearchParams({user_id:"eq."+userId,select:"revision,payload,updated_at",limit:"1"});
  const rows=await request(userId,"w_review_cloud_state?"+params.toString());
  if(!Array.isArray(rows))throw Error("W_REVIEW_SYNC_INVALID_RESPONSE");
  return rows[0]||null;
}
export async function writeCloud<T>(userId:string,revision:number,payload:CloudWorkspaces<T>):
  Promise<CloudRow<T>|null>{
  const body=JSON.stringify(payload);
  if(new TextEncoder().encode(body).length>CLOUD_LIMIT_BYTES)
    throw Error("W_REVIEW_SYNC_TOO_LARGE");
  if(revision===0){
    const rows=await request(userId,"w_review_cloud_state?on_conflict=user_id",{
      method:"POST",headers:{Prefer:"resolution=ignore-duplicates,return=representation"},
      body:JSON.stringify({user_id:userId,revision:1,payload})
    });
    return Array.isArray(rows)?rows[0]||null:null;
  }
  const params=new URLSearchParams({user_id:"eq."+userId,revision:"eq."+revision,
    select:"revision,payload,updated_at"});
  const rows=await request(userId,"w_review_cloud_state?"+params.toString(),{
    method:"PATCH",headers:{Prefer:"return=representation"},
    body:JSON.stringify({revision:revision+1,payload,updated_at:new Date().toISOString()})
  });
  return Array.isArray(rows)?rows[0]||null:null;
}
export async function syncCloudOnce<T>(userId:string,local:CloudWorkspaces<T>,
  baseline:SyncBaseline|null):Promise<SyncOutcome<T>>{
  let remote=await fetchCloud<T>(userId);
  if(!remote){
    const created=await writeCloud(userId,0,local);
    if(created)return {kind:"uploaded",payload:local,
      baseline:{revision:created.revision,fingerprint:fingerprint(local)}};
    remote=await fetchCloud<T>(userId);
    if(!remote)throw Error("W_REVIEW_SYNC_RACE_RETRY");
  }
  const localFp=fingerprint(local),remoteFp=fingerprint(remote.payload);
  const remoteBase={revision:remote.revision,fingerprint:remoteFp};
  if(localFp===remoteFp)return {kind:"unchanged",payload:local,baseline:remoteBase};
  // This device has not changed since its last accepted cloud revision.
  if(baseline&&baseline.fingerprint===localFp)
    return {kind:"downloaded",payload:remote.payload,baseline:remoteBase};
  // Cloud has not changed since our last successful pull/commit.
  if(baseline&&baseline.revision===remote.revision){
    const saved=await writeCloud(userId,remote.revision,local);
    if(saved)return {kind:"uploaded",payload:local,baseline:{
      revision:saved.revision,fingerprint:localFp}};
    return {kind:"conflict",payload:local,baseline:baseline,
      detail:"Облачная версия изменилась одновременно с локальной. Повторите синхронизацию."};
  }
  // First connection of two pre-existing PCs or concurrent offline edits.
  // Safe merge only when source records and editorial drafts are compatible.
  const merged=mergeCloudPayload(local,remote.payload);
  if(!merged.value)return {kind:"conflict",payload:local,baseline:baseline||remoteBase,
    detail:merged.reason};
  if(fingerprint(merged.value)===remoteFp)
    return {kind:"downloaded",payload:remote.payload,baseline:remoteBase};
  const saved=await writeCloud(userId,remote.revision,merged.value);
  if(!saved)return {kind:"conflict",payload:local,baseline:baseline||remoteBase,
    detail:"Другой компьютер обновил облако во время объединения."};
  return {kind:"merged",payload:merged.value,
    baseline:{revision:saved.revision,fingerprint:fingerprint(merged.value)}};
}
