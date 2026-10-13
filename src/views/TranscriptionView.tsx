import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { compressionReduction, exactCompressForProfile, type CompressionMode } from "../editorialCompression";
import { useI18n } from "../i18n";
import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "../workroom";
import { TIKTOK_COMMENTS_BOOKMARKLET, parseTikTokCommentsCapture, type TikTokCapturedComment } from "../tiktokComments";

type TranscriptComment = TikTokCapturedComment & { id: string };

type TranscriptionState = {
  url: string;
  title: string;
  rawText: string;
  editorialText: string;
  language: string;
  duration: number;
  comments: TranscriptComment[];
  accents: string[];
  commentMode: "popular" | "latest";
};

const STORAGE_KEY = "monitor-transcription-v1";
const EMPTY: TranscriptionState = {
  url: "",
  title: "",
  rawText: "",
  editorialText: "",
  language: "",
  duration: 0,
  comments: [],
  accents: [],
  commentMode: "popular",
};

function loadState(): TranscriptionState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<TranscriptionState> | null;
    if (!raw) return EMPTY;
    return {
      url: String(raw.url || ""),
      title: String(raw.title || ""),
      rawText: String(raw.rawText || ""),
      editorialText: String(raw.editorialText || ""),
      language: String(raw.language || ""),
      duration: Math.max(0, Number(raw.duration || 0)),
      comments: Array.isArray(raw.comments)
        ? raw.comments.slice(0, 20).map((item, index) => ({
            id: String((item as TranscriptComment).id || `comment-${index}`),
            text: String((item as TranscriptComment).text || ""),
            likes: Math.max(0, Number((item as TranscriptComment).likes || 0)),
            order: Number((item as TranscriptComment).order || index),
          })).filter((item) => item.text.trim())
        : [],
      accents: Array.isArray(raw.accents) ? raw.accents.map(String).filter(Boolean).slice(0, 40) : [],
      commentMode: raw.commentMode === "latest" ? "latest" : "popular",
    };
  } catch { return EMPTY; }
}

function commentId(index: number) {
  return `comment:${Date.now()}:${index}:${Math.random().toString(36).slice(2, 7)}`;
}

