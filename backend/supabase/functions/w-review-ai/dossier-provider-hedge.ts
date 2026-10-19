// Bounded provider fallback for W-Review: preserves Cloudflare PRIMARY priority
// while allowing Gemini backup to start if Cloudflare is unusually slow.
// No additional calls for a primary that completes before the hedge delay.
export function scheduleHedgedBackup<T>(start:()=>Promise<T>,delayMs:number){
  let current:Promise<T>|null=null;
  let cancelled=false;
  const launch=():Promise<T>|null=>{
    if(cancelled)return null;
    if(!current)current=Promise.resolve().then(start);
    return current;
  };
  const timer=setTimeout(()=>{void launch();},Math.max(0,delayMs));
  return {
    started:()=>Boolean(current),
    cancel:()=>{clearTimeout(timer);cancelled=true;},
    waitOrStart:()=>{
      clearTimeout(timer);
      const result=launch();
      if(!result)throw Error("HEDGED_BACKUP_CANCELLED");
      return result;
    }
  };
}
// Groq Free's published 8K TPM applies to a whole request, not just its output.
// A conservative estimate is essential; never send a known-overlarge full pool
// to Groq and then misreport HTTP 413 as an AI-quality failure.
export function groqDossierBudget(messages:unknown,options?:{tpm?:number}){
  const tpm=options?.tpm??8000;
  const requestChars=JSON.stringify(messages).length;
  const estimatedInputTokens=Math.ceil(requestChars/2.4);
  const safeAvailable=Math.max(0,tpm-estimatedInputTokens-650);
  const maxCompletionTokens=Math.min(3300,safeAvailable);
  return {
    requestChars,
    estimatedInputTokens,
    maxCompletionTokens,
    eligible:maxCompletionTokens>=1300
  };
}
