// One display story per source-independent event; source URLs and identities remain distinct.
type Card={publication?:{title?:string;excerpt?:string;published_at?:string};event?:Record<string,unknown>;provenance?:{title_original?:string};source?:{name?:string}};
const norm=(s:string)=>s.toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function storyType(card:Card):string|null {
 const headline=norm(String(card.publication?.title||''));
 const s=norm([card.publication?.title,card.publication?.excerpt].filter(Boolean).join(' '));
 // One Le Point-related news day produced many publisher reports and syndicated
 // mirrors. Keep the proposal and Zelensky's answer as DIFFERENT stories.
 if(/зеленск/.test(headline)&&/лукаш/.test(s)&&
   /(?:ответ|отверг|отказ|высме|несерьезн|чемодан|путина? в киев|путин.*киев)/.test(headline))
   return 'zelensky-response-to-lukashenko-flight-offer';
 if(/лукаш/.test(s)&&/зеленск/.test(s)&&/(?:москв|путин|гарант.*безопас)/.test(s)&&
   /(?:предлож|сопров|гарант.*безопас|вместе.*полет|лететь вместе|прилететь.*москв|отвез|взять.*самолет|встретиться.*(?:москв|зеленск))/.test(headline))
   return 'lukashenko-offer-to-accompany-zelensky-to-moscow';
 if(/лукаш/.test(headline)&&/европ/.test(headline)&&/участи/.test(headline)&&
   /переговор/.test(headline)&&/прогресс/.test(headline))
   return 'lukashenko-europe-participation-in-ukraine-negotiations';
 if(/(?:конкурир|дублиру|дуплиру|защит[а-я]* общ[а-я]* рынк|защит[а-я]* союзн[а-я]* рынк|заштит[а-я]* заједничк)/.test(s)&&/(?:предприяти|производств|рынк|тржишт)/.test(s)&&/(?:лукаш|беларус|белорус|росси)/.test(s))return 'russia-belarus-noncompeting-manufacturing';
 if(/(?:си цзиньпин|по китайски|китайск[а-я]* опыт|опыт китая|xi jinping)/.test(s)&&/(?:совет|опыт|развит|совершенств|сохран)/.test(s))return 'xi-development-advice';
 if(/(?:драгметалл|драгоценн[а-я]* металл|драгоценн[а-я]* камн)/.test(s)&&/(?:поправк|соглашен|одобр)/.test(s))return 'precious-metals-agreement';
 if(/омск/.test(s)&&/(?:посольств|представительств)/.test(s)&&/(?:беларус|белорус)/.test(s))return 'omsk-belarus-diplomatic-office';
 return null;
}
export function groupStoryCards<T extends Card>(cards:T[]):T[] {
 const result=cards.map(card=>({...card,event:{...card.event}}));
 const buckets=new Map<string,number[]>();
 for(let i=0;i<result.length;i++){
  const card=result[i],day=String(card.publication?.published_at||'').slice(0,10);
  if(!/^20\d\d-\d\d-\d\d$/.test(day))continue;
  const type=storyType(card);
  const headline=norm(String(card.provenance?.title_original||card.publication?.title||''));
  const key=type?day+':topic:'+type:headline.length>=28?day+':headline:'+headline:null;
  if(!key)continue;
  const group=buckets.get(key)||[];group.push(i);buckets.set(key,group);
 }
 for(const [key,indexes] of buckets){
  // Named, fact-specific keys are stable across overlapping daily runs even
  // when one run sees only one outlet; generic same-headline groups need 2+.
  if(indexes.length<2&&!key.includes(':topic:'))continue;
  const signature='lnews:'+key;
  const label=String(result[indexes[0]].publication?.title||'').slice(0,280);
  for(const index of indexes)result[index]={...result[index],event:{...result[index].event,signature,object:label}};
 }
 return result as T[];
}
