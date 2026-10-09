import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { MONITOR_BOOKMARKLET, parseBrowserCapture } from "../browserImport";
import { exactCompressForProfile, type CompressionMode } from "../editorialCompression";
import { wEvidence, wStyleProfile, wSynthesize, type WUsage } from "../wReviewAi";
import { useI18n } from "../i18n";

type WItem = {
  id: string;
  title: string;
  source: string;
  region: string;
  url: string;
  sourceText: string;
  editorialText: string;
  evidence: string;
};

type WState = {
  items: WItem[];
  task: string;
  targetChars: number;
  model: "openai/gpt-oss-120b" | "openai/gpt-oss-20b";
  samples: string[];
  styleProfile: string;
  reviewText: string;
};

const STORAGE_KEY = "monitor-w-review-v1";
const MAX_ITEMS = 20;
const EMPTY: WState = { items: [], task: "", targetChars: 5000, model: "openai/gpt-oss-120b", samples: [], styleProfile: "", reviewText: "" };

function loadState(): WState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<WState> | null;
    if (!raw) return EMPTY;
    return {
      items: Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [],
      task: String(raw.task || "").slice(0, 500),
      targetChars: [3000, 5000, 8000, 12000].includes(Number(raw.targetChars)) ? Number(raw.targetChars) : 5000,
      model: raw.model === "openai/gpt-oss-20b" ? "openai/gpt-oss-20b" : "openai/gpt-oss-120b",
      samples: Array.isArray(raw.samples) ? raw.samples.map(String).slice(0, 5) : [],
      styleProfile: String(raw.styleProfile || "").slice(0, 6000),
      reviewText: String(raw.reviewText || ""),
    };
  } catch { return EMPTY; }
}

