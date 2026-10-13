export type TikTokCapturedComment = {
  text: string;
  likes: number;
  order: number;
};

type TikTokCommentsEnvelope = {
  monitor: number;
  kind: string;
  version?: number;
  url: string;
  capturedAt?: string;
  comments: TikTokCapturedComment[];
};

function compact(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function isUsefulTikTokComment(value: string) {
  const text = compact(value);
  if (text.length <= 15) return false;
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return letters >= 5;
}

export const TIKTOK_COMMENTS_BOOKMARKLET = `javascript:(async()=>{try{
const compact=s=>(s||'').replace(/\\s+/g,' ').trim();
const nodes=[...document.querySelectorAll('[data-e2e="comment-level-1"],p[data-e2e="comment-level-1"],span[data-e2e="comment-level-1"]')];
const seen=new Set(),comments=[];
const num=s=>{s=compact(s).replace(/,/g,'.').toLowerCase();const m=s.match(/([0-9]+(?:\\.[0-9]+)?)([kmкм]?)/i);if(!m)return 0;let n=parseFloat(m[1]);const u=m[2];if(u==='k'||u==='к')n*=1000;if(u==='m'||u==='м')n*=1000000;return Math.round(n)};
for(const node of nodes){
 const text=compact(node.textContent);
 const letters=(text.match(/[\\p{L}\\p{N}]/gu)||[]).length;
 if(text.length<=15||letters<5||seen.has(text))continue;
 let parent=node.closest('[data-e2e*="comment"],li,div');
 for(let i=0;i<2&&parent&&parent.parentElement;i++)parent=parent.parentElement;
 const likeNode=(parent||node.parentElement)?.querySelector?.('[data-e2e="comment-like-count"],[data-e2e*="like-count"],button[aria-label*="like" i] span');
 const likes=num(likeNode?.textContent||'');
 seen.add(text);comments.push({text,likes,order:comments.length});
 if(comments.length>=60)break;
}
const payload=JSON.stringify({monitor:2,kind:'tiktok-comments',version:1,url:location.href,capturedAt:new Date().toISOString(),comments});
let ok=false;try{await navigator.clipboard.writeText(payload);ok=true}catch(e){}
if(!ok){const t=document.createElement('textarea');t.value=payload;t.setAttribute('readonly','');t.style.cssText='position:fixed;left:-9999px;top:0;opacity:0';document.body.appendChild(t);t.focus();t.select();ok=document.execCommand('copy');t.remove()}
alert(ok?('Комментарии для Monitor: '+comments.length):'Не удалось скопировать комментарии');
}catch(e){alert('Monitor: '+(e&&e.message?e.message:e))}})()`;

export function parseTikTokCommentsCapture(raw: string): TikTokCommentsEnvelope {
  let value: unknown;
  try { value = JSON.parse(raw.trim()); } catch { throw new Error("TIKTOK_COMMENTS_CAPTURE_INVALID"); }
  if (!value || typeof value !== "object") throw new Error("TIKTOK_COMMENTS_CAPTURE_INVALID");
  const data = value as Partial<TikTokCommentsEnvelope>;
  if (data.monitor !== 2 || data.kind !== "tiktok-comments" || typeof data.url !== "string" || !Array.isArray(data.comments)) {
    throw new Error("TIKTOK_COMMENTS_CAPTURE_INVALID");
  }
  const comments = data.comments
    .map((item, index) => ({
      text: compact(String(item?.text || "")),
      likes: Math.max(0, Number(item?.likes || 0)),
      order: Number.isFinite(Number(item?.order)) ? Number(item?.order) : index,
    }))
    .filter((item) => isUsefulTikTokComment(item.text));
  return {
    monitor: 2,
    kind: "tiktok-comments",
    version: Number(data.version || 1),
    url: data.url,
    capturedAt: data.capturedAt ? String(data.capturedAt) : undefined,
    comments,
  };
}

/** Fallback for plain text copied from TikTok's visible comments list.
 * TikTok does not guarantee that text selections contain likes or all loaded comments.
 */
export function parseTikTokCommentsClipboard(raw: string): TikTokCapturedComment[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("{")) {
    try { return parseTikTokCommentsCapture(text).comments; } catch { /* plain text follows */ }
  }
  const lines = text.replace(/\r/g, "").split("\n").map(compact).filter(Boolean);
  const ignore = /^(?:Reply|Replies|View replies|View more replies|See more|Like|Liked|Share|Report|Translate|Follow|Following|Ответить|Ответы|Показать ответы|Посмотреть ответы|Нравится|Поделиться|Перевести|Подписаться|Еще|Ещё|Смотреть ещё|Показать больше|Показать перевод|Скрыть|Свернуть|автор|author|creator|·|•|❤|♥)$/i;
  const meta = /^(?:@?[\p{L}\p{N}_.-]{2,32}\s*[·•]\s*)?(?:(?:\d+\s*(?:[hdwmy]|[чднмг]|час(?:ов|а)?|дн(?:ей|я)?|недел[ьи]|минут(?:ы)?))|(?:\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?)|(?:\d+(?:[.,]\d+)?[KkMmКкМм]?)|(?:\d+\s*(?:likes?|лайк(?:ов|а)?)))$/iu;
  const results: TikTokCapturedComment[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (ignore.test(line) || meta.test(line) || /^@?[\p{L}\p{N}_.-]{2,32}$/u.test(line)) continue;
    if (!isUsefulTikTokComment(line)) continue;
    const normalized = line.toLocaleLowerCase("ru-RU");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    results.push({ text: line, likes: 0, order: results.length });
    if (results.length >= 60) break;
  }
  return results;
}
