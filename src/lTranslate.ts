import {ensureWorkroomSession,loadWorkroomConfig,loadWorkroomSession} from "./workroom";
export type LTranslationResult={
  translatedText:string;
  model:string;
  usage:{prompt_tokens:number;completion_tokens:number;total_tokens:number};
  limits:{remaining_requests:string|null;remaining_tokens:string|null;limit_requests:string|null;limit_tokens:string|null;reset_requests:string|null;reset_tokens:string|null};
};
export async function translateLArticle(input:{text:string;title:string}):Promise<LTranslationResult>{
  const config=loadWorkroomConfig();
  const current=loadWorkroomSession();
  if(!current)throw new Error("TRANSLATE_AUTH_REQUIRED");
  const session=await ensureWorkroomSession(config,current);
  const response=await fetch(`${config.url.replace(/\/+$/,"")}/functions/v1/l-translate`,{
    method:"POST",
    headers:{apikey:config.anonKey,Authorization:`Bearer ${session.accessToken}`,"Content-Type":"application/json"},
    body:JSON.stringify(input),
  });
  const raw=await response.text();
  let data:any;
  try{data=JSON.parse(raw)}catch{throw new Error("TRANSLATE_INVALID_RESPONSE")}
  if(!response.ok)throw new Error(`${data.error||"TRANSLATE_FAILED"}: ${data.detail||""}`);
  const translatedText=String(data.translated_text||"").trim();
  if(!translatedText)throw new Error("TRANSLATE_EMPTY");
  return {translatedText,model:String(data.model||""),usage:data.usage||{},limits:data.limits||{}};
}