function id() { return `w:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`; }
function estimateTokens(chars: number) { return Math.max(0, Math.round(chars / 3.2)); }

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
  const [sampleText, setSampleText] = useState("");
  const [usage, setUsage] = useState<WUsage>({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }, [state]);
  useEffect(() => { if (activeId && !state.items.some((item) => item.id === activeId)) setActiveId(state.items[0]?.id ?? null); }, [state.items, activeId]);

  const active = state.items.find((item) => item.id === activeId) ?? state.items[0] ?? null;
  const totalChars = useMemo(() => state.items.reduce((sum, item) => sum + item.editorialText.length, 0), [state.items]);
  const prepared = state.items.filter((item) => item.evidence.trim()).length;

  function addItem(input: { title: string; source: string; region?: string; url?: string; text: string }) {
    if (state.items.length >= MAX_ITEMS) throw new Error("W_REVIEW_MAX_ITEMS");
    const text = input.text.trim();
    if (!input.title.trim() || !text) throw new Error("W_REVIEW_ITEM_REQUIRED");
    const next: WItem = { id: id(), title: input.title.trim(), source: input.source.trim() || "Источник", region: input.region?.trim() || "", url: input.url?.trim() || "", sourceText: text, editorialText: text, evidence: "" };
    setState((current) => ({ ...current, items: [...current.items, next], reviewText: "" }));
    setActiveId(next.id);
  }

  async function importUrl() {
    if (!url.trim() || state.items.length >= MAX_ITEMS) return;
    setBusy("url"); setError(""); setMessage("");
    try {
      const result = await desktopApi.fetchKnownSourceArticle(url.trim());
      addItem({ title: result.title, source: result.source, region: result.region || "", url: result.url, text: result.text });
      setUrl("");
      setMessage(be ? "Матэрыял дададзены ў пул." : "Материал добавлен в пул.");
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
      try {
        const resolved = await desktopApi.resolveKnownSource(capture.url);
        source = resolved.source || source;
        region = resolved.region || region;
      } catch { /* arbitrary sources are allowed */ }
      addItem({ title: capture.title || source, source, region, url: capture.url, text: capture.text });
      setMessage(be ? "Старонка з браўзера дададзена ў пул." : "Страница из браузера добавлена в пул.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  async function copyBookmarklet() {
    await desktopApi.writeClipboardText(MONITOR_BOOKMARKLET);
    setMessage(be ? "Код закладкі скапіяваны." : "Код закладки скопирован.");
  }

  function updateItem(itemId: string, patch: Partial<WItem>) {
    setState((current) => ({ ...current, items: current.items.map((item) => item.id === itemId ? { ...item, ...patch, evidence: patch.editorialText !== undefined ? "" : item.evidence } : item), reviewText: patch.editorialText !== undefined ? "" : current.reviewText }));
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
        if (next[i].evidence.trim()) continue;
        if (next[i].editorialText.length > 24000) throw new Error(`Материал ${i + 1} длиннее 24 000 знаков. Сократите его Exact или вручную.`);
        const result = await wEvidence({ title: next[i].title, source: next[i].source, text: next[i].editorialText });
        next[i] = { ...next[i], evidence: result.evidence };
        total = { promptTokens: total.promptTokens + result.usage.promptTokens, completionTokens: total.completionTokens + result.usage.completionTokens, totalTokens: total.totalTokens + result.usage.totalTokens };
        setState((current) => ({ ...current, items: [...next] }));
      }
      setUsage((current) => ({ promptTokens: current.promptTokens + total.promptTokens, completionTokens: current.completionTokens + total.completionTokens, totalTokens: current.totalTokens + total.totalTokens }));
      setMessage(be ? "Evidence Cards падрыхтаваны." : "Evidence Cards подготовлены.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  async function buildStyleProfile() {
    const samples = state.samples.filter((sample) => sample.trim());
    if (!samples.length) return;
    setBusy("style"); setError(""); setMessage("");
    try {
      const result = await wStyleProfile(samples);
      setState((current) => ({ ...current, styleProfile: result.styleProfile }));
      setUsage((current) => ({ promptTokens: current.promptTokens + result.usage.promptTokens, completionTokens: current.completionTokens + result.usage.completionTokens, totalTokens: current.totalTokens + result.usage.totalTokens }));
      setMessage(be ? "Профіль стылю абноўлены." : "Профиль стиля обновлён.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  async function synthesize() {
    if (!state.task.trim()) { setError(be ? "Спачатку задайце заданне." : "Сначала задайте задание."); return; }
    if (prepared !== state.items.length) { setError(be ? "Спачатку падрыхтуйце Evidence Cards для ўсіх матэрыялаў." : "Сначала подготовьте Evidence Cards для всех материалов."); return; }
    setBusy("synthesize"); setError(""); setMessage("");
    try {
      const result = await wSynthesize({ task: state.task, targetChars: state.targetChars, model: state.model, evidenceCards: state.items.map((item) => item.evidence), styleProfile: state.styleProfile });
      setState((current) => ({ ...current, reviewText: result.reviewText }));
      setUsage((current) => ({ promptTokens: current.promptTokens + result.usage.promptTokens, completionTokens: current.completionTokens + result.usage.completionTokens, totalTokens: current.totalTokens + result.usage.totalTokens }));
      setMessage(be ? "Агляд сфарміраваны." : "Обзор сформирован.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  async function exportDocx() {
    if (!state.reviewText.trim()) return;
    const path = await save({ title: "W-Review DOCX", defaultPath: "W-Review.docx", filters: [{ name: "Word", extensions: ["docx"] }] });
    if (!path) return;
    await desktopApi.exportReport(path, new Date().toISOString().slice(0, 10), [{ source: "W-Review", location: "", title: state.task.trim().slice(0, 180) || "W-Review", text: state.reviewText.trim(), url: "" }], "lukashenko");
    setMessage(be ? "DOCX захаваны. Гэта часовы нейтральны фармат да падключэння эталоннага шаблону." : "DOCX сохранён. Это временный нейтральный формат до подключения эталонного шаблона.");
  }

  return <div className="view-stack w-review">
    <section className="view-heading"><div><div className="eyebrow dark">W-REVIEW</div><h2>{be ? "Рабочы агляд па адвольным сюжэце" : "Рабочий обзор по произвольному сюжету"}</h2><p>{be ? "Збярыце да 20 публікацый, адрэдагуйце іх, падрыхтуйце доказныя карткі і сфарміруйце адзін аналітычны агляд." : "Соберите до 20 публикаций, отредактируйте их, подготовьте доказательные карточки и сформируйте единый аналитический обзор."}</p></div><div className="w-review-metrics"><b>{state.items.length}/{MAX_ITEMS}</b><span>~{estimateTokens(totalChars).toLocaleString()} input tokens</span></div></section>
    {message && <div className="notice success">{message}</div>}{error && <div className="notice error">{error}</div>}

    <section className="panel w-review-import"><div className="panel-head"><div><h3>{be ? "Дадаць матэрыялы" : "Добавить материалы"}</h3><p>{be ? "Прамая загрузка, закладка → Monitor або ручны ўвод." : "Прямая загрузка, закладка → Monitor или ручной ввод."}</p></div></div>
      <div className="w-review-import-row"><input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://…" /><button className="secondary-button" onClick={importUrl} disabled={busy!==""||!url.trim()||state.items.length>=MAX_ITEMS}>{busy==="url"?"…":be?"Спампаваць":"Скачать"}</button><button className="primary-button" onClick={pasteBrowser} disabled={busy!==""||state.items.length>=MAX_ITEMS}>{busy==="clipboard"?"…":be?"Уставіць з браўзера":"Вставить из браузера"}</button><button className="ghost-button" onClick={()=>setManualOpen((v)=>!v)}>{be?"Дадаць уручную":"Добавить вручную"}</button><button className="ghost-button" onClick={copyBookmarklet}>→ Monitor</button></div>
      {manualOpen&&<div className="w-review-manual"><input placeholder={be?"Загаловак":"Заголовок"} value={manual.title} onChange={(e)=>setManual({...manual,title:e.target.value})}/><input placeholder={be?"Крыніца":"Источник"} value={manual.source} onChange={(e)=>setManual({...manual,source:e.target.value})}/><input placeholder={be?"Краіна / рэгіён":"Страна / регион"} value={manual.region} onChange={(e)=>setManual({...manual,region:e.target.value})}/><input placeholder="URL" value={manual.url} onChange={(e)=>setManual({...manual,url:e.target.value})}/><textarea placeholder={be?"Тэкст публікацыі":"Текст публикации"} value={manual.text} onChange={(e)=>setManual({...manual,text:e.target.value})}/><button className="primary-button" onClick={()=>{try{addItem(manual);setManual({title:"",source:"",region:"",url:"",text:""});setManualOpen(false)}catch(reason){setError(String(reason))}}}>{be?"Дадаць":"Добавить"}</button></div>}
    </section>

    <section className="w-review-grid">
      <aside className="panel w-review-pool"><div className="panel-head"><div><h3>{be?"Пул матэрыялаў":"Пул материалов"}</h3><p>{prepared}/{state.items.length} Evidence Cards</p></div></div>{state.items.length===0?<p className="muted">{be?"Пакуль пуста.":"Пока пусто."}</p>:state.items.map((item,index)=><button key={item.id} className={`w-review-item ${active?.id===item.id?"active":""}`} onClick={()=>setActiveId(item.id)}><span>P{String(index+1).padStart(2,"0")}</span><div><b>{item.title}</b><small>{item.source}{item.evidence?" · ✓ Evidence":""}</small></div></button>)}</aside>
      <div className="panel w-review-editor">{active?<><div className="panel-head"><div><h3>{active.title}</h3><p>{active.source}{active.region?` · ${active.region}`:""}</p></div><button className="ghost-button small-button" onClick={()=>{setState((current)=>({...current,items:current.items.filter((item)=>item.id!==active.id),reviewText:""}));}}>{be?"Выдаліць":"Удалить"}</button></div><div className="w-review-exact"><select value={compressionMode} onChange={(e)=>setCompressionMode(e.target.value as CompressionMode)}><option value="light">20–30%</option><option value="standard">30–50%</option><option value="maximum">50–70%</option><option value="extract">70–90%</option></select><button className="secondary-button small-button" onClick={exact}>Exact</button><button className="ghost-button small-button" onClick={()=>updateItem(active.id,{editorialText:active.sourceText})}>{be?"Вярнуць зыходны":"Вернуть исходный"}</button></div><textarea className="report-editor-textarea" lang={be?"be":"ru"} spellCheck={true} value={active.editorialText} onChange={(e)=>updateItem(active.id,{editorialText:e.target.value})}/>{active.evidence&&<details className="w-review-evidence"><summary>Evidence Card</summary><p>{active.evidence}</p></details>}</>:<div className="report-empty">{be?"Выберыце матэрыял.":"Выберите материал."}</div>}</div>
    </section>

    <section className="panel w-review-task"><div className="panel-head"><div><h3>{be?"Заданне і параметры":"Задание и параметры"}</h3><p>{be?"Заданне да 500 знакаў; пастаянныя правілы захоўваюцца ў сістэмным кантракце." : "Задание до 500 знаков; постоянные правила хранятся в системном контракте."}</p></div></div><textarea maxLength={500} value={state.task} onChange={(e)=>setState({...state,task:e.target.value})} placeholder={be?"Што менавіта трэба прааналізаваць, на чым зрабіць акцэнт…":"Что именно нужно проанализировать, на чем сделать акцент…"}/><div className="w-review-controls"><span>{state.task.length}/500</span><label>{be?"Аб'ём":"Объём"}<select value={state.targetChars} onChange={(e)=>setState({...state,targetChars:Number(e.target.value)})}><option value={3000}>3 000</option><option value={5000}>5 000</option><option value={8000}>8 000</option><option value={12000}>12 000</option></select></label><label>{be?"Мадэль":"Модель"}<select value={state.model} onChange={(e)=>setState({...state,model:e.target.value as WState["model"]})}><option value="openai/gpt-oss-120b">GPT-OSS 120B</option><option value="openai/gpt-oss-20b">GPT-OSS 20B</option></select></label><button className="secondary-button" disabled={busy!==""||!state.items.length} onClick={prepareEvidence}>{busy==="evidence"?"…":be?"Падрыхтаваць Evidence":"Подготовить Evidence"}</button></div></section>

    <section className="panel w-review-style"><div className="panel-head"><div><h3>{be?"Узоры стылю":"Образцы стиля"}</h3><p>{be?"Да 5 вашых гатовых аглядаў. У кожны новы запыт перадаецца толькі кампактны Style Profile." : "До 5 ваших готовых обзоров. В каждый новый запрос передаётся только компактный Style Profile."}</p></div><span className="badge">{state.samples.length}/5</span></div><textarea value={sampleText} onChange={(e)=>setSampleText(e.target.value)} placeholder={be?"Устаўце адзін гатовы аўтарскі агляд…":"Вставьте один готовый авторский обзор…"}/><div className="w-review-controls"><button className="secondary-button" disabled={!sampleText.trim()||state.samples.length>=5} onClick={()=>{setState({...state,samples:[...state.samples,sampleText.trim()]});setSampleText("")}}>{be?"Дадаць узор":"Добавить образец"}</button><button className="primary-button" disabled={busy!==""||!state.samples.length} onClick={buildStyleProfile}>{busy==="style"?"…":be?"Абнавіць профіль стылю":"Обновить профиль стиля"}</button></div>{state.styleProfile&&<details className="w-review-evidence"><summary>Style Profile</summary><p>{state.styleProfile}</p></details>}</section>

    <section className="panel w-review-final"><div className="panel-head"><div><h3>{be?"Выніковы агляд":"Итоговый обзор"}</h3><p>{be?"AI выкарыстоўвае толькі Evidence Cards, заданне і Style Profile." : "AI использует только Evidence Cards, задание и Style Profile."}</p></div><div className="w-review-controls"><button className="primary-button" disabled={busy!==""||!state.items.length||prepared!==state.items.length||!state.task.trim()} onClick={synthesize}>{busy==="synthesize"?"…":be?"Сфарміраваць агляд":"Сформировать обзор"}</button><button className="secondary-button" disabled={!state.reviewText.trim()} onClick={exportDocx}>DOCX</button></div></div><textarea className="report-editor-textarea w-review-final-text" lang={be?"be":"ru"} spellCheck={true} value={state.reviewText} onChange={(e)=>setState({...state,reviewText:e.target.value})} placeholder={be?"Тут з'явіцца выніковы агляд…":"Здесь появится итоговый обзор…"}/><div className="w-review-usage">{be?"Сімвалаў":"Символов"}: {state.reviewText.length.toLocaleString()} · {be?"Выкарыстана токенаў у гэтай сесіі":"Использовано токенов в этой сессии"}: {usage.totalTokens.toLocaleString()}</div></section>
  </div>;
}
