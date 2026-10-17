// Deterministic W-Review author-style sampling.
// STYLE_ONLY contains no factual evidence about the current news topic.
export type WAuthorSample = {name:string;text:string};
export type WStyleRole = "opening"|"development"|"comparison"|"ending";
export type WStyleExcerpt = {name:string;role:WStyleRole;text:string};
export type WStylePattern = {sampleCount:number;paragraphCount:number;medianParagraphChars:number;
  openingMedianChars:number;endingMedianChars:number;shortParagraphPct:number;
  attributionParagraphPct:number;comparisonParagraphPct:number;excerpts:WStyleExcerpt[]};
const MAX_EXCERPT_CHARS=1250;
const MAX_TOTAL_CHARS=7200;
const MAX_EXCERPTS=12;
const patterns={
  comparison:/(?:однако|впрочем|между тем|в отличие|в то же время|вместе с тем|при этом|с другой стороны|напротив|в сравнении|тогда как|в противоположность)/iu,
  attribution:/«[^»]{2,110}»|\b(?:Reuters|Bloomberg|BBC|CNN|Financial Times|The Guardian|Associated Press|NYT)\b/iu
};
const median=(items:number[])=>{
  if(!items.length)return 0;
  const sorted=[...items].sort((a,b)=>a-b),n=sorted.length;
  return n%2?sorted[(n-1)/2]:Math.round((sorted[n/2-1]+sorted[n/2])/2);
};
function paragraphs(text:string):string[]{
  const clean=text.replace(/\r\n?/g,"\n").replace(/\u00a0/g," ").trim();
  if(!clean)return [];
  let pieces=clean.split(/\n\s*\n/).map(p=>p.replace(/\s+/g," ").trim()).filter(Boolean);
  // DOCX joins paragraphs using blank lines; TXT may use single line breaks.
  if(pieces.length<2&&clean.split("\n").filter(p=>p.trim()).length>=3)
    pieces=clean.split(/\n+/).map(p=>p.replace(/\s+/g," ").trim()).filter(Boolean);
  return pieces.filter(p=>p.length>=30);
}
function consecutive(paras:string[],start:number):string{
  const first=paras[start]||"";
  if(first.length<90||first.length>MAX_EXCERPT_CHARS)return "";
  const next=paras[start+1]||"";
  if(next&&next.length>=30&&first.length+next.length+2<=MAX_EXCERPT_CHARS)
    return first+"\n\n"+next;
  return first;
}
function ending(paras:string[]):string{
  const last=paras.at(-1)||"";
  if(last.length<90||last.length>MAX_EXCERPT_CHARS)return "";
  const before=paras.at(-2)||"";
  return before.length>=30&&before.length+last.length+2<=MAX_EXCERPT_CHARS
    ?before+"\n\n"+last:last;
}
function comparison(paras:string[]):string{
  if(paras.length<3)return "";
  const starts=paras.map((_,i)=>i).filter(i=>i>0&&i<paras.length-1);
  const ranked=starts.map(i=>({
    i,score:(patterns.comparison.test(paras[i])?3:0)+
      (patterns.attribution.test(paras[i])?2:0)+
      (patterns.comparison.test(paras[i+1]||"")?2:0)+
      (patterns.attribution.test(paras[i+1]||"")?1:0)
  })).sort((a,b)=>b.score-a.score||a.i-b.i);
  for(const candidate of ranked){
    if(candidate.score<2)break;
    const piece=consecutive(paras,candidate.i);
    if(piece)return piece;
  }
  return "";
}
function development(paras:string[]):string{
  if(paras.length<3)return "";
  const center=Math.floor((paras.length-1)/2);
  for(const i of [center,center-1,center+1]){
    if(i>0&&i<paras.length-1){
      const piece=consecutive(paras,i);
      if(piece)return piece;
    }
  }
  return "";
}
export function selectStyleExcerpts(samples:WAuthorSample[]):WStyleExcerpt[]{
  const source=samples.slice(0,5).map(s=>({
    name:s.name.slice(0,120),paras:paragraphs(s.text)
  })).filter(s=>s.paras.length>=2);
  const stages:WStyleRole[]=["opening","comparison","development","ending"];
  // Round-robin: every usable sample contributes before any second selection.
  const candidateBatches=source.map((sample,index)=>{
    const available:WStyleExcerpt[]=[];
    const variants:{role:WStyleRole;text:string}[]=[
      {role:"opening",text:consecutive(sample.paras,0)},
      {role:"comparison",text:comparison(sample.paras)},
      {role:"development",text:development(sample.paras)},
      {role:"ending",text:ending(sample.paras)}
    ];
    const preferred=stages[(index%4)];
    const order=[preferred,...stages.filter(role=>role!==preferred)];
    for(const role of order){
      const text=variants.find(v=>v.role===role)?.text||"";
      if(text&&text.length>=90&&!available.some(e=>e.text===text))
        available.push({name:sample.name,role,text});
    }
    return available;
  });
  const selected:WStyleExcerpt[]=[];
  const used=new Set<string>();
  let budget=MAX_TOTAL_CHARS;
  const maxDepth=Math.max(0,...candidateBatches.map(x=>x.length));
  for(let depth=0;depth<maxDepth;depth++){
    for(let i=0;i<candidateBatches.length;i++){
      const candidate=candidateBatches[i][depth];
      if(!candidate||selected.length>=MAX_EXCERPTS)continue;
      const identity=candidate.name+"|"+candidate.text;
      if(used.has(identity)||candidate.text.length>budget)continue;
      // Deliberately never truncate an author paragraph.
      selected.push(candidate);
      used.add(identity);
      budget-=candidate.text.length;
    }
  }
  return selected;
}
export function buildStylePattern(samples:WAuthorSample[]):WStylePattern{
  const sources=samples.slice(0,5).map(s=>paragraphs(s.text)).filter(p=>p.length>=2);
  const all=sources.flat(),openings=sources.map(p=>p[0].length),
    endings=sources.map(p=>p[p.length-1].length);
  const pct=(n:number)=>all.length?Math.round(n*100/all.length):0;
  return {sampleCount:sources.length,paragraphCount:all.length,
    medianParagraphChars:median(all.map(p=>p.length)),
    openingMedianChars:median(openings),endingMedianChars:median(endings),
    shortParagraphPct:pct(all.filter(p=>p.length<230).length),
    attributionParagraphPct:pct(all.filter(p=>patterns.attribution.test(p)).length),
    comparisonParagraphPct:pct(all.filter(p=>patterns.comparison.test(p)).length),
    excerpts:selectStyleExcerpts(samples)};
}