export function TranscriptionView() {
  const { locale } = useI18n();
  const be = locale === "be";
  const [state, setState] = useState<TranscriptionState>(loadState);
  const [inputUrl, setInputUrl] = useState(state.url);
  const [busy, setBusy] = useState("");
  const [exactMode, setExactMode] = useState<CompressionMode>("light");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const transcriptRef = useRef<HTMLTextAreaElement | null>(null);
  const commentRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }, [state]);

  async function transcribe() {
    const url = inputUrl.trim();
    if (!url) return;
    setBusy("transcribe"); setError(""); setMessage("");
    try {
      const config = loadWorkroomConfig();
      const session = await ensureWorkroomSession(config, loadWorkroomSession());
      const result = await desktopApi.transcribeTikTok(url, config.url, config.anonKey, session.accessToken);
      setState((current) => ({
        ...current,
        url: result.url || url,
        title: result.title || "TikTok",
        rawText: result.text,
        editorialText: result.text,
        language: result.language,
        duration: result.duration,
        comments: [],
        accents: [],
      }));
      setInputUrl(result.url || url);
      setMessage(be ? "Транскрыпцыя гатовая. Тэкст можна рэдагаваць і скарачаць." : "Транскрипция готова. Текст можно редактировать и сокращать.");
    } catch (reason) {
      setError(String(reason));
    } finally { setBusy(""); }
  }

  async function openTikTok() {
    const url = (state.url || inputUrl).trim();
    if (!url) return;
    try { await desktopApi.openUrl(url); } catch (reason) { setError(String(reason)); }
  }

  async function copyCommentsBookmarklet() {
    try {
      await desktopApi.writeClipboardText(TIKTOK_COMMENTS_BOOKMARKLET);
      setMessage(be
        ? "Код закладкі скапіраваны. Захавайце яго як закладку браўзера «→ Monitor: каментары»."
        : "Код закладки скопирован. Сохраните его как закладку браузера «→ Monitor: комментарии».");
    } catch (reason) { setError(String(reason)); }
  }

  async function pasteComments() {
    setBusy("comments"); setError(""); setMessage("");
    try {
      const capture = parseTikTokCommentsCapture(await desktopApi.readClipboardText());
      const source = [...capture.comments];
      const ordered = state.commentMode === "popular" && source.some((item) => item.likes > 0)
        ? source.sort((a, b) => b.likes - a.likes || a.order - b.order)
        : source.sort((a, b) => a.order - b.order);
      const selected = ordered.slice(0, 20).map((item, index) => ({ ...item, id: commentId(index) }));
      setState((current) => ({ ...current, comments: selected }));
      setMessage(be
        ? `Дададзена каментарыяў: ${selected.length}.`
        : `Добавлено комментариев: ${selected.length}.`);
    } catch (reason) {
      setError(be
        ? "У буферы няма карэктнага захопу каментарыяў TikTok. Адкрыйце ролік, загрузіце каментарыі і націсніце закладку «→ Monitor: каментары»."
        : "В буфере нет корректного захвата комментариев TikTok. Откройте ролик, загрузите комментарии и нажмите закладку «→ Monitor: комментарии».");
    } finally { setBusy(""); }
  }

  function addAccent(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).trim();
    if (selected.length < 3) {
      setError(be ? "Спачатку вылучыце патрэбны фрагмент тэксту." : "Сначала выделите нужный фрагмент текста.");
      return;
    }
    setError("");
    setState((current) => current.accents.includes(selected)
      ? current
      : { ...current, accents: [...current.accents, selected].slice(0, 40) });
  }

  function applyExactCompression() {
    const source = state.editorialText.trim();
    if (!source) return;
    const result = exactCompressForProfile(source, exactMode, "l");
    if (result.reductionPct <= 0 || result.text === source) {
      setError(be ? "Для гэтага тэксту Exact не знайшоў бяспечнага скарачэння. Можна абраць іншы ўзровень." : "Для этого текста Exact не нашёл подходящего сокращения. Можно выбрать другой уровень.");
      setMessage("");
      return;
    }
    setError("");
    setState((current) => ({ ...current, editorialText: result.text }));
    setMessage(be
      ? `Exact: скарочана на ${result.reductionPct}% ад папярэдняй версіі; сумарна ${compressionReduction(state.rawText || source, result.text)}% ад арыгінала.`
      : `Exact: сокращено на ${result.reductionPct}% от предыдущей версии; суммарно ${compressionReduction(state.rawText || source, result.text)}% от оригинала.`);
  }

  function clearAll() {
    setState(EMPTY);
    setInputUrl("");
    setMessage("");
    setError("");
  }

  async function exportDocx() {
    if (!state.editorialText.trim()) return;
    setBusy("export"); setError(""); setMessage("");
    try {
      const path = await save({
        title: be ? "Экспарт транскрыпцыі" : "Экспорт транскрипции",
        defaultPath: "Транскрипция TikTok.docx",
        filters: [{ name: "Word", extensions: ["docx"] }],
      });
      if (!path) return;
      await desktopApi.exportTikTokTranscript(
        path,
        state.editorialText.trim(),
        state.comments.map((item) => item.text.trim()).filter(Boolean),
        state.accents,
      );
      setMessage(be ? "DOCX захаваны па зададзеным узоры." : "DOCX сохранён по заданному образцу.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  const duration = state.duration > 0 ? `${Math.round(state.duration)} с` : "—";

  return <div className="view-stack transcription-view">
    <section className="view-heading">
      <div><div className="eyebrow dark">TRANSCRIPTION</div><h2>{be ? "Транскрыпцыя TikTok" : "Транскрипция TikTok"}</h2><p>{be ? "Відэа → тэкст → каментарыі → рэдагаванне → DOCX." : "Видео → текст → комментарии → редактирование → DOCX."}</p></div>
      <div className="transcription-meta"><b>{state.title || "TikTok"}</b><span>{state.language || "—"} · {duration}</span></div>
    </section>

    {message && <div className="notice success">{message}</div>}
    {error && <div className="notice error">{error}</div>}

    <section className="panel transcription-source">
      <div className="panel-head"><div><h3>{be ? "1. Відэа" : "1. Видео"}</h3><p>{be ? "Устаўце публічную спасылку TikTok." : "Вставьте публичную ссылку TikTok."}</p></div><button className="ghost-button small-button" disabled={busy!==""} onClick={clearAll}>{be ? "Ачысціць" : "Очистить"}</button></div>
      <div className="transcription-url-row">
        <input value={inputUrl} onChange={(e) => setInputUrl(e.target.value)} placeholder="https://www.tiktok.com/@…/video/…" />
        <button className="primary-button" disabled={busy!==""||!inputUrl.trim()} onClick={transcribe}>{busy==="transcribe"?"…":be?"Транскрыбаваць":"Транскрибировать"}</button>
      </div>
    </section>

    <section className="panel transcription-text">
      <div className="panel-head"><div><h3>{be ? "2. Тэкст" : "2. Текст"}</h3><p>{be ? "Рэдагуйце і скарачайце расшыфроўку перад экспартам." : "Редактируйте и сокращайте расшифровку перед экспортом."}</p></div><div className="transcription-inline-actions"><button className="secondary-button small-button" disabled={!state.editorialText} onClick={() => addAccent(transcriptRef.current)}>{be ? "Акцэнт" : "Акцент"}</button><button className="ghost-button small-button" disabled={!state.rawText} onClick={() => setState((current) => ({ ...current, editorialText: current.rawText, accents: [] }))}>{be ? "Вярнуць зыходны" : "Вернуть исходный"}</button></div></div>
      <div className="report-compression-panel">
        <div className="report-compression-head">
          <div><b>Exact</b><span>{be ? "Скарачэнне без дадання новых фактаў" : "Сокращение без добавления новых фактов"}</span></div>
          <label><select value={exactMode} disabled={busy!=="" || !state.editorialText.trim()} onChange={(e) => setExactMode(e.target.value as CompressionMode)}>
            <option value="light">{be ? "Мінімальнае 20–30%" : "Минимальное 20–30%"}</option>
            <option value="standard">{be ? "Стандарт 30–50%" : "Стандарт 30–50%"}</option>
            <option value="maximum">{be ? "Максімальнае 50–70%" : "Максимальное 50–70%"}</option>
            <option value="extract">{be ? "Экстракт 70–90%" : "Экстракт 70–90%"}</option>
          </select></label>
        </div>
        <div className="report-compression-actions">
          <button className="secondary-button small-button" disabled={busy!=="" || !state.editorialText.trim()} onClick={applyExactCompression}>{be ? "Скараціць Exact" : "Сократить Exact"}</button>
          <span>{be ? "Скарочана ад арыгінала" : "Сокращено от исходного"}: {compressionReduction(state.rawText, state.editorialText)}%</span>
        </div>
      </div>
      <textarea ref={transcriptRef} className="report-editor-textarea transcription-main-editor" spellCheck={true} value={state.editorialText} onChange={(e) => setState((current) => ({ ...current, editorialText: e.target.value }))} placeholder={be ? "Тут з'явіцца транскрыпцыя…" : "Здесь появится транскрипция…"} />
      {state.accents.length>0&&<div className="transcription-accents"><span>{be?"Акцэнты для DOCX:":"Акценты для DOCX:"}</span>{state.accents.map((accent)=><button key={accent} className="accent-chip" title={be?"Прыбраць акцэнт":"Убрать акцент"} onClick={()=>setState((current)=>({...current,accents:current.accents.filter((item)=>item!==accent)}))}>{accent.length>70?`${accent.slice(0,68)}…`:accent}<b>×</b></button>)}</div>}
    </section>

    <section className="panel transcription-comments">
      <div className="panel-head"><div><h3>{be ? "3. Каментарыі" : "3. Комментарии"}</h3><p>{be ? "Да 20 змястоўных каментарыяў, даўжэйшых за 15 знакаў." : "До 20 содержательных комментариев длиннее 15 символов."}</p></div><span className="badge">{state.comments.length}/20</span></div>
      <div className="transcription-comment-tools">
        <button className="secondary-button" disabled={!state.url&&!inputUrl.trim()} onClick={openTikTok}>{be?"Адкрыць TikTok":"Открыть TikTok"}</button>
        <button className="ghost-button" onClick={copyCommentsBookmarklet}>{be?"Скапіраваць закладку каментарыяў":"Скопировать закладку комментариев"}</button>
        <button className="primary-button" disabled={busy!==""} onClick={pasteComments}>{busy==="comments"?"…":be?"Уставіць каментарыі":"Вставить комментарии"}</button>
        <label><span>{be?"Парадак":"Порядок"}</span><select value={state.commentMode} onChange={(e)=>setState((current)=>({...current,commentMode:e.target.value==="latest"?"latest":"popular"}))}><option value="popular">{be?"Папулярныя":"Популярные"}</option><option value="latest">{be?"Апошнія / як у TikTok":"Последние / как в TikTok"}</option></select></label>
      </div>
      <p className="transcription-comment-hint">{be
        ? "У браўзеры адкрыйце каментарыі і пракруціце, каб загрузіць патрэбную колькасць. Для апошніх спачатку выберыце адпаведны парадак у TikTok, калі ён даступны; затым націсніце закладку і вярніцеся ў Monitor."
        : "В браузере откройте комментарии и прокрутите, чтобы загрузить нужное количество. Для последних сначала выберите соответствующий порядок в TikTok, если он доступен; затем нажмите закладку и вернитесь в Monitor."}</p>
      <div className="transcription-comment-list">
        {state.comments.length===0&&<div className="report-empty">{be?"Каментарыі пакуль не дададзены.":"Комментарии пока не добавлены."}</div>}
        {state.comments.map((comment,index)=><div key={comment.id} className="transcription-comment-row">
          <div className="transcription-comment-number">{index+1}</div>
          <textarea ref={(node)=>{commentRefs.current[comment.id]=node;}} spellCheck={true} value={comment.text} onChange={(e)=>setState((current)=>({...current,comments:current.comments.map((item)=>item.id===comment.id?{...item,text:e.target.value}:item)}))}/>
          <div className="transcription-comment-actions">{comment.likes>0&&<small>♥ {comment.likes.toLocaleString()}</small>}<button className="ghost-button small-button" onClick={()=>addAccent(commentRefs.current[comment.id])}>{be?"Акцэнт":"Акцент"}</button><button className="ghost-button small-button" onClick={()=>setState((current)=>({...current,comments:current.comments.filter((item)=>item.id!==comment.id)}))}>×</button></div>
        </div>)}
      </div>
    </section>

    <section className="panel transcription-export">
      <div className="panel-head"><div><h3>{be ? "4. Экспарт" : "4. Экспорт"}</h3><p>{be ? "Times New Roman 16 pt, чырвоны радок 1,27 см, выраўноўванне па шырыні; акцэнты — паўтлусты курсіў." : "Times New Roman 16 pt, красная строка 1,27 см, выравнивание по ширине; акценты — полужирный курсив."}</p></div><button className="primary-button" disabled={busy!==""||!state.editorialText.trim()} onClick={exportDocx}>{busy==="export"?"…":"DOCX"}</button></div>
    </section>
  </div>;
}
