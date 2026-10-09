import { useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { MONITOR_BOOKMARKLET, parseBrowserCapture } from "../browserImport";
import { exactCompressForProfile, type CompressionMode } from "../editorialCompression";
import { wEditorialMap, wEvidence, wStyleProfile, wSynthesize, type WDensity, type WEditorialMap, type WEditorialTrend, type WUsage } from "../wReviewAi";
import { useI18n } from "../i18n";

const W_CONTRACT_VERSION = 3;
const MAX_ITEMS = 20;
const MAX_SAMPLES = 5;

type WItem = {
  id: string; title: string; source: string; region: string; url: string;
  sourceText: string; editorialText: string; evidence: string; evidenceContract?: number;
};
type WSample = { id: string; name: string; text: string };
type WState = {
  items: WItem[];
  task: string;
  targetChars: number;
  model: "openai/gpt-oss-120b" | "openai/gpt-oss-20b";
  samples: WSample[];
  styleProfile: string;
  styleContract?: number;
  editorialMap: WEditorialMap | null;
  mapContract?: number;
  selectedTrendIds: string[];
  density: { quotes: WDensity; headlines: WDensity; experts: WDensity };
  reviewText: string;
};

const STORAGE_KEY = "monitor-w-review-v1";
const EMPTY: WState = {
  items: [], task: "", targetChars: 5000, model: "openai/gpt-oss-120b",
  samples: [], styleProfile: "", styleContract: 0, editorialMap: null, mapContract: 0,
  selectedTrendIds: [], density: { quotes: "moderate", headlines: "moderate", experts: "moderate" }, reviewText: "",
};

function id(prefix = "w") { return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`; }
function estimateTokens(chars: number) { return Math.max(0, Math.round(chars / 3.2)); }
function densityValue(value: unknown): WDensity { return value === "minimum" || value === "many" ? value : "moderate"; }

function loadState(): WState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as any;
    if (!raw) return EMPTY;
    const rawSamples = Array.isArray(raw.samples) ? raw.samples.slice(0, MAX_SAMPLES) : [];
    const samples: WSample[] = rawSamples.map((sample: any, index: number) =>
      typeof sample === "string"
        ? { id: id("sample"), name: `Образец ${index + 1}`, text: sample }
        : { id: String(sample?.id || id("sample")), name: String(sample?.name || `Образец ${index + 1}`), text: String(sample?.text || "") }
    ).filter((sample: WSample) => sample.text.trim());
    return {
      items: Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [],
      task: String(raw.task || "").slice(0, 500),
      targetChars: [3000, 5000, 8000, 12000].includes(Number(raw.targetChars)) ? Number(raw.targetChars) : 5000,
      model: raw.model === "openai/gpt-oss-20b" ? "openai/gpt-oss-20b" : "openai/gpt-oss-120b",
      samples,
      styleProfile: String(raw.styleProfile || "").slice(0, 10000),
      styleContract: Number(raw.styleContract || 0),
      editorialMap: raw.editorialMap && typeof raw.editorialMap === "object" ? raw.editorialMap as WEditorialMap : null,
      mapContract: Number(raw.mapContract || 0),
      selectedTrendIds: Array.isArray(raw.selectedTrendIds) ? raw.selectedTrendIds.map(String) : [],
      density: {
        quotes: densityValue(raw.density?.quotes),
        headlines: densityValue(raw.density?.headlines),
        experts: densityValue(raw.density?.experts),
      },
      reviewText: String(raw.reviewText || ""),
    };
  } catch { return EMPTY; }
}

export function WReviewView() {
  const { locale } = useI18n();
  const be = locale === "be";
  const [state, setState] = useState<WState>(loadState);
  const [activeId, setActiveId] = useState<string | null>(state.items[0]?.id ?? null);
  const [url, setUrl] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ title: "", source: "", region: "", url: "", text: "" });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [compressionMode, setCompressionMode] = useState<CompressionMode>("standard");
  const [usage, setUsage] = useState<WUsage>({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }, [state]);
  useEffect(() => { if (activeId && !state.items.some((item) => item.id === activeId)) setActiveId(state.items[0]?.id ?? null); }, [state.items, activeId]);

  const active = state.items.find((item) => item.id === activeId) ?? state.items[0] ?? null;
  const totalChars = useMemo(() => state.items.reduce((sum, item) => sum + item.editorialText.length, 0), [state.items]);
  const prepared = state.items.filter((item) => item.evidence.trim() && item.evidenceContract === W_CONTRACT_VERSION).length;
  const mapReady = Boolean(state.editorialMap?.trends?.length && state.mapContract === W_CONTRACT_VERSION);
  const selectedTrends = mapReady ? state.editorialMap!.trends.filter((trend) => state.selectedTrendIds.includes(trend.id)) : [];

  function invalidateMap(current: WState): WState {
    return { ...current, editorialMap: null, mapContract: 0, selectedTrendIds: [], reviewText: "" };
  }
  function addUsage(next: WUsage) {
    setUsage((current) => ({ promptTokens: current.promptTokens + next.promptTokens, completionTokens: current.completionTokens + next.completionTokens, totalTokens: current.totalTokens + next.totalTokens }));
  }
  function evidenceCards(items = state.items) {
    return items.map((item) => `ИСТОЧНИК: «${item.source}»\nЗАГОЛОВОК: ${item.title}\n${item.evidence}`);
  }

  function addItem(input: { title: string; source: string; region?: string; url?: string; text: string }) {
    if (state.items.length >= MAX_ITEMS) throw new Error("W_REVIEW_MAX_ITEMS");
    const text = input.text.trim();
    if (!input.title.trim() || !text) throw new Error("W_REVIEW_ITEM_REQUIRED");
    const next: WItem = { id: id(), title: input.title.trim(), source: input.source.trim() || "Источник", region: input.region?.trim() || "", url: input.url?.trim() || "", sourceText: text, editorialText: text, evidence: "", evidenceContract: 0 };
    setState((current) => invalidateMap({ ...current, items: [...current.items, next] }));
    setActiveId(next.id);
  }

  async function importUrl() {
    if (!url.trim() || state.items.length >= MAX_ITEMS) return;
    setBusy("url"); setError(""); setMessage("");
    try {
      const result = await desktopApi.fetchKnownSourceArticle(url.trim());
      addItem({ title: result.title, source: result.source, region: result.region || "", url: result.url, text: result.text });
      setUrl(""); setMessage(be ? "Матэрыял дададзены ў пул." : "Материал добавлен в пул.");
    } catch {
      try { await desktopApi.openUrl(url.trim()); } catch { /* best effort */ }
      setError(be ? "Прамая загрузка не ўдалася. Адкрыйце матэрыял у браўзеры, націсніце «→ Monitor», затым «Уставіць з браўзера»." : "Прямая загрузка не удалась. Откройте материал в браузере, нажмите «→ Monitor», затем «Вставить из браузера».");
    } finally { setBusy(""); }
  }

  async function pasteBrowser() {
    if (state.items.length >= MAX_ITEMS) return;
    setBusy("clipboard"); setError(""); setMessage("");
    try {
      const raw = await desktopApi.readClipboardText();
      const capture = parseBrowserCapture(raw);
      let source = capture.siteName || new URL(capture.url).hostname.replace(/^www\./, "");
      let region = /(?:^|\.)by$/i.test(new URL(capture.url).hostname) ? "Беларусь" : "";
      try { const resolved = await desktopApi.resolveKnownSource(capture.url); source = resolved.source || source; region = resolved.region || region; } catch { /* arbitrary source */ }
      addItem({ title: capture.title || source, source, region, url: capture.url, text: capture.text });
      setMessage(be ? "Старонка з браўзера дададзена ў пул." : "Страница из браузера добавлена в пул.");
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function copyBookmarklet() {
    await desktopApi.writeClipboardText(MONITOR_BOOKMARKLET);
    setMessage(be ? "Код закладкі скапіяваны." : "Код закладки скопирован.");
  }

  function updateItem(itemId: string, patch: Partial<WItem>) {
    setState((current) => {
      const edited = patch.editorialText !== undefined;
      const items = current.items.map((item) => item.id === itemId ? { ...item, ...patch, evidence: edited ? "" : item.evidence, evidenceContract: edited ? 0 : item.evidenceContract } : item);
      return edited ? invalidateMap({ ...current, items }) : { ...current, items };
    });
  }

  function exact() {
    if (!active) return;
    const result = exactCompressForProfile(active.editorialText, compressionMode, "l");
    updateItem(active.id, { editorialText: result.text });
    setMessage(`${be ? "Exact-скарачэнне" : "Exact-сокращение"}: ${result.reductionPct}%.`);
  }

  async function prepareEvidence() {
    if (!state.items.length) return;
    setBusy("evidence"); setError(""); setMessage("");
    try {
      let total: WUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const next = [...state.items];
      for (let i = 0; i < next.length; i += 1) {
        if (next[i].evidence.trim() && next[i].evidenceContract === W_CONTRACT_VERSION) continue;
        if (next[i].editorialText.length > 24000) throw new Error(`Материал ${i + 1} длиннее 24 000 знаков. Сократите его Exact или вручную.`);
        const result = await wEvidence({ title: next[i].title, source: next[i].source, text: next[i].editorialText });
        next[i] = { ...next[i], evidence: result.evidence, evidenceContract: W_CONTRACT_VERSION };
        total = { promptTokens: total.promptTokens + result.usage.promptTokens, completionTokens: total.completionTokens + result.usage.completionTokens, totalTokens: total.totalTokens + result.usage.totalTokens };
        setState((current) => invalidateMap({ ...current, items: [...next] }));
      }
      addUsage(total);
      setMessage(be ? "Evidence Cards падрыхтаваны. Цяпер вызначце тэндэнцыі." : "Evidence Cards подготовлены. Теперь выявите тенденции.");
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function buildEditorialMap() {
    if (!state.task.trim()) { setError(be ? "Спачатку задайце заданне." : "Сначала задайте задание."); return; }
    if (prepared !== state.items.length) { setError(be ? "Спачатку падрыхтуйце Evidence Cards." : "Сначала подготовьте Evidence Cards."); return; }
    setBusy("map"); setError(""); setMessage("");
    try {
      const result = await wEditorialMap({ task: state.task, evidenceCards: evidenceCards() });
      setState((current) => ({ ...current, editorialMap: result.editorialMap, mapContract: W_CONTRACT_VERSION, selectedTrendIds: result.editorialMap.trends.map((trend: WEditorialTrend) => trend.id), reviewText: "" }));
      addUsage(result.usage);
      setMessage(be ? "Тэндэнцыі выяўлены. Праверце, ці ўсе яны патрэбныя ў аглядзе." : "Тенденции выявлены. Проверьте, все ли они нужны в обзоре.");
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function importSamples() {
    if (state.samples.length >= MAX_SAMPLES) return;
    const selected = await open({ multiple: true, directory: false, title: be ? "Выберыце ўзоры W-Review" : "Выберите образцы W-Review", filters: [{ name: "Образцы", extensions: ["docx", "txt"] }] });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setBusy("sample"); setError(""); setMessage("");
    try {
      const room = MAX_SAMPLES - state.samples.length;
      const added: WSample[] = [];
      for (const path of paths.slice(0, room)) {
        const text = await desktopApi.extractWReviewSample(path);
        const name = path.split(/[\\/]/).pop() || `Образец ${state.samples.length + added.length + 1}`;
        added.push({ id: id("sample"), name, text });
      }
      setState((current) => ({ ...current, samples: [...current.samples, ...added].slice(0, MAX_SAMPLES), styleContract: 0, reviewText: "" }));
      setMessage(be ? `Дададзена ўзораў: ${added.length}. Абнавіце Style Profile.` : `Добавлено образцов: ${added.length}. Обновите Style Profile.`);
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function buildStyleProfile() {
    const samples = state.samples.map((sample) => sample.text).filter((sample) => sample.trim());
    if (!samples.length) return;
    setBusy("style"); setError(""); setMessage("");
    try {
      const result = await wStyleProfile(samples);
      setState((current) => ({ ...current, styleProfile: result.styleProfile, styleContract: W_CONTRACT_VERSION, reviewText: "" }));
      addUsage(result.usage);
      setMessage(be ? "Style Profile v2 абноўлены." : "Style Profile v2 обновлён.");
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function synthesize() {
    if (!state.task.trim()) { setError(be ? "Спачатку задайце заданне." : "Сначала задайте задание."); return; }
    if (prepared !== state.items.length) { setError(be ? "Спачатку падрыхтуйце Evidence Cards." : "Сначала подготовьте Evidence Cards."); return; }
    if (!mapReady || !selectedTrends.length) { setError(be ? "Спачатку вызначце і пацвердзіце тэндэнцыі." : "Сначала выявите и подтвердите тенденции."); return; }
    setBusy("synthesize"); setError(""); setMessage("");
    try {
      const result = await wSynthesize({
        task: state.task, targetChars: state.targetChars, model: state.model,
        evidenceCards: evidenceCards(),
        styleProfile: state.styleContract === W_CONTRACT_VERSION ? state.styleProfile : "",
        trends: selectedTrends, density: state.density,
      });
      setState((current) => ({ ...current, reviewText: result.reviewText }));
      addUsage(result.usage);
      setMessage(be ? "Агляд сфарміраваны." : "Обзор сформирован.");
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function exportDocx() {
    if (!state.reviewText.trim()) return;
    const path = await save({ title: "W-Review DOCX", defaultPath: "W-Review.docx", filters: [{ name: "Word", extensions: ["docx"] }] });
    if (!path) return;
    await desktopApi.exportWReview(path, state.reviewText.trim());
    setMessage(be ? "DOCX захаваны ў фармаце W-Review." : "DOCX сохранён в формате W-Review.");
  }

  const densityOptions = <><option value="minimum">{be ? "мінімум" : "минимум"}</option><option value="moderate">{be ? "умерана" : "умеренно"}</option><option value="many">{be ? "многа" : "много"}</option></>;

  return <div className="view-stack w-review">
    <section className="view-heading"><div><div className="eyebrow dark">W-REVIEW</div><h2>{be ? "Рабочы агляд па адвольным сюжэце" : "Рабочий обзор по произвольному сюжету"}</h2><p>{be ? "Збярыце да 20 публікацый і сфарміруйце абагульнены погляд на медыяполе." : "Соберите до 20 публикаций и сформируйте обобщённый взгляд на медиаполе."}</p></div><div className="w-review-metrics"><b>{state.items.length}/{MAX_ITEMS}</b><span>~{estimateTokens(totalChars).toLocaleString()} input tokens</span></div></section>
    {message && <div className="notice success">{message}</div>}{error && <div className="notice error">{error}</div>}

    <section className="panel w-review-import"><div className="panel-head"><div><h3>{be ? "Дадаць матэрыялы" : "Добавить материалы"}</h3><p>{be ? "Прамая загрузка, закладка → Monitor або ручны ўвод." : "Прямая загрузка, закладка → Monitor или ручной ввод."}</p></div></div>
      <div className="w-review-import-row"><input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://…" /><button className="secondary-button" onClick={importUrl} disabled={busy!==""||!url.trim()||state.items.length>=MAX_ITEMS}>{busy==="url"?"…":be?"Спампаваць":"Скачать"}</button><button className="primary-button" onClick={pasteBrowser} disabled={busy!==""||state.items.length>=MAX_ITEMS}>{busy==="clipboard"?"…":be?"Уставіць з браўзера":"Вставить из браузера"}</button><button className="ghost-button" onClick={()=>setManualOpen((v)=>!v)}>{be?"Дадаць уручную":"Добавить вручную"}</button><button className="ghost-button" onClick={copyBookmarklet}>→ Monitor</button></div>
      {manualOpen&&<div className="w-review-manual"><input placeholder={be?"Загаловак":"Заголовок"} value={manual.title} onChange={(e)=>setManual({...manual,title:e.target.value})}/><input placeholder={be?"Крыніца":"Источник"} value={manual.source} onChange={(e)=>setManual({...manual,source:e.target.value})}/><input placeholder={be?"Краіна / рэгіён":"Страна / регион"} value={manual.region} onChange={(e)=>setManual({...manual,region:e.target.value})}/><input placeholder="URL" value={manual.url} onChange={(e)=>setManual({...manual,url:e.target.value})}/><textarea placeholder={be?"Тэкст публікацыі":"Текст публикации"} value={manual.text} onChange={(e)=>setManual({...manual,text:e.target.value})}/><button className="primary-button" onClick={()=>{try{addItem(manual);setManual({title:"",source:"",region:"",url:"",text:""});setManualOpen(false)}catch(reason){setError(String(reason))}}}>{be?"Дадаць":"Добавить"}</button></div>}
    </section>

    <section className="w-review-grid">
      <aside className="panel w-review-pool"><div className="panel-head"><div><h3>{be?"Пул матэрыялаў":"Пул материалов"}</h3><p>{prepared}/{state.items.length} Evidence Cards</p></div></div>{state.items.length===0?<p className="muted">{be?"Пакуль пуста.":"Пока пусто."}</p>:state.items.map((item,index)=><button key={item.id} className={`w-review-item ${active?.id===item.id?"active":""}`} onClick={()=>setActiveId(item.id)}><span>P{String(index+1).padStart(2,"0")}</span><div><b>{item.title}</b><small>{item.source}{item.evidence&&item.evidenceContract===W_CONTRACT_VERSION?" · ✓ Evidence":item.evidence?" · ↻ Evidence":""}</small></div></button>)}</aside>
      <div className="panel w-review-editor">{active?<><div className="panel-head"><div><h3>{active.title}</h3><p>{active.source}{active.region?` · ${active.region}`:""}</p></div><button className="ghost-button small-button" onClick={()=>setState((current)=>invalidateMap({...current,items:current.items.filter((item)=>item.id!==active.id)}))}>{be?"Выдаліць":"Удалить"}</button></div><div className="w-review-exact"><select value={compressionMode} onChange={(e)=>setCompressionMode(e.target.value as CompressionMode)}><option value="light">20–30%</option><option value="standard">30–50%</option><option value="maximum">50–70%</option><option value="extract">70–90%</option></select><button className="secondary-button small-button" onClick={exact}>Exact</button><button className="ghost-button small-button" onClick={()=>updateItem(active.id,{editorialText:active.sourceText})}>{be?"Вярнуць зыходны":"Вернуть исходный"}</button></div><textarea className="report-editor-textarea" lang={be?"be":"ru"} spellCheck={true} value={active.editorialText} onChange={(e)=>updateItem(active.id,{editorialText:e.target.value})}/>{active.evidence&&<details className="w-review-evidence"><summary>Evidence Card{active.evidenceContract===W_CONTRACT_VERSION?"":" · требуется обновить"}</summary><p>{active.evidence}</p></details>}</>:<div className="report-empty">{be?"Выберыце матэрыял.":"Выберите материал."}</div>}</div>
    </section>

    <section className="panel w-review-task"><div className="panel-head"><div><h3>{be?"Заданне і параметры":"Задание и параметры"}</h3><p>{be?"Заданне да 500 знакаў.":"Задание до 500 знаков."}</p></div></div><textarea maxLength={500} value={state.task} onChange={(e)=>setState((current)=>invalidateMap({...current,task:e.target.value}))} placeholder={be?"Што прааналізаваць і на чым зрабіць акцэнт…":"Что проанализировать и на чем сделать акцент…"}/><div className="w-review-controls"><span>{state.task.length}/500</span><label>{be?"Аб'ём":"Объём"}<select value={state.targetChars} onChange={(e)=>setState({...state,targetChars:Number(e.target.value),reviewText:""})}><option value={3000}>3 000</option><option value={5000}>5 000</option><option value={8000}>8 000</option><option value={12000}>12 000</option></select></label><label>{be?"Мадэль":"Модель"}<select value={state.model} onChange={(e)=>setState({...state,model:e.target.value as WState["model"],reviewText:""})}><option value="openai/gpt-oss-120b">GPT-OSS 120B</option><option value="openai/gpt-oss-20b">GPT-OSS 20B</option></select></label><button className="secondary-button" disabled={busy!==""||!state.items.length} onClick={prepareEvidence}>{busy==="evidence"?"…":be?"Падрыхтаваць Evidence":"Подготовить Evidence"}</button><button className="primary-button" disabled={busy!==""||prepared!==state.items.length||!state.task.trim()} onClick={buildEditorialMap}>{busy==="map"?"…":be?"Вызначыць тэндэнцыі":"Выявить тенденции"}</button></div></section>

    {mapReady&&state.editorialMap&&<section className="panel w-review-map"><div className="panel-head"><div><h3>{be?"Тэндэнцыі медыяполя":"Тенденции медиаполя"}</h3><p>{be?"Пакіньце адзначанымі тыя акцэнты, якія павінны сфармаваць каркас агляду." : "Оставьте отмеченными те акценты, которые должны сформировать каркас обзора."}</p></div><button className="ghost-button small-button" disabled={busy!==""} onClick={buildEditorialMap}>{be?"Пералічыць":"Пересчитать"}</button></div>
      <div className="w-review-trends">{state.editorialMap.trends.map((trend,index)=><label key={trend.id} className={`w-review-trend ${state.selectedTrendIds.includes(trend.id)?"selected":""}`}><input type="checkbox" checked={state.selectedTrendIds.includes(trend.id)} onChange={()=>setState((current)=>({...current,selectedTrendIds:current.selectedTrendIds.includes(trend.id)?current.selectedTrendIds.filter((value)=>value!==trend.id):[...current.selectedTrendIds,trend.id],reviewText:""}))}/><span><b>{index+1}. {trend.title}</b><small>{trend.summary}</small>{trend.sources.length>0&&<em>{trend.sources.map((source)=>`«${source.replace(/^«|»$/g,"")}»`).join(", ")}</em>}</span></label>)}</div>
      <div className="w-review-density">
        <label><span>{be?"Цытаты":"Цитаты"} <small>{be?"знойдзена":"найдено"} {state.editorialMap.inventory.quotes}</small></span><select value={state.density.quotes} onChange={(e)=>setState({...state,density:{...state.density,quotes:e.target.value as WDensity},reviewText:""})}>{densityOptions}</select></label>
        <label><span>{be?"Загалоўкі":"Заголовки"} <small>{be?"знойдзена":"найдено"} {state.editorialMap.inventory.headlines}</small></span><select value={state.density.headlines} onChange={(e)=>setState({...state,density:{...state.density,headlines:e.target.value as WDensity},reviewText:""})}>{densityOptions}</select></label>
        <label><span>{be?"Эксперты":"Эксперты"} <small>{be?"знойдзена":"найдено"} {state.editorialMap.inventory.experts}</small></span><select value={state.density.experts} onChange={(e)=>setState({...state,density:{...state.density,experts:e.target.value as WDensity},reviewText:""})}>{densityOptions}</select></label>
      </div>
    </section>}

    <section className="panel w-review-style"><div className="panel-head"><div><h3>{be?"Узоры стылю":"Образцы стиля"}</h3><p>{be?"Да 5 DOCX/TXT. Файлы выкарыстоўваюцца толькі для пабудовы Style Profile v2." : "До 5 DOCX/TXT. Файлы используются только для построения Style Profile v2."}</p></div><span className="badge">{state.samples.length}/{MAX_SAMPLES}</span></div>
      <div className="w-review-controls"><button className="secondary-button" disabled={busy!==""||state.samples.length>=MAX_SAMPLES} onClick={importSamples}>{busy==="sample"?"…":be?"Дадаць DOCX/TXT":"Добавить DOCX/TXT"}</button><button className="primary-button" disabled={busy!==""||!state.samples.length} onClick={buildStyleProfile}>{busy==="style"?"…":be?"Абнавіць Style Profile":"Обновить Style Profile"}</button></div>
      {state.samples.length>0&&<div className="w-review-samples">{state.samples.map((sample)=><div key={sample.id}><span>{sample.name}</span><button className="ghost-button small-button" onClick={()=>setState((current)=>({...current,samples:current.samples.filter((item)=>item.id!==sample.id),styleContract:0,reviewText:""}))}>×</button></div>)}</div>}
      {state.styleProfile&&<details className="w-review-evidence"><summary>Style Profile v2{state.styleContract===W_CONTRACT_VERSION?"":" · требуется обновить"}</summary><p>{state.styleProfile}</p></details>}
    </section>

    <section className="panel w-review-final"><div className="panel-head"><div><h3>{be?"Выніковы агляд":"Итоговый обзор"}</h3><p>{be?"Тэкст будуецца па пацверджаных тэндэнцыях, а не па парадку крыніц." : "Текст строится по подтверждённым тенденциям, а не по порядку источников."}</p></div><div className="w-review-controls"><button className="primary-button" disabled={busy!==""||!mapReady||!selectedTrends.length||!state.task.trim()} onClick={synthesize}>{busy==="synthesize"?"…":be?"Сфарміраваць агляд":"Сформировать обзор"}</button><button className="secondary-button" disabled={!state.reviewText.trim()} onClick={exportDocx}>DOCX</button></div></div><textarea className="report-editor-textarea w-review-final-text" lang={be?"be":"ru"} spellCheck={true} value={state.reviewText} onChange={(e)=>setState({...state,reviewText:e.target.value})} placeholder={be?"Тут з'явіцца выніковы агляд…":"Здесь появится итоговый обзор…"}/><div className="w-review-usage">{be?"Сімвалаў":"Символов"}: {state.reviewText.length.toLocaleString()} · {be?"Выкарыстана токенаў у гэтай сесіі":"Использовано токенов в этой сессии"}: {usage.totalTokens.toLocaleString()}</div></section>
  </div>;
}
