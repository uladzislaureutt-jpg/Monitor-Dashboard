// W-Review Gemini routing and current GenerateContent JSON Schema configuration.
export const W_REVIEW_GEMINI_PRIMARY = "gemini-3.5-flash-lite";
export const W_REVIEW_GEMINI_FALLBACK = "gemini-3.1-flash-lite";
export const W_REVIEW_GEMINI_ROUTES = [W_REVIEW_GEMINI_PRIMARY, W_REVIEW_GEMINI_FALLBACK] as const;

// The old Gemini responseSchema accepts legacy OpenAPI upper-case type values.
// The current generationConfig.responseFormat.text.schema requires JSON Schema.
// IMPORTANT: unlike legacy responseMimeType, text.mimeType is a protobuf enum
// that requires the uppercase literal APPLICATION_JSON on generateContent:
// types must be lower-case, even inside nested arrays/objects.
const types:Record<string,string>={OBJECT:"object",ARRAY:"array",STRING:"string",
  INTEGER:"integer",NUMBER:"number",BOOLEAN:"boolean",NULL:"null"};
export function normalizeGeminiJsonSchema(value:unknown):unknown{
  if(Array.isArray(value))return value.map(normalizeGeminiJsonSchema);
  if(!value||typeof value!=="object")return value;
  const out:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value)){
    if(key==="type"&&typeof item==="string")out[key]=types[item]||item;
    else if(key==="type"&&Array.isArray(item))out[key]=item.map(v=>typeof v==="string"?(types[v]||v):v);
    else if(key==="properties"&&item&&typeof item==="object"&&!Array.isArray(item)){
      out[key]=Object.fromEntries(Object.entries(item).map(([name,part])=>[name,normalizeGeminiJsonSchema(part)]));
    } else if(["items","prefixItems","additionalProperties","anyOf","oneOf","allOf","$defs"].includes(key))
      out[key]=normalizeGeminiJsonSchema(item);
    else out[key]=item;
  }
  return out;
}
export function wGeminiGenerationConfig(schema:unknown,options?:{
  maxOutputTokens?:number;thinkingLevel?:"minimal"|"low"|"medium"|"high"
}){
  return {
    responseFormat:{text:{mimeType:"APPLICATION_JSON",schema:normalizeGeminiJsonSchema(schema)}},
    ...(options?.maxOutputTokens?{maxOutputTokens:options.maxOutputTokens}:{}),
    ...(options?.thinkingLevel?{thinkingConfig:{thinkingLevel:options.thinkingLevel}}:{})
  };
}


// Compatibility path when structured-output settings return HTTP 400.
// Validation remains mandatory after generation (Evidence v2 / Dossier v3).
// Never send generationConfig.responseFormat in this mode.
export function wGeminiPromptJsonConfig(options?:{
  maxOutputTokens?:number;thinkingLevel?:"minimal"|"low"|"medium"|"high"
}){
  return {
    ...(options?.maxOutputTokens?{maxOutputTokens:options.maxOutputTokens}:{}),
    ...(options?.thinkingLevel?{thinkingConfig:{thinkingLevel:options.thinkingLevel}}:{})
  };
}
export const W_GEMINI_JSON_ONLY_SUFFIX =
  "\n\nВерни РОВНО один JSON-объект согласно описанному контракту. "+
  "Без Markdown, без блоков кода, без объяснений до и после JSON. "+
  "Не придумывай ссылки на доказательства и не добавляй неподтверждённые элементы.";
export function parseModelJsonObject(content:string):any|null{
  let clean=String(content||"").trim();
  if(clean.length>2_000_000)return null;
  if(clean.startsWith("\x60\x60\x60")){
    clean=clean.replace(/^\x60+(?:json)?\s*/i,"").replace(/\s*\x60+$/,"").trim();
  }
  try{
    const value=JSON.parse(clean);
    return value&&typeof value==="object"&&!Array.isArray(value)?value:null;
  }catch{return null}
}
