// W-Review operator-only editorial reallocation.
// Technical review queues are NOT trends and should never become a separate
// synthesis section. Moves ONLY already verified Evidence IDs. No model calls.
import type {WEditorialMap,WEditorialBranch,WEditorialTrend} from "./wReviewAi";

export function isTechnicalReviewQueue(t:WEditorialTrend):boolean {
  return t.operator_optional===true &&
    (t.technical_review_queue===true ||
      /^Публикации для редакционного распределения(?: — часть \d+)?$/.test(t.title));
}

const publicationFromRef=(ref:string)=>ref.match(/^(P\d{2}):E\d{2,3}$/)?.[1]||"";

export function pendingEditorialAssignments(map:WEditorialMap | null):{
  publicationId:string;queueTrendId:string;queueBranchId:string;
  claim:string;evidenceIds:string[];
}[]{
  if(!map)return [];
  return map.trends.filter(isTechnicalReviewQueue).flatMap(t=>
    t.branches.flatMap(b=>{
      const ids=[...new Set([...b.evidence_ids,...b.contrary_evidence_ids])];
      const pubs=[...new Set(ids.map(publicationFromRef).filter(Boolean))];
      // A technical branch with mixed publisher references is not safe for
      // one-click editing: do not make a silent attribution guess.
      return pubs.length===1?[{
        publicationId:pubs[0],queueTrendId:t.id,queueBranchId:b.id,
        claim:b.claim,evidenceIds:ids
      }]:[];
    }));
}

export function availableEditorialTargets(map:WEditorialMap | null):{
  trendId:string;trendTitle:string;branchId:string;branchTitle:string;
}[]{
  if(!map)return [];
  return map.trends.filter(t=>!isTechnicalReviewQueue(t)).flatMap(t=>
    t.branches.filter(b=>b.evidence_ids.length<18).map(b=>({
      trendId:t.id,trendTitle:t.title,branchId:b.id,branchTitle:b.title
    })));
}

export function assignQueuedPublication(
  map:WEditorialMap,publicationId:string,targetBranchId:string
):WEditorialMap{
  const pending=pendingEditorialAssignments(map).find(p=>p.publicationId===publicationId);
  if(!pending)throw new Error("Публикация не находится в очереди распределения.");
  const owner=map.trends.find(t=>t.id===pending.queueTrendId);
  const matching=owner?.branches.find(b=>b.id===pending.queueBranchId);
  if(!owner||!matching)throw new Error("Техническая очередь изменилась.");
  if(pending.evidenceIds.some(id=>publicationFromRef(id)!==publicationId))
    throw new Error("Обнаружена смешанная атрибуция Evidence.");
  const targetTrend=map.trends.find(t=>!isTechnicalReviewQueue(t)&&t.branches.some(b=>b.id===targetBranchId));
  const target=targetTrend?.branches.find(b=>b.id===targetBranchId);
  if(!target||!targetTrend)throw new Error("Выберите содержательную сюжетную ветку.");
  const existing=new Set(target.evidence_ids);
  const additional=pending.evidenceIds.filter(id=>!existing.has(id));
  if(!additional.length)throw new Error("Эта публикация уже представлена в выбранной ветке.");
  if(existing.size+additional.length>18)throw new Error(
    "В выбранной ветке достигнут лимит Evidence (18); выберите другую.");
  const trends=map.trends.flatMap(t=>{
    if(t.id===owner.id){
      const left=t.branches.filter(b=>b.id!==matching.id);
      return left.length?[{...t,branches:left}]:[];
    }
    if(t.id===targetTrend.id){
      return [{
        ...t,
        branches:t.branches.map(b=>b.id===targetBranchId?
          {...b,evidence_ids:[...b.evidence_ids,...additional]}:b),
        sources:[...new Set(t.sources.concat(owner.sources))]
      }];
    }
    return [t];
  });
  const coverage=map.coverage.map(c=>c.publication_id===publicationId?{
    ...c,status:"supporting" as const,
    reason:"Оператор распределил публикацию в содержательную сюжетную ветку «"+
      target.title+"» на основании ранее проверенных Evidence.",
    evidence_ids:[...new Set(c.evidence_ids.concat(pending.evidenceIds))]
  }:c);
  return {...map,trends,coverage};
}
