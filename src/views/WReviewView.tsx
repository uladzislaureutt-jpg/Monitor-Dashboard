import { useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { MONITOR_BOOKMARKLET, parseBrowserCapture } from "../browserImport";
import { exactCompressForProfile, type CompressionMode } from "../editorialCompression";
import { wEditorialMap, wEvidenceBatch, wStyleProfile, wSynthesize, wVerifyReview, type WDensity, type WEditorialMap, type WEditorialTrend, type WFactCheck, type WUsage } from "../wReviewAi";
import { useI18n } from "../i18n";

const W_CONTRACT_VERSION = 4;
const MAX_ITEMS = 25;
const HARD_MAX_ITEMS = 30;
const MAX_SAMPLES = 5;
const BATCH_MAX_ITEMS = 2; // Keep evidence calls small so completed cards survive an upstream model failure.
const BATCH_MAX_CHARS = 120_000;
const MAX_ITEM_CHARS = 24_000;

type WItem = {
  id: string; title: string; source: string; region: string; url: string;
  sourceText: string; editorialText: string; evidence: string; evidenceContract?: number;
};
type WSample = { id: string; name: string; text: string };
type WState = {
  items: WItem[];
  task: string;
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
  factCheck: WFactCheck | null;
  factCheckContract?: number;
  auditDecisions?: Record<string, {action:string;reason:string}>;
};

const STORAGE_KEY = "monitor-w-review-v1";
const EMPTY: WState = {
  items: [], task: "", targetChars: 3000, samples: [], styleProfile: "", styleContract: 0,
  editorialMap: null, mapContract: 0, selectedTrendIds: [],
  density: { quotes: "moderate", headlines: "moderate", experts: "moderate" }, reviewText: "", sectionTitles: [], boldPhrases: [],
  factCheck: null, factCheckContract: 0, auditDecisions: {},
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
      items: Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [],
      task: String(raw.task || "").slice(0, 500),
      targetChars: [1000, 2000, 3000, 6000, 8000].includes(Number(raw.targetChars)) ? Number(raw.targetChars) : 3000,
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
      items:Array.isArray(slot?.items)?slot.items.slice(0,MAX_ITEMS):[],
      targetChars:[1000,2000,3000,6000,8000].includes(Number(slot?.targetChars))?Number(slot.targetChars):3000,
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
        return {...slot,samples:updated.samples,styleProfile:updated.styleProfile,styleContract:updated.styleContract,
          reviewText:"",sectionTitles:[],boldPhrases:[],factCheck:null,factCheckContract:0};
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
  const [auditOpen,setAuditOpen] = useState(false);
  const [editFragment,setEditFragment] = useState("");
  const [replacement,setReplacement] = useState("");
  const [usage, setUsage] = useState<WUsage>({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

  useEffect(() => { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces)); }, [workspaces]);
  useEffect(() => { if (activeId && !state.items.some((item) => item.id === activeId)) setActiveId(state.items[0]?.id ?? null); }, [state.items, activeId]);

  function switchWorkspace(index:number) {
    if(busy || index===activeSlot) return;
    setWorkspaces(current=>({...current,activeSlot:index}));
    setActiveId(workspaces.slots[index].items[0]?.id??null);
    setUrl("");setManualOpen(false);setAnalysisText("");setMessage("");setError("");setAuditOpen(false);
  }
  function renameWorkspace(index:number,value:string) {
    setWorkspaces(current=>({...current,names:current.names.map((name,i)=>i===index?value.slice(0,60):name)}));
  }

  const active = state.items.find((item) => item.id === activeId) ?? state.items[0] ?? null;
  const totalChars = useMemo(() => state.items.reduce((sum, item) => sum + item.editorialText.length, 0), [state.items]);
  const prepared = state.items.filter((item) => item.evidence.trim() && item.evidenceContract === W_CONTRACT_VERSION).length;
  const mapReady = Boolean(state.editorialMap?.trends?.length && state.mapContract === W_CONTRACT_VERSION);
  const selectedTrends = mapReady ? state.editorialMap!.trends.filter((trend) => state.selectedTrendIds.includes(trend.id)) : [];
  const styleReady = Boolean(state.styleProfile.trim() && state.styleContract === W_CONTRACT_VERSION);
  const reviewReady = state.items.length > 0 && prepared === state.items.length && mapReady && selectedTrends.length > 0 && state.task.trim().length > 0;

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
    return items.map((item) => `ИСТОЧНИК: «${item.source}»\nЗАГОЛОВОК: ${item.title}\n${item.evidence}`);
  }

  function addItem(input: { title: string; source: string; region?: string; url?: string; text: string }) {
    if (state.items.length >= MAX_ITEMS) throw new Error("W_REVIEW_MAX_ITEMS");
    const text = input.text.trim();
    if (!input.title.trim() || !text) throw new Error("W_REVIEW_ITEM_REQUIRED");
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
    if (!state.task.trim()) { setError(be ? "Запоўніце заданне для агляду." : "Заполните задание для обзора."); return; }
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
        { task: state.task, evidenceCards: evidenceCards(next) },
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
    if (prepared !== state.items.length || !state.task.trim()) return;
    setBusy("map"); setError(""); setMessage("");
    try {
      const result = await wEditorialMap(
        { task: state.task, evidenceCards: evidenceCards(state.items) },
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
      task: "",
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
      setState((current) => ({ ...current, samples: [...current.samples, ...added].slice(0, MAX_SAMPLES), styleContract: 0, reviewText: "", factCheck: null, factCheckContract: 0 }));
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
        (seconds) => setMessage(be ? `Ліміт Groq. Профіль працягнецца праз ~${seconds} с…` : `Лимит Groq. Профиль продолжится автоматически через ~${seconds} с…`)
      );
      setState((current) => ({ ...current, styleProfile: result.styleProfile, styleContract: W_CONTRACT_VERSION, reviewText: "", factCheck: null, factCheckContract: 0 }));
      addUsage(result.usage);
      setMessage(be ? "Профіль стылю гатовы." : "Профиль стиля готов.");
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function synthesize() {
    if (!reviewReady) return;
    setBusy("synthesize"); setError(""); setMessage("");
    try {
      const result = await wSynthesize({
        task: state.task,
        targetChars: state.targetChars,
        evidenceCards: evidenceCards(state.items),
        styleProfile: styleReady ? state.styleProfile : "",
        trends: selectedTrends,
        density: state.density,
        sourceNames: Array.from(new Set(state.items.map((item) => item.source.trim()).filter(Boolean))),
      }, (seconds) => setMessage(be ? `Ліміт Groq. Генерацыя працягнецца праз ~${seconds} с…` : `Лимит Groq. Генерация продолжится автоматически через ~${seconds} с…`));
      setState((current) => ({
        ...current,
        reviewText: result.reviewText,
        sectionTitles: result.sectionTitles,
        boldPhrases: result.boldPhrases,
        factCheck: result.factCheck,
        factCheckContract: W_CONTRACT_VERSION,
        auditDecisions: {},
      }));
      setAuditOpen(!result.factCheck.verified);
      addUsage(result.usage);
      if (!result.factCheck.verified) {
        setError("Черновик сохранён, но факт-проверка недоступна: " + result.verificationError + ". Для экспорта необходимо отдельно нажать «Проверить факты».");
        return;
      }
      const removed = result.factCheck.unsupportedClaimsRemoved;
      const partial = result.factCheck.partialClaimsRewritten;
      setMessage(be
        ? `Агляд сфарміраваны і правераны па Evidence. Выпраўлена частковых: ${partial}, выдалена непацверджаных: ${removed}.`
        : `Обзор сформирован и проверен по Evidence. Исправлено частичных: ${partial}, удалено неподтверждённых: ${removed}.`);
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  async function verifyCurrentReview() {
    if (!state.reviewText.trim() || prepared !== state.items.length) return;
    setBusy("verify"); setError(""); setMessage("");
    try {
      const result = await wVerifyReview({
        task: state.task,
        reviewText: state.reviewText,
        evidenceCards: evidenceCards(state.items),
      }, (seconds) => setMessage(be ? `Ліміт AI. Праверка працягнецца праз ~${seconds} с…` : `Лимит AI. Проверка продолжится автоматически через ~${seconds} с…`));
      setState((current) => ({
        ...current,
        reviewText: result.verifiedText,
        sectionTitles: current.sectionTitles.filter((value) => result.verifiedText.includes(value)),
        boldPhrases: current.boldPhrases.filter((value) => result.verifiedText.includes(value)),
        factCheck: result.factCheck,
        factCheckContract: W_CONTRACT_VERSION,
      }));
      addUsage(result.usage);
      setMessage(be
        ? `Праверка завершана. Удакладнена: ${result.factCheck.partialClaimsRewritten}, выдалена непацверджаных: ${result.factCheck.unsupportedClaimsRemoved}.`
        : `Проверка завершена. Уточнено: ${result.factCheck.partialClaimsRewritten}, удалено неподтверждённых: ${result.factCheck.unsupportedClaimsRemoved}.`);
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  }

  function applyAuditEdit(action:"replace"|"delete") {
    if(!editFragment.trim() || !state.reviewText.includes(editFragment)) {
      setError("Укажите точный фрагмент, присутствующий в обзоре.");return;
    }
    if(action==="replace" && !replacement.trim()){setError("Введите исправленный текст.");return;}
    const next=state.reviewText.replace(editFragment,action==="delete"?"":replacement);
    setState(current=>({...current,reviewText:next,factCheck:null,factCheckContract:0,auditDecisions:{}}));
    setEditFragment("");setReplacement("");setAuditOpen(false);
    setMessage("Изменение сохранено. Для экспорта повторите проверку фактов.");
  }
  function ignoreAuditIssue(index:number) {
    setState(current=>({...current,auditDecisions:{...(current.auditDecisions||{}),[String(index)]:{action:"ignore",reason:"Решение оператора"}}}));
    setError("");
  }
  function approveEditorReview() {
    const issues=state.factCheck?.issues||[];
    if(!issues.length || issues.some((_,index)=>!state.auditDecisions?.[String(index)]))return;
    setState(current=>({...current,factCheck:current.factCheck?{...current.factCheck,verified:true}:null,factCheckContract:W_CONTRACT_VERSION}));
    setAuditOpen(false);
    setMessage("Замечания рассмотрены оператором. Исходный текст сохранён; экспорт DOCX доступен.");
  }

  async function exportDocx() {
    if (!state.reviewText.trim() || !state.factCheck?.verified || state.factCheckContract !== W_CONTRACT_VERSION) {
      setError(be ? "Перад экспартам патрэбна актуальная праверка фактаў па Evidence." : "Перед экспортом требуется актуальная проверка фактов по Evidence.");
      return;
    }
    const path = await save({ title: "W-Review DOCX", defaultPath: "W-Review.docx", filters: [{ name: "Word", extensions: ["docx"] }] });
    if (!path) return;
    await desktopApi.exportWReview(path, state.reviewText.trim(), Array.from(new Set(state.items.map((item) => item.source.trim()).filter(Boolean))), state.sectionTitles, state.boldPhrases);
    setMessage(be ? "DOCX захаваны ў фармаце W-Review." : "DOCX сохранён в формате W-Review.");
  }

  const densityOptions = <><option value="minimum">{be ? "мінімум" : "минимум"}</option><option value="moderate">{be ? "умерана" : "умеренно"}</option><option value="many">{be ? "многа" : "много"}</option><option value="all">{be ? "усе знойдзеныя" : "все найденные"}</option></>;
  if (section === "style") {
    return <div className="view-stack w-review w-review-style-page">
      <section className="view-heading"><div><div className="eyebrow dark">W-REVIEW</div><h2>{be ? "Аўтарскі стыль" : "Авторский стиль"}</h2><p>{be ? "Дадайце да 5 узораў DOCX/TXT і стварыце профіль, які будзе выкарыстоўвацца ў наступных аглядах." : "Добавьте до 5 образцов DOCX/TXT и создайте профиль, который будет использоваться в следующих обзорах."}</p></div><div className="w-review-style-heading-actions"><span className={`badge ${styleReady?"ready":""}`}>{styleReady?"✓":state.samples.length+"/"+MAX_SAMPLES}</span><button className="ghost-button w-review-close-button" onClick={onCloseStyle} aria-label={be?"Закрыць аўтарскі стыль":"Закрыть авторский стиль"} title={be?"Закрыць":"Закрыть"}>×</button></div></section>
      {message && <div className="notice success">{message}</div>}{error && <div className="notice error">{error}</div>}
      <section className="panel w-review-style"><div className="panel-head"><div><h3>{be?"Узоры і профіль":"Образцы и профиль"}</h3><p>{be?"Профіль можна выкарыстоўваць для многіх аглядаў без пераліку." : "Профиль можно использовать для многих обзоров без пересчёта."}</p></div></div>
        <div className="w-review-controls"><button className="secondary-button" disabled={busy!==""||state.samples.length>=MAX_SAMPLES} onClick={importSamples}>{busy==="sample"?"…":be?"Дадаць DOCX/TXT":"Добавить DOCX/TXT"}</button><button className="primary-button" disabled={busy!==""||!state.samples.length} onClick={buildStyleProfile}>{busy==="style"?"…":styleReady?(be?"Абнавіць профіль":"Обновить профиль"):(be?"Стварыць профіль стылю":"Создать профиль стиля")}</button></div>
        {state.samples.length>0&&<div className="w-review-samples">{state.samples.map((sample)=><div key={sample.id}><span>{sample.name}</span><button className="ghost-button small-button" onClick={()=>setState((current)=>({...current,samples:current.samples.filter((item)=>item.id!==sample.id),styleContract:0,reviewText:""}))}>×</button></div>)}</div>}
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
        <input aria-label={`Название темы ${index+1}`} disabled={busy!==""} value={name} onChange={event=>renameWorkspace(index,event.target.value)} style={{minWidth:0,width:140,border:"none",background:"transparent",fontWeight:index===activeSlot?700:400}}/>
        <span title={be?"Матэрыялаў у пуле":"Материалов в пуле"}>{workspaces.slots[index].items.length}</span>
      </div>)}
    </div>
    {message && <div className="notice success">{message}</div>}{error && <div className="notice error">{error}</div>}

    <section className="panel w-review-import"><div className="panel-head"><div><h3>{be ? "1. Матэрыялы" : "1. Материалы"}</h3><p>{be ? "Прамая загрузка, закладка → Monitor або ручны ўвод." : "Прямая загрузка, закладка → Monitor или ручной ввод."}</p></div></div>
      <div className="w-review-import-row"><input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://…" /><button className="secondary-button" onClick={importUrl} disabled={busy!==""||!url.trim()||state.items.length>=MAX_ITEMS}>{busy==="url"?"…":be?"Спампаваць":"Скачать"}</button><button className="primary-button" onClick={pasteBrowser} disabled={busy!==""||state.items.length>=MAX_ITEMS}>{busy==="clipboard"?"…":be?"Уставіць з браўзера":"Вставить из браузера"}</button><button className="ghost-button" onClick={()=>setManualOpen((v)=>!v)}>{be?"Дадаць уручную":"Добавить вручную"}</button><button className="ghost-button" onClick={copyBookmarklet}>→ Monitor</button></div>
      {manualOpen&&<div className="w-review-manual"><input placeholder={be?"Загаловак":"Заголовок"} value={manual.title} onChange={(e)=>setManual({...manual,title:e.target.value})}/><input placeholder={be?"Крыніца":"Источник"} value={manual.source} onChange={(e)=>setManual({...manual,source:e.target.value})}/><input placeholder={be?"Краіна / рэгіён":"Страна / регион"} value={manual.region} onChange={(e)=>setManual({...manual,region:e.target.value})}/><input placeholder="URL" value={manual.url} onChange={(e)=>setManual({...manual,url:e.target.value})}/><textarea placeholder={be?"Тэкст публікацыі":"Текст публикации"} value={manual.text} onChange={(e)=>setManual({...manual,text:e.target.value})}/><button className="primary-button" onClick={()=>{try{addItem(manual);setManual({title:"",source:"",region:"",url:"",text:""});setManualOpen(false)}catch(reason){setError(String(reason))}}}>{be?"Дадаць":"Добавить"}</button></div>}
    </section>

    <section className="panel w-review-task"><div className="panel-head"><div><h3>{be?"2. Заданне":"2. Задание"}</h3><p>{be?"Да 500 знакаў — тэма і патрэбныя акцэнты.":"До 500 знаков — тема и нужные акценты."}</p></div></div><textarea maxLength={500} value={state.task} onChange={(e)=>setState((current)=>invalidateMap({...current,task:e.target.value}))} placeholder={be?"Што прааналізаваць і на чым зрабіць акцэнт…":"Что проанализировать и на чем сделать акцент…"}/><div className="w-review-controls"><span>{state.task.length}/500</span></div></section>

    <section className="w-review-grid">
      <aside className="panel w-review-pool"><div className="panel-head"><div><h3>{be?"Пул матэрыялаў":"Пул материалов"}</h3><p>{state.items.length ? (prepared === state.items.length ? (be?"усе матэрыялы гатовыя да аналізу":"все материалы проанализированы") : (be?`прааналізавана ${prepared} з ${state.items.length}`:`проанализировано ${prepared} из ${state.items.length}`)) : (be?"пакуль пуста":"пока пусто")}</p></div><button className="ghost-button small-button" disabled={busy!==""||!state.items.length} onClick={clearPool}>{be?"Ачысціць":"Очистить"}</button></div>
        {state.items.map((item,index)=><button key={item.id} className={`w-review-item ${active?.id===item.id?"active":""}`} onClick={()=>setActiveId(item.id)}><span>P{String(index+1).padStart(2,"0")}</span><div><b>{item.title}</b><small>{item.source}{item.evidence&&item.evidenceContract===W_CONTRACT_VERSION?" · ✓":""}</small></div></button>)}
        <div className="w-review-pool-action"><button className="primary-button" disabled={busy!==""||!state.items.length} onClick={analyzePool}>{analysisButtonText}</button>{busy==="analyze"&&<small>{analysisText}</small>}{error&&<small style={{color:"#b42318",whiteSpace:"normal"}}>{error}</small>}{!state.task.trim()&&state.items.length>0&&<small>{be?"Для аналізу спачатку запоўніце заданне вышэй.":"Для анализа сначала заполните задание выше."}</small>}</div>
      </aside>
      <div className="panel w-review-editor">{active?<><div className="panel-head"><div><h3>{active.title}</h3><p>{active.source}{active.region?` · ${active.region}`:""}</p></div><button className="ghost-button small-button" onClick={()=>setState((current)=>invalidateMap({...current,items:current.items.filter((item)=>item.id!==active.id)}))}>{be?"Выдаліць":"Удалить"}</button></div><div className="w-review-exact"><select value={compressionMode} onChange={(e)=>setCompressionMode(e.target.value as CompressionMode)}><option value="light">20–30%</option><option value="standard">30–50%</option><option value="maximum">50–70%</option><option value="extract">70–90%</option></select><button className="secondary-button small-button" onClick={exact}>Exact</button><button className="ghost-button small-button" onClick={()=>updateItem(active.id,{editorialText:active.sourceText})}>{be?"Вярнуць зыходны":"Вернуть исходный"}</button></div><textarea className="report-editor-textarea" lang={be?"be":"ru"} spellCheck={true} value={active.editorialText} onChange={(e)=>updateItem(active.id,{editorialText:e.target.value})}/></>:<div className="report-empty">{be?"Выберыце матэрыял.":"Выберите материал."}</div>}</div>
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
      <div className="w-review-readiness"><span className={prepared===state.items.length&&state.items.length?"ready":""}>{prepared===state.items.length&&state.items.length?"✓":"○"} {be?"Матэрыялы прааналізаваны":"Материалы проанализированы"}</span><span className={selectedTrends.length?"ready":""}>{selectedTrends.length?"✓":"○"} {be?"Тэндэнцыі выбраны":"Тенденции выбраны"}</span><span className={state.task.trim()?"ready":""}>{state.task.trim()?"✓":"○"} {be?"Заданне запоўнена":"Задание заполнено"}</span><span className={styleReady?"ready optional": "optional"}>{styleReady?"✓":"○"} {be?"Профіль стылю":"Профиль стиля"} ({be?"неабавязкова":"необязательно"})</span></div>
      <div className="w-review-final-actions"><label className="w-review-length-control"><span>{be?"Аб\’ём, знакаў":"Объём, знаков"}</span><select value={state.targetChars} onChange={(e)=>setState({...state,targetChars:Number(e.target.value),reviewText:"",sectionTitles:[],boldPhrases:[],factCheck:null,factCheckContract:0})}><option value={1000}>1 000</option><option value={2000}>2 000</option><option value={3000}>3 000</option><option value={6000}>6 000</option><option value={8000}>8 000</option></select></label><button className="primary-button" disabled={busy!==""||!reviewReady} onClick={synthesize}>{busy==="synthesize"?"…":be?"Сфарміраваць агляд":"Сформировать обзор"}</button><button className="secondary-button" disabled={busy!==""||!state.reviewText.trim()||prepared!==state.items.length} onClick={verifyCurrentReview}>{busy==="verify"?"…":be?"Праверыць факты":"Проверить факты"}</button><button className="secondary-button" disabled={!state.reviewText.trim()||!state.factCheck?.verified||state.factCheckContract!==W_CONTRACT_VERSION} onClick={exportDocx}>DOCX</button></div>
      <textarea className="report-editor-textarea w-review-final-text" lang={be?"be":"ru"} spellCheck={true} value={state.reviewText} onChange={(e)=>setState({...state,reviewText:e.target.value,factCheck:null,factCheckContract:0})} placeholder={be?"Тут з'явіцца выніковы агляд…":"Здесь появится итоговый обзор…"}/>
      {state.reviewText.trim()&&<div className={`w-review-fact-check ${state.factCheck?.verified&&state.factCheckContract===W_CONTRACT_VERSION?"verified":"pending"}`}>
        {state.factCheck?.verified&&state.factCheckContract===W_CONTRACT_VERSION
          ? <><b>✓ {be?"Факты правераны па Evidence":"Факты проверены по Evidence"}</b><span>{be?"сцвярджэнняў":"утверждений"}: {state.factCheck.claimsTotal} · {be?"падцверджана":"подтверждено"}: {state.factCheck.supportedClaims} · {be?"удакладнена":"уточнено"}: {state.factCheck.partialClaimsRewritten} · {be?"выдалена":"удалено"}: {state.factCheck.unsupportedClaimsRemoved}</span></>
          : <><b>{be?"○ Патрабуецца праверка фактаў":"○ Требуется проверка фактов"}</b><span>{be?"Пасля ручной праўкі экспарт заблакаваны да новай генерацыі/праверкі.":"После ручной правки экспорт заблокирован до новой генерации/проверки."}</span></>}
      </div>}
      {state.factCheck?.issues?.length>0 && !state.factCheck.verified && <button className="secondary-button" onClick={()=>setAuditOpen(true)}>Замечания к факт-проверке ({state.factCheck.issues.length})</button>}
      {auditOpen && state.factCheck && <div role="dialog" aria-modal="true" aria-label="Редакторская проверка фактов" style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,.55)",display:"flex",justifyContent:"center",alignItems:"center",padding:20}}>
        <div style={{background:"var(--surface,#fff)",color:"var(--text,#222)",padding:22,borderRadius:12,maxWidth:850,width:"100%",maxHeight:"90vh",overflowY:"auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}><h3>Замечания к факт-проверке</h3><button className="secondary-button" onClick={()=>setAuditOpen(false)}>Закрыть</button></div>
          <p>Черновик не изменён. Оценочные и тенденциозные суждения допустимы при явной атрибуции автору. Проверяйте отдельно фактические утверждения внутри цитат: их нельзя выдавать за установленные факты. Игнорирование — ответственное решение оператора.</p>
          {state.factCheck.issues.map((issue,index)=><div key={index} style={{padding:12,border:"1px solid #8885",borderRadius:8,marginBottom:12}}>
            <b>{index+1}. {issue}</b>
            {state.auditDecisions?.[String(index)] ? <p>✓ Замечание проигнорировано оператором; исходный текст сохранён</p> :
            <div style={{display:"grid",gap:8,marginTop:10}}>
              <label>Фрагмент в обзоре (вставьте точную цитату для замены или удаления)<textarea rows={2} value={editFragment} onChange={e=>setEditFragment(e.target.value)} /></label>
              <label>Исправленная редакция<textarea rows={2} value={replacement} onChange={e=>setReplacement(e.target.value)} /></label>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><button className="secondary-button" onClick={()=>applyAuditEdit("replace")}>Исправить / переписать</button><button className="secondary-button" onClick={()=>applyAuditEdit("delete")}>Удалить фрагмент</button></div>
              <button className="secondary-button" onClick={()=>ignoreAuditIssue(index)}>Игнорировать замечание</button>
            </div>}
          </div>)}
          <button className="primary-button" disabled={!state.factCheck.issues.length || state.factCheck.issues.some((_,index)=>!state.auditDecisions?.[String(index)])} onClick={approveEditorReview}>Подтвердить редакторские решения и разрешить экспорт</button>
        </div>
      </div>}
      <div className="w-review-usage">{be?"Сімвалаў":"Символов"}: {state.reviewText.length.toLocaleString()} · {be?"Токенаў у гэтай сесіі":"Токенов в этой сессии"}: {usage.totalTokens.toLocaleString()}</div>
    </section>
  </div>;
}
