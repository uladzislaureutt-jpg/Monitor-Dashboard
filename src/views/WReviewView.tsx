import { useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { MONITOR_BOOKMARKLET, parseBrowserCapture } from "../browserImport";
import { exactCompressForProfile, type CompressionMode } from "../editorialCompression";
import { wEditorialMap, wEvidenceBatch, wStyleProfile, wSynthesize, type WDensity, type WEditorialMap, type WEditorialTrend, type WFactCheck, type WUsage } from "../wReviewAi";
import { useI18n } from "../i18n";

const W_CONTRACT_VERSION = 5;
const W_STYLE_CONTRACT_VERSION = 4; // Existing profiles remain valid; only Evidence Cards/Map changed.
const MAX_ITEMS = 18;
const HARD_MAX_ITEMS = 30; // Legacy pools remain intact; the operator can trim them manually.
const MAX_SAMPLES = 5;
const BATCH_MAX_ITEMS = 2; // Keep evidence calls small so completed cards survive an upstream model failure.
const BATCH_MAX_CHARS = 20_000;
const MAX_ITEM_CHARS = 10_000; // Only the highlighted first 10k characters enter AI analysis.
const MAX_IMPORT_CHARS = 40_000; // Allow an editable tail but reject book-length imports.
const MAX_SAVED_TEXT_CHARS = 1_200_000; // Guard three local workspaces against WebView storage exhaustion.

type WItem = {
  id: string; title: string; source: string; region: string; url: string;
  sourceText: string; editorialText: string; evidence: string; evidenceContract?: number;
};
type WSample = { id: string; name: string; text: string };

// Deterministically select complete adjacent paragraphs from the author's
// own samples. These are STYLE_ONLY, never evidence about current events.
function selectStyleExcerpts(samples: WSample[]): Array<{name:string;text:string}> {
  const excerpts:Array<{name:string;text:string}> = [];
  let total = 0;
  for(const sample of samples.slice(0,3)){
    const paragraphs=sample.text.split(/\n\s*\n/).map(p=>p.trim()).filter(p=>p.length>=80);
    if(paragraphs.length<2) continue;
    // Prefer a piece that contains both editorial interpretation and source attribution.
    const matches=(p:string)=>/«[^»]{2,90}»|\b(?:Reuters|CNN|BBC|Bloomberg)\b/i.test(p);
    const start=Math.max(0,paragraphs.findIndex((p,i)=>i<paragraphs.length-1&&matches(p)));
    const chosen=paragraphs.slice(start,start+3).join("\n\n").slice(0,1400);
    if(chosen.length<200)continue;
    const room=4000-total;
    if(room<300||excerpts.length===4)break;
    const text=chosen.slice(0,room);
    excerpts.push({name:sample.name.slice(0,120),text});
    total+=text.length;
  }
  return excerpts;
}
type WState = {
  items: WItem[];
  topic: string;
  tasks: string[];
  exclusions: string;
  targetChars: number;
  samples: WSample[];
  styleProfile: string;
  styleContract?: number;
  editorialMap: WEditorialMap | null;
  mapContract?: number;
  selectedTrendIds: string[];
  density: { quotes: WDensity; headlines: WDensity; experts: WDensity };
  reviewText: string;
  sectionTitles: string[];
  boldPhrases: string[];
  docxTemplatePath?: string;
  factCheck: WFactCheck | null;
  factCheckContract?: number;
  auditDecisions?: Record<string, {action:string;reason:string}>;
};

const STORAGE_KEY = "monitor-w-review-v1";
const EMPTY: WState = {
  items: [], topic: "", tasks: [""], exclusions: "", targetChars: 3000, samples: [], styleProfile: "", styleContract: 0,
  editorialMap: null, mapContract: 0, selectedTrendIds: [],
  density: { quotes: "moderate", headlines: "moderate", experts: "moderate" }, reviewText: "", sectionTitles: [], boldPhrases: [],
  factCheck: null, factCheckContract: 0, auditDecisions: {}, docxTemplatePath: "",
};

function id(prefix = "w") { return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`; }
function estimateTokens(chars: number) { return Math.max(0, Math.round(chars / 3.2)); }
function densityValue(value: unknown): WDensity { return value === "minimum" || value === "many" || value === "all" ? value : "moderate"; }

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
      items: Array.isArray(raw.items) ? raw.items.slice(0, HARD_MAX_ITEMS) : [],
      topic: String(raw.topic || "").slice(0, 140),
      tasks: Array.isArray(raw.tasks) && raw.tasks.length
        ? raw.tasks.slice(0,5).map((v:unknown)=>String(v||"").slice(0,500))
        : [String(raw.task||"").slice(0,500)],
      exclusions: String(raw.exclusions || "").slice(0, 300),
      targetChars: [1000, 2000, 3000, 4000, 6000, 8000].includes(Number(raw.targetChars)) ? Number(raw.targetChars) : 3000,
      samples,
      styleProfile: String(raw.styleProfile || "").slice(0, 10000),
      docxTemplatePath: String(raw.docxTemplatePath || "").slice(0, 1000),
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
      sectionTitles: Array.isArray(raw.sectionTitles) ? raw.sectionTitles.map(String).slice(0, 5) : [],
      boldPhrases: Array.isArray(raw.boldPhrases) ? raw.boldPhrases.map(String).slice(0, 4) : [],
      factCheck: raw.factCheck && typeof raw.factCheck === "object" ? raw.factCheck as WFactCheck : null,
      factCheckContract: Number(raw.factCheckContract || 0),
      auditDecisions: raw.auditDecisions && typeof raw.auditDecisions === "object" ? raw.auditDecisions : {},
    };
  } catch { return EMPTY; }
}

type WWorkspaceStore = { activeSlot: number; names: string[]; slots: WState[] };
const WORKSPACES_KEY = "monitor-w-review-workspaces-v1";
function emptyWorkspace(): WState {
  return {...EMPTY,items:[],samples:[],density:{...EMPTY.density},selectedTrendIds:[],sectionTitles:[],boldPhrases:[]};
}
function loadWorkspaceStore(): WWorkspaceStore {
  const legacy = loadState();
  const initial: WWorkspaceStore = {
    activeSlot:0, names:["Тема 1","Тема 2","Тема 3"],
    slots:[legacy, {...emptyWorkspace(),samples:legacy.samples,styleProfile:legacy.styleProfile,styleContract:legacy.styleContract},
      {...emptyWorkspace(),samples:legacy.samples,styleProfile:legacy.styleProfile,styleContract:legacy.styleContract}]
  };
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACES_KEY)||"null");
    if (!saved || !Array.isArray(saved.slots) || saved.slots.length!==3) return initial;
    const slots = saved.slots.map((slot:any)=>({
      ...emptyWorkspace(), ...slot,
      items:Array.isArray(slot?.items)?slot.items.slice(0,HARD_MAX_ITEMS):[],
      topic:String(slot?.topic||"").slice(0,140),
      tasks:Array.isArray(slot?.tasks)&&slot.tasks.length ? slot.tasks.slice(0,5).map((v:unknown)=>String(v||"").slice(0,500)) : [String(slot?.task||"").slice(0,500)],
      exclusions:String(slot?.exclusions||"").slice(0,300),
      targetChars:[1000,2000,3000,4000,6000,8000].includes(Number(slot?.targetChars))?Number(slot.targetChars):3000,
      density:{quotes:densityValue(slot?.density?.quotes),headlines:densityValue(slot?.density?.headlines),experts:densityValue(slot?.density?.experts)},
      selectedTrendIds:Array.isArray(slot?.selectedTrendIds)?slot.selectedTrendIds:[],
      sectionTitles:Array.isArray(slot?.sectionTitles)?slot.sectionTitles:[],
      boldPhrases:Array.isArray(slot?.boldPhrases)?slot.boldPhrases:[]
    })) as WState[];
    const shared=slots[0];
    for(let i=1;i<3;i++){slots[i].samples=shared.samples;slots[i].styleProfile=shared.styleProfile;slots[i].styleContract=shared.styleContract;}
    return {activeSlot:[0,1,2].includes(saved.activeSlot)?saved.activeSlot:0,
      names:Array.from({length:3},(_,i)=>String(saved.names?.[i]||`Тема ${i+1}`).slice(0,60)), slots};
  }catch{return initial;}
}

export function WReviewView({ section = "review", onCloseStyle }: { section?: "review" | "style"; onCloseStyle?: () => void }) {
  const { locale } = useI18n();
  const be = locale === "be";
  const [workspaces, setWorkspaces] = useState<WWorkspaceStore>(loadWorkspaceStore);
  const activeSlot = workspaces.activeSlot;
  const state = workspaces.slots[activeSlot];
  function setState(next: WState | ((current: WState) => WState)) {
    setWorkspaces((store) => {
      const current=store.slots[store.activeSlot];
      const updated=typeof next==="function" ? next(current) : next;
      const sharedChanged=updated.samples!==current.samples || updated.styleProfile!==current.styleProfile || updated.styleContract!==current.styleContract;
      const slots=store.slots.map((slot,i)=>{
        if(i===store.activeSlot)return updated;
        if(!sharedChanged)return slot;
        return {...slot,samples:updated.samples,styleProfile:updated.styleProfile,styleContract:updated.styleContract};
      });
      return {...store,slots};
    });
  }
  const [activeId, setActiveId] = useState<string | null>(state.items[0]?.id ?? null);
  const [url, setUrl] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ title: "", source: "", region: "", url: "", text: "" });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [compressionMode, setCompressionMode] = useState<CompressionMode>("standard");
  const [analysisText, setAnalysisText] = useState("");
  const [usage, setUsage] = useState<WUsage>({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

  useEffect(() => { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces)); }, [workspaces]);
  useEffect(() => { if (activeId && !state.items.some((item) => item.id === activeId)) setActiveId(state.items[0]?.id ?? null); }, [state.items, activeId]);

  function switchWorkspace(index:number) {
    if(busy || index===activeSlot) return;
    setWorkspaces(current=>({...current,activeSlot:index}));
    setActiveId(workspaces.slots[index].items[0]?.id??null);
    setUrl("");setManualOpen(false);setAnalysisText("");setMessage("");setError("");
  }
  const active = state.items.find((item) => item.id === activeId) ?? state.items[0] ?? null;
  const totalChars = useMemo(() => state.items.reduce((sum, item) => sum + item.editorialText.length, 0), [state.items]);
  const overLimitCount = state.items.filter(item => item.editorialText.length > MAX_ITEM_CHARS).length;
  function storedTextChars() {
    return workspaces.slots.reduce((sum, slot) =>
      sum + slot.items.reduce((inside, item) => inside + item.sourceText.length + item.editorialText.length, 0), 0);
  }
  const prepared = state.items.filter((item) => item.evidence.trim() && item.evidenceContract === W_CONTRACT_VERSION).length;
  const mapReady = Boolean(state.editorialMap?.trends?.length && state.mapContract === W_CONTRACT_VERSION);
  const selectedTrends = mapReady ? state.editorialMap!.trends.filter((trend) => state.selectedTrendIds.includes(trend.id)) : [];
  const styleReady = Boolean(state.styleProfile.trim() && state.styleContract === W_STYLE_CONTRACT_VERSION);
  const topicReady = state.topic.trim().length > 0;
  const operatorTask = useMemo(() => {
    const tasks=state.tasks.map(v=>v.trim()).filter(Boolean);
    return [
      `ТЕМА: ${state.topic.trim()}`,
      `ЗАДАЧИ: ${tasks.length?tasks.map((v,i)=>`${i+1}. ${v}`).join(" | "):"Выявить главные тенденции освещения темы, аргументы и наиболее важные факты."}`,
      `ИСКЛЮЧЕНИЯ — НЕ УПОМИНАТЬ: ${state.exclusions.trim()||"Дополнительных исключений нет."}`
    ].join("\n");
  },[state.topic,state.tasks,state.exclusions]);
  const reviewReady = state.items.length > 0 && state.items.length <= MAX_ITEMS &&
    prepared === state.items.length && mapReady && selectedTrends.length > 0 && topicReady && styleReady;

  function invalidateMap(current: WState): WState {
    return { ...current, editorialMap: null, mapContract: 0, selectedTrendIds: [], reviewText: "", sectionTitles: [], boldPhrases: [], factCheck: null, factCheckContract: 0 };
  }
  function addUsage(next: WUsage) {
    setUsage((current) => ({
      promptTokens: current.promptTokens + next.promptTokens,
      completionTokens: current.completionTokens + next.completionTokens,
      totalTokens: current.totalTokens + next.totalTokens,
    }));
  }
  function evidenceCards(items: WItem[]) {
    return items.map((item,index) => `ID: P${String(index+1).padStart(2,"0")}\nИСТОЧНИК: «${item.source}»\nЗАГОЛОВОК: ${item.title}\nURL: ${item.url||"не указан"}\n${item.evidence}`);
  }

  function addItem(input: { title: string; source: string; region?: string; url?: string; text: string }) {
    if (state.items.length >= MAX_ITEMS) throw new Error("W_REVIEW_MAX_ITEMS");
    const text = input.text.trim();
    if (!input.title.trim() || !text) throw new Error("W_REVIEW_ITEM_REQUIRED");
    if (text.length > MAX_IMPORT_CHARS) throw new Error(
      `Материал содержит ${text.length.toLocaleString()} знаков. Максимальный объём загружаемого исходника — ${MAX_IMPORT_CHARS.toLocaleString()}. Предварительно удалите лишние разделы.`);
    if (storedTextChars() + text.length * 2 > MAX_SAVED_TEXT_CHARS)
      throw new Error("Достигнут безопасный предел локального хранилища трёх рабочих пространств. Удалите лишние публикации.");
    const next: WItem = {
      id: id(), title: input.title.trim(), source: input.source.trim() || "Источник",
      region: input.region?.trim() || "", url: input.url?.trim() || "",
      sourceText: text, editorialText: text, evidence: "", evidenceContract: 0,
    };
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
      try {
        const resolved = await desktopApi.resolveKnownSource(capture.url);
        source = resolved.source || source; region = resolved.region || region;
      } catch { /* arbitrary source */ }
      addItem({ title: capture.title || source, source, region, url: capture.url, text: capture.text });
      setMessage(be ? "Старонка з браўзера дададзена ў пул." : "Страница из браузера добавлена в пул.");
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function copyBookmarklet() {
    await desktopApi.writeClipboardText(MONITOR_BOOKMARKLET);
    setMessage(be ? "Код закладкі скапіяваны." : "Код закладки скопирован.");
  }

  function updateItem(itemId: string, patch: Partial<WItem>) {
    if (patch.editorialText !== undefined) {
      const before = state.items.find(item => item.id === itemId)?.editorialText.length || 0;
      const after = patch.editorialText.length;
      if (after > MAX_IMPORT_CHARS && after > before) {
        setError(`Максимальный размер редактируемого исходника — ${MAX_IMPORT_CHARS.toLocaleString()} знаков.`);
        return;
      }
      if (storedTextChars() + after - before > MAX_SAVED_TEXT_CHARS && after > before) {
        setError("Недостаточно места для сохранения текста в трёх рабочих пространствах. Сократите публикации.");
        return;
      }
    }
    setState((current) => {
      const edited = patch.editorialText !== undefined;
      const items = current.items.map((item) => item.id === itemId
        ? { ...item, ...patch, evidence: edited ? "" : item.evidence, evidenceContract: edited ? 0 : item.evidenceContract }
        : item);
      return edited ? invalidateMap({ ...current, items }) : { ...current, items };
    });
  }

  function exact() {
    if (!active) return;
    const result = exactCompressForProfile(active.editorialText, compressionMode, "l");
    updateItem(active.id, { editorialText: result.text });
    setMessage(`${be ? "Exact-скарачэнне" : "Exact-сокращение"}: ${result.reductionPct}%.`);
  }

  function buildBatches(items: WItem[]) {
    const pending = items.map((item, index) => ({ item, index }))
      .filter(({ item }) => !(item.evidence.trim() && item.evidenceContract === W_CONTRACT_VERSION));
    const batches: Array<Array<{ item: WItem; index: number }>> = [];
    let current: Array<{ item: WItem; index: number }> = [];
    let chars = 0;
    for (const entry of pending) {
      const len = entry.item.editorialText.length;
      if (len > MAX_ITEM_CHARS) throw new Error(`Материал «${entry.item.title}» длиннее ${MAX_ITEM_CHARS.toLocaleString()} знаков. Сократите его Exact или вручную.`);
      if (current.length && (current.length >= BATCH_MAX_ITEMS || chars + len > BATCH_MAX_CHARS)) {
        batches.push(current); current = []; chars = 0;
      }
      current.push(entry); chars += len;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  async function analyzePool() {
    if (!state.items.length) { setError(be ? "Спачатку дадайце матэрыялы." : "Сначала добавьте материалы."); return; }
    if (!topicReady) { setError(be?"Укажыце тэму агляду.":"Укажите тему обзора."); return; }
    if (state.items.length>MAX_ITEMS) { setError(`Сократите пул до ${MAX_ITEMS} публикаций.`); return; }
    if (overLimitCount) {
      setError(`Сначала сократите ${overLimitCount} публикац. до ${MAX_ITEM_CHARS.toLocaleString()} знаков; приглушённый хвост пока не обрабатывается.`);
      return;
    }
    setBusy("analyze"); setError(""); setMessage("");
    const next = [...state.items];
    try {
      const batches = buildBatches(next);
      let done = next.filter((item) => item.evidence.trim() && item.evidenceContract === W_CONTRACT_VERSION).length;
      setAnalysisText(be ? `Аналіз матэрыялаў: ${done} з ${next.length}` : `Анализ материалов: ${done} из ${next.length}`);
      for (const batch of batches) {
        const result = await wEvidenceBatch(
          batch.map(({ item }) => ({ title: item.title, source: item.source, text: item.editorialText })),
          (seconds) => setAnalysisText(be ? `Ліміт AI. Працяг аўтаматычна праз ~${seconds} с…` : `Лимит AI. Продолжение автоматически через ~${seconds} с…`)
        );
        for (const card of result.cards) {
          const target = batch[card.index];
          if (!target || !card.evidence) continue;
          next[target.index] = { ...next[target.index], evidence: card.evidence, evidenceContract: W_CONTRACT_VERSION };
        }
        done = next.filter((item) => item.evidence.trim() && item.evidenceContract === W_CONTRACT_VERSION).length;
        setState((currentState) => invalidateMap({ ...currentState, items: [...next] }));
        addUsage(result.usage);
        setAnalysisText(be ? `Аналіз матэрыялаў: ${done} з ${next.length}` : `Анализ материалов: ${done} из ${next.length}`);
      }
      if (done !== next.length) { const missing = next.filter((item) => !(item.evidence.trim() && item.evidenceContract === W_CONTRACT_VERSION)).map((item) => item.title).slice(0, 4); throw new Error(`Проанализировано ${done} из ${next.length}. Не обработаны: ${missing.join("; ")}${next.length - done > missing.length ? "…" : ""}. Нажмите «Проанализировать пул» ещё раз — готовые материалы повторно не обрабатываются.`); }
      setAnalysisText(be ? "Вызначаю тэндэнцыі медыяполя…" : "Выявляю тенденции медиаполя…");
      const mapResult = await wEditorialMap(
        { task: operatorTask, evidenceCards: evidenceCards(next) },
        (seconds) => setAnalysisText(be ? `Ліміт AI. Карта працягнецца праз ~${seconds} с…` : `Лимит AI. Карта продолжится автоматически через ~${seconds} с…`)
      );
      addUsage(mapResult.usage);
      setState((currentState) => ({
        ...currentState,
        items: [...next],
        editorialMap: mapResult.editorialMap,
        mapContract: W_CONTRACT_VERSION,
        selectedTrendIds: mapResult.editorialMap.trends.map((trend: WEditorialTrend) => trend.id),
        reviewText: "",
      }));
      setAnalysisText("");
      setMessage(be ? "Пул прааналізаваны. Праверце выяўленыя тэндэнцыі." : "Пул проанализирован. Проверьте выявленные тенденции.");
    } catch (reason) {
      setAnalysisText("");
      setError(String(reason));
    } finally { setBusy(""); }
  }

  async function recalculateTrends() {
    if (!topicReady || state.items.length>MAX_ITEMS || prepared !== state.items.length) return;
    setBusy("map"); setError(""); setMessage("");
    try {
      const result = await wEditorialMap(
        { task: operatorTask, evidenceCards: evidenceCards(state.items) },
        (seconds) => setAnalysisText(be ? `Ліміт AI. Працяг праз ~${seconds} с…` : `Лимит AI. Продолжение через ~${seconds} с…`)
      );
      addUsage(result.usage);
      setState((current) => ({
        ...current, editorialMap: result.editorialMap, mapContract: W_CONTRACT_VERSION,
        selectedTrendIds: result.editorialMap.trends.map((trend: WEditorialTrend) => trend.id), reviewText: "", factCheck: null, factCheckContract: 0,
      }));
      setMessage(be ? "Тэндэнцыі пералічаны." : "Тенденции пересчитаны.");
    } catch (reason) { setError(String(reason)); } finally { setAnalysisText(""); setBusy(""); }
  }

  function clearPool() {
    if (!state.items.length) return;
    setState((current) => ({
      ...current,
      items: [],
      editorialMap: null,
      mapContract: 0,
      selectedTrendIds: [],
      reviewText: "",
      sectionTitles: [],
      boldPhrases: [],
      factCheck: null,
      factCheckContract: 0,
    }));
    setActiveId(null);
    setAnalysisText("");
    setError("");
    setMessage(be ? "Пул матэрыялаў ачышчаны." : "Пул материалов очищен.");
  }

  async function importSamples() {
    if (state.samples.length >= MAX_SAMPLES) return;
    const selected = await open({
      multiple: true, directory: false,
      title: be ? "Выберыце ўзоры W-Review" : "Выберите образцы W-Review",
      filters: [{ name: "Образцы", extensions: ["docx", "txt"] }],
    });
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
      setState((current) => ({ ...current, samples: [...current.samples, ...added].slice(0, MAX_SAMPLES), styleContract: 0 }));
      setMessage(be ? `Дададзена ўзораў: ${added.length}. Абнавіце профіль стылю.` : `Добавлено образцов: ${added.length}. Обновите профиль стиля.`);
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function buildStyleProfile() {
    const samples = state.samples.map((sample) => sample.text).filter((sample) => sample.trim());
    if (!samples.length) return;
    setBusy("style"); setError(""); setMessage("");
    try {
      const result = await wStyleProfile(
        samples,
        (seconds) => setMessage(be ? `Ліміт правайдара ШІ. Паўтор праз ~${seconds} с…` : `Временный лимит провайдера ИИ. Повтор через ~${seconds} с…`)
      );
      setState((current) => ({ ...current, styleProfile: result.styleProfile, styleContract: W_STYLE_CONTRACT_VERSION }));
      addUsage(result.usage);
      const styleModel = result.model.startsWith("@cf/") ? "Cloudflare GPT-OSS-120B"
        : result.model === "gemini-3.5-flash-lite" ? "Gemini 3.5 Flash-Lite" : result.model;
      const tokens = Math.max(0, result.usage.totalTokens).toLocaleString();
      setMessage(be
        ? `Профіль стылю гатовы. Мадэль: ${styleModel}. Токенаў: ${tokens}.`
        : `Профиль стиля готов. Модель: ${styleModel}. Токенов: ${tokens}.`);
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function synthesize() {
    if (!reviewReady) return;
    setBusy("synthesize"); setError(""); setMessage("");
    try {
      const result = await wSynthesize({
        topicKey: `workspace-${activeSlot + 1}`,
        task: operatorTask,
        targetChars: state.targetChars,
        evidenceCards: evidenceCards(state.items),
        styleProfile: state.styleProfile,
        styleExcerpts: selectStyleExcerpts(state.samples),
        trends: selectedTrends,
        density: state.density,
        sourceNames: Array.from(new Set(state.items.map((item) => item.source.trim()).filter(Boolean))),
      }, (seconds) => setMessage(be ? `Ліміт Groq. Генерацыя працягнецца праз ~${seconds} с…` : `Лимит Groq. Генерация продолжится автоматически через ~${seconds} с…`));
      setState(current=>({...current,reviewText:result.reviewText,
        sectionTitles:result.sectionTitles,boldPhrases:result.boldPhrases,
        factCheck:null,factCheckContract:0,auditDecisions:{}}));
      addUsage(result.usage);
      const warning=result.preflightWarnings.length
        ? " Возможные расхождения по Evidence: "+result.preflightWarnings.join("; ").slice(0,360) : "";
      setMessage((be?"Агляд сфарміраваны. Яго можна рэдагаваць і экспартаваць у DOCX.":"Обзор сформирован. Можно редактировать и экспортировать в DOCX.")+warning);
    } catch (reason) {
      const text = String(reason);
      setError(text.includes("w_review_daily_generation_limit")
        ? (be
          ? "Для гэтай тэмы сёння ўжо сфарміраваны 2 агляды. Ліміт абновіцца ў 00:00 па Мінску."
          : "Для этой темы сегодня уже сформированы 2 обзора. Лимит обновится в 00:00 по Минску.")
        : text);
    } finally { setBusy(""); }
  }

  async function chooseDocxTemplate() {
    const selected=await open({
      title:be?"Абраць арыгінальны ўзор Word":"Выбрать оригинальный образец Word",
      multiple:false,filters:[{name:"Word DOCX",extensions:["docx"]}]
    });
    if(typeof selected==="string"){
      setState(current=>({...current,docxTemplatePath:selected}));
      setMessage(be?"Узор Word захаваны.":"Образец Word выбран для оформления DOCX.");
    }
  }

  async function exportDocx() {
    if (!state.reviewText.trim()) { setError(be?"Агляд пусты.":"Обзор пуст."); return; }
    const path = await save({ title: "W-Review DOCX", defaultPath: "W-Review.docx", filters: [{ name: "Word", extensions: ["docx"] }] });
    if (!path) return;
    // Only one unique URL per media outlet may be linked automatically.
    // Multiple different articles by the same outlet are left unlinked to
    // avoid sending the reader to the wrong publication.
    const sourceLinks=Array.from(new Set(state.items.map(item=>item.source.trim()).filter(Boolean)))
      .map(name=>{
        const urls=Array.from(new Set(state.items.filter(item=>item.source.trim()===name)
          .map(item=>item.url.trim()).filter(url=>/^https?:\/\//i.test(url))));
        return urls.length===1?{name,url:urls[0]}:null;
      }).filter((item):item is {name:string;url:string}=>Boolean(item));
    await desktopApi.exportWReview(path, state.reviewText.trim(), Array.from(new Set(state.items.map((item) => item.source.trim()).filter(Boolean))), state.sectionTitles, state.boldPhrases, sourceLinks, state.docxTemplatePath||null);
    setMessage(be ? "DOCX захаваны ў фармаце W-Review." : "DOCX сохранён в формате W-Review.");
  }

  const densityOptions = <><option value="minimum">{be ? "мінімум" : "минимум"}</option><option value="moderate">{be ? "умерана" : "умеренно"}</option><option value="many">{be ? "многа" : "много"}</option><option value="all">{be ? "усе знойдзеныя" : "все найденные"}</option></>;
  if (section === "style") {
    return <div className="view-stack w-review w-review-style-page">
      <section className="view-heading"><div><div className="eyebrow dark">W-REVIEW</div><h2>{be ? "Аўтарскі стыль" : "Авторский стиль"}</h2><p>{be ? "Дадайце да 5 узораў DOCX/TXT і стварыце профіль, які будзе выкарыстоўвацца ў наступных аглядах." : "Добавьте до 5 образцов DOCX/TXT и создайте профиль, который будет использоваться в следующих обзорах."}</p></div><div className="w-review-style-heading-actions"><span className={`badge ${styleReady?"ready":""}`}>{styleReady?"✓":state.samples.length+"/"+MAX_SAMPLES}</span><button className="ghost-button w-review-close-button" onClick={onCloseStyle} aria-label={be?"Закрыць аўтарскі стыль":"Закрыть авторский стиль"} title={be?"Закрыць":"Закрыть"}>×</button></div></section>
      {message && <div className="notice success">{message}</div>}{error && <div className="notice error">{error}</div>}
      <section className="panel w-review-style"><div className="panel-head"><div><h3>{be?"Узоры і профіль":"Образцы и профиль"}</h3><p>{be?"Профіль можна выкарыстоўваць для многіх аглядаў без пераліку." : "Профиль можно использовать для многих обзоров без пересчёта."}</p></div></div>
        <div className="w-review-controls"><button className="secondary-button" disabled={busy!==""||state.samples.length>=MAX_SAMPLES} onClick={importSamples}>{busy==="sample"?"…":be?"Дадаць DOCX/TXT":"Добавить DOCX/TXT"}</button><button className="primary-button" disabled={busy!==""||!state.samples.length} onClick={buildStyleProfile}>{busy==="style"?"…":styleReady?(be?"Абнавіць профіль":"Обновить профиль"):(be?"Стварыць профіль стылю":"Создать профиль стиля")}</button></div>
        {state.samples.length>0&&<div className="w-review-samples">{state.samples.map((sample)=><div key={sample.id}><span>{sample.name}</span><button className="ghost-button small-button" onClick={()=>setState((current)=>({...current,samples:current.samples.filter((item)=>item.id!==sample.id),styleContract:0}))}>×</button></div>)}</div>}
        {styleReady&&<p className="w-review-style-ready">{be?"✓ Профіль стылю гатовы":"✓ Профиль стиля готов"}</p>}
      </section>
    </div>;
  }

  const analysisButtonText = busy === "analyze"
    ? (analysisText || (be ? "Аналізую…" : "Анализирую…"))
    : mapReady
      ? (be ? "Перааналізаваць пул" : "Переанализировать пул")
      : (be ? "Прааналізаваць пул" : "Проанализировать пул");

  return <div className="view-stack w-review">
    <section className="view-heading"><div><div className="eyebrow dark">W-REVIEW</div><h2>{be ? "Папярэдні агляд" : "Предварительный обзор"}</h2><p>{be ? "Збярыце матэрыялы, задайце тэму і атрымаеце абагульнены погляд на медыяполе." : "Соберите материалы, задайте тему и получите обобщённый взгляд на медиаполе."}</p></div><div className="w-review-metrics"><b>{state.items.length}/{MAX_ITEMS}</b><span>~{estimateTokens(totalChars).toLocaleString()} input tokens</span></div></section>
    <div role="tablist" aria-label={be?"Тэмы W-Review":"Темы W-Review"} style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:12}}>
      {workspaces.names.map((name,index)=><div key={index} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 8px",borderRadius:8,border:index===activeSlot?"2px solid var(--accent, #b91c1c)":"1px solid #8885",maxWidth:260}}>
        <button role="tab" aria-selected={index===activeSlot} disabled={busy!==""} onClick={()=>switchWorkspace(index)} className={index===activeSlot?"primary-button":"secondary-button"} style={{padding:"6px 10px",whiteSpace:"nowrap"}}>{index+1}</button>
        <span title={workspaces.slots[index].topic||name} style={{display:"inline-block",maxWidth:155,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:index===activeSlot?700:400}}>{workspaces.slots[index].topic||name}</span>
        <span title={be?"Матэрыялаў у пуле":"Материалов в пуле"}>{workspaces.slots[index].items.length}</span>
      </div>)}
    </div>
    {message && <div className="notice success">{message}</div>}{error && <div className="notice error">{error}</div>}

    <section className="panel w-review-import"><div className="panel-head"><div><h3>{be ? "1. Матэрыялы" : "1. Материалы"}</h3><p>{be ? "Прамая загрузка, закладка → Monitor або ручны ўвод." : "Прямая загрузка, закладка → Monitor или ручной ввод."}</p></div></div>
      <div className="w-review-import-row"><input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://…" /><button className="secondary-button" onClick={importUrl} disabled={busy!==""||!url.trim()||state.items.length>=MAX_ITEMS}>{busy==="url"?"…":be?"Спампаваць":"Скачать"}</button><button className="primary-button" onClick={pasteBrowser} disabled={busy!==""||state.items.length>=MAX_ITEMS}>{busy==="clipboard"?"…":be?"Уставіць з браўзера":"Вставить из браузера"}</button><button className="ghost-button" onClick={()=>setManualOpen((v)=>!v)}>{be?"Дадаць уручную":"Добавить вручную"}</button><button className="ghost-button" onClick={copyBookmarklet}>→ Monitor</button></div>
      {manualOpen&&<div className="w-review-manual"><input placeholder={be?"Загаловак":"Заголовок"} value={manual.title} onChange={(e)=>setManual({...manual,title:e.target.value})}/><input placeholder={be?"Крыніца":"Источник"} value={manual.source} onChange={(e)=>setManual({...manual,source:e.target.value})}/><input placeholder={be?"Краіна / рэгіён":"Страна / регион"} value={manual.region} onChange={(e)=>setManual({...manual,region:e.target.value})}/><input placeholder="URL" value={manual.url} onChange={(e)=>setManual({...manual,url:e.target.value})}/><textarea placeholder={be?"Тэкст публікацыі":"Текст публикации"} value={manual.text} onChange={(e)=>setManual({...manual,text:e.target.value})}/><button className="primary-button" onClick={()=>{try{addItem(manual);setManual({title:"",source:"",region:"",url:"",text:""});setManualOpen(false)}catch(reason){setError(String(reason))}}}>{be?"Дадаць":"Добавить"}</button></div>}
    </section>

    <section className="panel w-review-task">
      <div className="panel-head"><div><h3>{be?"2. Заданне для агляду":"2. Задание для обзора"}</h3>
        <p>{be?"Тэма абавязковая. Задачы і выключэнні — пры неабходнасці.":"Тема обязательна. Задачи и исключения — по необходимости."}</p></div></div>
      <label style={{display:"block",marginBottom:12}}><strong>{be?"Тэма агляду *":"Тема обзора *"}</strong>
        <input maxLength={140} value={state.topic} onChange={e=>setState(current=>invalidateMap({...current,topic:e.target.value}))}
          placeholder={be?"Напрыклад: Міжнародная рэакцыя на санкцыі":"Например: Международная реакция на санкции"}/>
      </label>
      <div style={{display:"grid",gap:10}}>
        {state.tasks.map((value,index)=><label key={index} style={{display:"block"}}>
          <span style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
            <strong>{be?"Задача":"Задача"} {index+1}{index===0?(be?" (неабавязкова)":" (необязательно)"):""}</strong>
            {index>0&&<button type="button" className="ghost-button small-button" disabled={busy!==""} aria-label={be?"Выдаліць задачу":"Удалить задачу"}
              onClick={()=>setState(current=>invalidateMap({...current,tasks:current.tasks.filter((_,i)=>i!==index)}))}>×</button>}
          </span>
          <textarea rows={2} maxLength={160} value={value} onChange={e=>setState(current=>invalidateMap({...current,tasks:current.tasks.map((task,i)=>i===index?e.target.value:task)}))}
            placeholder={index===0?"Что проанализировать, на чём сделать акцент? Например: основные тенденции и оценки СМИ."
              :"Дополнительный акцент: аргументы экспертов, риски, прогнозы, различия в позициях…"}/>
        </label>)}
        {state.tasks.length<5&&<button type="button" className="secondary-button small-button" disabled={busy!==""} style={{justifySelf:"start"}}
          onClick={()=>setState(current=>invalidateMap({...current,tasks:[...current.tasks,""]}))}>
          + {be?"Дадаць задачу":"Добавить задачу"}
        </button>}
      </div>
      <label style={{display:"block",marginTop:14}}><strong>{be?"Што выключыць з агляду":"Что исключить из обзора"}</strong>
        <textarea rows={2} maxLength={300} value={state.exclusions} onChange={e=>setState(current=>invalidateMap({...current,exclusions:e.target.value}))}
          placeholder={be?"Якія сюжэты, звесткі ці аспекты не закранаць…":"Что не затрагивать? Например: историю вопроса, неподтверждённые слухи, второстепенные реакции."}/>
      </label>
    </section>

    <section className="w-review-grid">
      <aside className="panel w-review-pool"><div className="panel-head"><div><h3>{be?"Пул матэрыялаў":"Пул материалов"}</h3><p>{state.items.length ? (prepared === state.items.length ? (be?"усе матэрыялы гатовыя да аналізу":"все материалы проанализированы") : (be?`прааналізавана ${prepared} з ${state.items.length}`:`проанализировано ${prepared} из ${state.items.length}`)) : (be?"пакуль пуста":"пока пусто")}</p></div><button className="ghost-button small-button" disabled={busy!==""||!state.items.length} onClick={clearPool}>{be?"Ачысціць":"Очистить"}</button></div>
        {state.items.map((item,index)=><button key={item.id} className={`w-review-item ${active?.id===item.id?"active":""}`} onClick={()=>setActiveId(item.id)}><span>P{String(index+1).padStart(2,"0")}</span><div><b>{item.title}</b><small>{item.source}{item.evidence&&item.evidenceContract===W_CONTRACT_VERSION?" · ✓":""}
          {item.editorialText.length>MAX_ITEM_CHARS?` · +${(item.editorialText.length-MAX_ITEM_CHARS).toLocaleString()} знаков`:""}</small></div></button>)}
        <div className="w-review-pool-action"><button className="primary-button" disabled={busy!==""||!state.items.length||state.items.length>MAX_ITEMS||!topicReady||overLimitCount>0} onClick={analyzePool}>{analysisButtonText}</button>{busy==="analyze"&&<small>{analysisText}</small>}{error&&<small style={{color:"#b42318",whiteSpace:"normal"}}>{error}</small>}{overLimitCount>0&&<small className="w-review-limit-warning" role="alert">
            {be ? `Скараціце ${overLimitCount} публікац. да ${MAX_ITEM_CHARS.toLocaleString()} знакаў: пакуль аналіз адключаны.`
              : `Сократите ${overLimitCount} публикац. до ${MAX_ITEM_CHARS.toLocaleString()} знаков: анализ пока недоступен.`}
          </small>}
          {!topicReady&&state.items.length>0&&<small>{be?"Для аналізу ўкажыце тэму вышэй.":"Для анализа укажите тему выше."}</small>}
          {state.items.length>MAX_ITEMS&&<small style={{color:"#b42318"}}>Сократите пул до {MAX_ITEMS} публикаций. Сохранённые материалы не удаляются автоматически.</small>}</div>
      </aside>
      <div className="panel w-review-editor">{active?<><div className="panel-head"><div><h3>{active.title}</h3><p>{active.source}{active.region?` · ${active.region}`:""}</p></div><button className="ghost-button small-button" onClick={()=>setState((current)=>invalidateMap({...current,items:current.items.filter((item)=>item.id!==active.id)}))}>{be?"Выдаліць":"Удалить"}</button></div><div className="w-review-exact"><select value={compressionMode} onChange={(e)=>setCompressionMode(e.target.value as CompressionMode)}><option value="light">20–30%</option><option value="standard">30–50%</option><option value="maximum">50–70%</option><option value="extract">70–90%</option></select><button className="secondary-button small-button" onClick={exact}>Exact</button><button className="ghost-button small-button" onClick={()=>updateItem(active.id,{editorialText:active.sourceText})}>{be?"Вярнуць зыходны":"Вернуть исходный"}</button></div><div className="w-review-length-state">
  <span className={active.editorialText.length>MAX_ITEM_CHARS?"exceeded":"within"}>
    {active.editorialText.length.toLocaleString()} / {MAX_ITEM_CHARS.toLocaleString()} {be?"знакаў для ІІ":"знаков для ИИ"}
  </span>
  {active.editorialText.length>MAX_ITEM_CHARS&&<strong>
    {be?`Не змяшчаецца ${(active.editorialText.length-MAX_ITEM_CHARS).toLocaleString()} знакаў. Выдаліце неважныя фрагменты перад аналізам.`
      :`Не помещается ${(active.editorialText.length-MAX_ITEM_CHARS).toLocaleString()} знаков. Удалите малозначимые фрагменты перед анализом.`}
  </strong>}
</div>
<div className="w-review-text-guard">
  <div className="w-review-text-backdrop" aria-hidden="true">
    <span>{active.editorialText.slice(0,MAX_ITEM_CHARS)}</span><span className="w-review-text-tail">{active.editorialText.slice(MAX_ITEM_CHARS)}</span>{"\n"}
  </div>
  <textarea className="report-editor-textarea w-review-edit-input" lang={be?"be":"ru"} spellCheck={true}
    aria-label={be?"Рэдагуемы тэкст публікацыі":"Редактируемый текст публикации"}
    value={active.editorialText} onChange={(e)=>updateItem(active.id,{editorialText:e.target.value})}
    onScroll={(event)=>{
      const backdrop=event.currentTarget.previousElementSibling as HTMLDivElement|null;
      if(backdrop){backdrop.scrollTop=event.currentTarget.scrollTop;backdrop.scrollLeft=event.currentTarget.scrollLeft;}
    }}/>
</div></>:<div className="report-empty">{be?"Выберыце матэрыял.":"Выберите материал."}</div>}</div>
    </section>

    {mapReady&&state.editorialMap&&<section className="panel w-review-map"><div className="panel-head"><div><h3>{be?"3. Тэндэнцыі медыяполя":"3. Тенденции медиаполя"}</h3><p>{be?"Зніміце галачку толькі з тых акцэнтаў, якія не павінны ўваходзіць у агляд." : "Снимите галочку только с тех акцентов, которые не должны входить в обзор."}</p></div><button className="ghost-button small-button" disabled={busy!==""} onClick={recalculateTrends}>{be?"Пералічыць":"Пересчитать"}</button></div>
      <div className="w-review-trends">{state.editorialMap.trends.map((trend,index)=><label key={trend.id} className={`w-review-trend ${state.selectedTrendIds.includes(trend.id)?"selected":""}`}><input type="checkbox" checked={state.selectedTrendIds.includes(trend.id)} onChange={()=>setState((current)=>({...current,selectedTrendIds:current.selectedTrendIds.includes(trend.id)?current.selectedTrendIds.filter((value)=>value!==trend.id):[...current.selectedTrendIds,trend.id],reviewText:"",factCheck:null,factCheckContract:0}))}/><span><b>{index+1}. {trend.title}</b><small>{trend.summary}</small></span></label>)}</div>
      <div className="w-review-inventory">{be?"Знойдзена ў пуле":"Найдено в пуле"}: <b>{state.editorialMap.inventory.quotes}</b> {be?"цытат":"цитат"} · <b>{state.editorialMap.inventory.headlines}</b> {be?"загалоўкаў":"заголовков"} · <b>{state.editorialMap.inventory.experts}</b> {be?"экспертных каментарыяў":"экспертных комментариев"}</div>
      <div className="w-review-density">
        <label><span>{be?"Цытаты":"Цитаты"}</span><select value={state.density.quotes} onChange={(e)=>setState({...state,density:{...state.density,quotes:e.target.value as WDensity},reviewText:"",factCheck:null,factCheckContract:0})}>{densityOptions}</select></label>
        <label><span>{be?"Загалоўкі":"Заголовки"}</span><select value={state.density.headlines} onChange={(e)=>setState({...state,density:{...state.density,headlines:e.target.value as WDensity},reviewText:"",factCheck:null,factCheckContract:0})}>{densityOptions}</select></label>
        <label><span>{be?"Эксперты":"Эксперты"}</span><select value={state.density.experts} onChange={(e)=>setState({...state,density:{...state.density,experts:e.target.value as WDensity},reviewText:"",factCheck:null,factCheckContract:0})}>{densityOptions}</select></label>
      </div>
    </section>}

    <section className="panel w-review-final"><div className="panel-head"><div><h3>{be?"4. Выніковы агляд":"4. Итоговый обзор"}</h3><p>{be?"AI будуе тэкст па выбраных тэндэнцыях.":"AI строит текст по выбранным тенденциям."}</p></div></div>
      <div className="w-review-readiness"><span className={prepared===state.items.length&&state.items.length?"ready":""}>{prepared===state.items.length&&state.items.length?"✓":"○"} {be?"Матэрыялы прааналізаваны":"Материалы проанализированы"}</span><span className={selectedTrends.length?"ready":""}>{selectedTrends.length?"✓":"○"} {be?"Тэндэнцыі выбраны":"Тенденции выбраны"}</span><span className={topicReady?"ready":""}>{topicReady?"✓":"○"} {be?"Тэма ўказана":"Тема указана"}</span><span className={styleReady?"ready":""}>{styleReady?"✓":"○"} {be?"Аўтарскі стыль (абавязкова)":"Авторский стиль (обязательно)"}</span></div>
      {!styleReady&&<p style={{fontSize:11,color:"#9a443b",margin:"0 0 10px"}}>{be?"Перад фарміраваннем агляду стварыце профіль на ўкладцы «Аўтарскі стыль».":"Перед формированием обзора создайте профиль на вкладке «Авторский стиль»."}</p>}
      <div className="w-review-final-actions"><label className="w-review-length-control"><span>{be?"Аб\’ём, знакаў":"Объём, знаков"}</span><select value={state.targetChars} onChange={(e)=>setState({...state,targetChars:Number(e.target.value),reviewText:"",sectionTitles:[],boldPhrases:[],factCheck:null,factCheckContract:0})}><option value={1000}>1 000</option><option value={2000}>2 000</option><option value={3000}>3 000</option><option value={4000}>4 000</option><option value={6000}>6 000</option><option value={8000}>8 000</option></select></label><button className="primary-button" disabled={busy!==""||!reviewReady} onClick={synthesize}>{busy==="synthesize"?"…":be?"Сфарміраваць агляд":"Сформировать обзор"}</button><button className="secondary-button" disabled={!state.reviewText.trim()||busy!==""} onClick={exportDocx}>DOCX</button>
       <button className="ghost-button small-button" disabled={busy!==""} onClick={chooseDocxTemplate}
         title={state.docxTemplatePath||"Выбрать оригинальный файл DOCX для оформления"}>
         {state.docxTemplatePath?(be?"Узор Word ✓":"Образец Word ✓"):(be?"Узор Word":"Образец Word")}
       </button></div>
      <textarea className="report-editor-textarea w-review-final-text" lang={be?"be":"ru"} spellCheck={true} value={state.reviewText} onChange={(e)=>setState(current=>({
          ...current,reviewText:e.target.value,
          sectionTitles:current.sectionTitles.filter(value=>e.target.value.includes(value)),
          boldPhrases:current.boldPhrases.filter(value=>e.target.value.includes(value)),
        }))} placeholder={be?"Тут з'явіцца выніковы агляд…":"Здесь появится итоговый обзор…"}/>
      <div className="w-review-usage">
         {be?"Знакаў":"Знаков"}: {state.reviewText.length.toLocaleString()} / {state.targetChars.toLocaleString()}
         {" · "}{be?"Дапушчальна":"Допуск"}: {Math.round(state.targetChars*.95).toLocaleString()}–{Math.round(state.targetChars*1.05).toLocaleString()}
         {state.reviewText.trim()&& (state.reviewText.length<Math.round(state.targetChars*.95)||state.reviewText.length>Math.round(state.targetChars*1.05))?
           <strong style={{color:"#9a443b"}}> · {be?"Адхіленне ад аб'ёму":"Отклонение от объёма"}</strong>:null}
         {" · "}{be?"Токенаў у гэтай сесіі":"Токенов в этой сессии"}: {usage.totalTokens.toLocaleString()}
       </div>
    </section>
  </div>;
}
