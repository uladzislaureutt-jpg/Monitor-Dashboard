import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { desktopApi } from "../api";
import { compressionReduction, exactCompressForProfile, type CompressionMode } from "../editorialCompression";
import { useI18n } from "../i18n";
import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "../workroom";
import { parseTikTokCommentsClipboard, type TikTokCapturedComment } from "../tiktokComments";

type TranscriptComment = TikTokCapturedComment & { id: string };

type TranscriptionState = {
  url: string;
  title: string;
  rawText: string;
  editorialText: string;
  language: string;
  duration: number;
  comments: TranscriptComment[];
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
        ? raw.comments.slice(0, 30).map((item, index) => ({
            id: String((item as TranscriptComment).id || `comment-${index}`),
            text: String((item as TranscriptComment).text || ""),
            likes: Math.max(0, Number((item as TranscriptComment).likes || 0)),
            order: Number((item as TranscriptComment).order || index),
          })).filter((item) => item.text.trim())
        : [],
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
  const [videoSource, setVideoSource] = useState<"tiktok"|"telegram">(state.url.includes("t.me/") ? "telegram" : "tiktok");
  const [busy, setBusy] = useState("");
  const [exactMode, setExactMode] = useState<CompressionMode>("light");
  const [aiRuns, setAiRuns] = useState(() => Math.min(2, Number(localStorage.getItem(`transcription-ai-runs:${state.url}`) || 0) || 0));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

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
      }));
      setInputUrl(result.url || url);
      setAiRuns(Math.min(2, Number(localStorage.getItem(`transcription-ai-runs:${result.url || url}`) || 0) || 0));
      setMessage(be ? "Транскрыпцыя гатовая. Тэкст можна рэдагаваць і скарачаць." : "Транскрипция готова. Текст можно редактировать и сокращать.");
    } catch (reason) {
      setError(String(reason));
    } finally { setBusy(""); }
  }

  async function importVideoFile() {
    setBusy("transcribe"); setError(""); setMessage("");
    try {
      const path = await open({ multiple: false, filters: [{ name: "Видео или аудио", extensions: ["mp4","mov","m4a","mp3","wav","webm","ogg","opus","mpeg","mpga"] }] });
      if (!path || Array.isArray(path)) return;
      const config = loadWorkroomConfig();
      const session = await ensureWorkroomSession(config, loadWorkroomSession());
      const result = await desktopApi.transcribeLocalVideo(path, config.url, config.anonKey, session.accessToken);
      setState((current) => ({ ...current, title: result.title || "Telegram", url: inputUrl.trim(), rawText: result.text, editorialText: result.text, language: result.language, duration: result.duration, comments: [] }));
      setMessage(be ? "Транскрыпцыя файла гатовая." : "Транскрипция файла готова.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  async function openTikTok() {
    const url = (state.url || inputUrl).trim();
    if (!url) return;
    try { await desktopApi.openUrl(url); } catch (reason) { setError(String(reason)); }
  }

  async function pasteComments() {
    setBusy("comments"); setError(""); setMessage("");
    try {
      const source = parseTikTokCommentsClipboard(await desktopApi.readClipboardText());
      if (source.length === 0) throw new Error("no_comments");
      const ordered = state.commentMode === "popular" && source.some((item) => item.likes > 0)
        ? source.sort((a, b) => b.likes - a.likes || a.order - b.order)
        : source.sort((a, b) => a.order - b.order);
      const selected = ordered.slice(0, 30).map((item, index) => ({ ...item, id: commentId(index) }));
      setState((current) => ({ ...current, comments: selected }));
      setMessage(be
        ? `Дададзена каментарыяў: ${selected.length}.`
        : `Добавлено комментариев: ${selected.length}.`);
    } catch (_reason) {
      setError(be
        ? "У буферы няма патрэбных каментарыяў. Вылучыце тэкст каментарыяў у TikTok, націсніце Ctrl+C і паўтарыце ўстаўку."
        : "В буфере нет подходящих комментариев. Выделите текст комментариев на странице TikTok, нажмите Ctrl+C и повторите вставку.");
    } finally { setBusy(""); }
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

  async function applyGeminiEdit() {
    const text = state.editorialText.trim();
    if (!text || aiRuns >= 2 || busy) return;
    setBusy("gemini"); setError(""); setMessage("");
    try {
      const config = loadWorkroomConfig();
      const session = await ensureWorkroomSession(config, loadWorkroomSession());
      const version = await getVersion();
      const response = await fetch(`${config.url.replace(/\/+$/, "")}/functions/v1/transcription-edit`, {
        method: "POST",
        headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text, app_version: version }),
      });
      const data = await response.json() as { edited_text?: string; error?: string; model?: string; status?: number };
      if (!response.ok || !data.edited_text) throw new Error(`${data.error || "gemini_failed"}${data.status ? ` (${data.status})` : ""}`);
      const key = `transcription-ai-runs:${state.url || inputUrl}`;
      const used = Math.min(2, aiRuns + 1);
      localStorage.setItem(key, String(used));
      setAiRuns(used);
      setState((current) => ({ ...current, editorialText: data.edited_text || current.editorialText }));
      setMessage(be ? `Gemini: тэкст адрэдагаваны. Выкарыстана ${used}/2.` : `Gemini: текст отредактирован. Использовано ${used}/2.`);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  function clearAll() {
    setState(EMPTY);
    setInputUrl("");
    setAiRuns(0);
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
        [new URL(state.url || inputUrl).pathname.match(/^\/@([^/]+)/)?.[1] || ""],
      );
      setMessage(be ? "DOCX захаваны па зададзеным узоры." : "DOCX сохранён по заданному образцу.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(""); }
  }

  const duration = state.duration > 0 ? `${Math.round(state.duration)} с` : "—";

  return <div className="view-stack transcription-view">
    <section className="view-heading">
      <div><div className="eyebrow dark">TRANSCRIPTION</div><h2>{be ? "Транскрыпцыя відэа" : "Транскрипция видео"}</h2><p>{be ? "Відэа → тэкст → каментарыі → рэдагаванне → DOCX." : "Видео → текст → комментарии → редактирование → DOCX."}</p></div>
      <div className="transcription-meta"><b>{state.title || "TikTok"}</b><span>{state.language || "—"} · {duration}</span></div>
    </section>

    {message && <div className="notice success">{message}</div>}
    {error && <div className="notice error">{error}</div>}

    <section className="panel transcription-source">
      <div className="panel-head"><div><h3>{be ? "1. Відэа" : "1. Видео"}</h3><p>{be ? "Устаўце публічную спасылку TikTok." : "Вставьте публичную ссылку TikTok."}</p></div><button className="ghost-button small-button" disabled={busy!==""} onClick={clearAll}>{be ? "Ачысціць" : "Очистить"}</button></div>
      <div className="transcription-inline-actions"><button className={videoSource==="tiktok"?"primary-button small-button":"ghost-button small-button"} onClick={()=>setVideoSource("tiktok")}>TikTok</button><button className={videoSource==="telegram"?"primary-button small-button":"ghost-button small-button"} onClick={()=>setVideoSource("telegram")}>Telegram</button></div>
      <div className="transcription-url-row">
        <input value={inputUrl} onChange={(e) => setInputUrl(e.target.value)} placeholder={videoSource==="telegram"?"https://t.me/channel/12345":"https://www.tiktok.com/@…/video/…"} />
        <button className="primary-button" disabled={busy!==""||!inputUrl.trim()} onClick={transcribe}>{busy==="transcribe"?"…":be?"Транскрыбаваць":"Транскрибировать"}</button>
      </div>
      {videoSource==="telegram"&&<div className="transcription-inline-actions"><button className="secondary-button small-button" disabled={busy!==""} onClick={importVideoFile}>{be?"Выбраць відэафайл":"Выбрать видеофайл"}</button><span>{be?"Калі відэа па спасылцы недаступна, захавайце яго з Telegram (да 22 МБ).":"Если видео по ссылке недоступно, сохраните его из Telegram (до 22 МБ)."}</span></div>}
    </section>

    <section className="panel transcription-text">
      <div className="panel-head"><div><h3>{be ? "2. Тэкст" : "2. Текст"}</h3><p>{be ? "Арыгінал застаецца без змен, рэдагуецца толькі тэкст для экспарту." : "Исходный текст сохраняется, редактируется только версия для экспорта."}</p></div></div>
      <div className="transcription-text-columns">
        <div className="transcription-text-pane">
          <div className="panel-head"><b>{be ? "Зыходная транскрыпцыя" : "Исходная транскрипция"}</b></div>
          <textarea className="report-editor-textarea transcription-main-editor" readOnly value={state.rawText} placeholder={be ? "Тут з'явіцца арыгінальная транскрыпцыя…" : "Здесь появится исходная транскрипция…"} />
        </div>
        <div className="transcription-text-pane">
          <div className="panel-head"><b>{be ? "Тэкст для экспарту" : "Текст для экспорта"}</b><button className="ghost-button small-button" disabled={!state.rawText || busy!==""} onClick={() => setState((current) => ({ ...current, editorialText: current.rawText }))}>{be ? "Вярнуць зыходны" : "Вернуть исходный"}</button></div>
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
          <button className="secondary-button small-button" disabled={busy!=="" || !state.editorialText.trim() || aiRuns>=2} onClick={applyGeminiEdit}>{busy==="gemini" ? "Gemini…" : (be ? "Рэдагаваць Gemini" : "Редактировать Gemini")}</button>
          <span>Gemini: {aiRuns}/2</span>
          <span>{be ? "Скарочана ад арыгінала" : "Сокращено от исходного"}: {compressionReduction(state.rawText, state.editorialText)}%</span>
        </div>
      </div>
      <textarea className="report-editor-textarea transcription-main-editor" spellCheck={true} value={state.editorialText} onChange={(e) => setState((current) => ({ ...current, editorialText: e.target.value }))} placeholder={be ? "Тут з'явіцца транскрыпцыя…" : "Здесь появится транскрипция…"} />
        </div>
      </div>
    </section>

    <section className="panel transcription-comments">
      <div className="panel-head"><div><h3>{be ? "3. Каментарыі" : "3. Комментарии"}</h3><p>{be ? "Да 30 змястоўных каментарыяў, даўжэйшых за 15 знакаў." : "До 30 содержательных комментариев длиннее 15 символов."}</p></div><span className="badge">{state.comments.length}/30</span></div>
      <div className="transcription-comment-tools">
        <button className="secondary-button" disabled={!state.url&&!inputUrl.trim()} onClick={openTikTok}>{be?"Адкрыць TikTok":"Открыть TikTok"}</button>
        <button className="primary-button" disabled={busy!==""} onClick={pasteComments}>{busy==="comments"?"…":be?"Уставіць каментарыі":"Вставить комментарии"}</button>
        <label><span>{be?"Парадак":"Порядок"}</span><select value={state.commentMode} onChange={(e)=>setState((current)=>({...current,commentMode:e.target.value==="latest"?"latest":"popular"}))}><option value="popular">{be?"Папулярныя":"Популярные"}</option><option value="latest">{be?"Апошнія / як у TikTok":"Последние / как в TikTok"}</option></select></label>
      </div>
      <p className="transcription-comment-hint">{be
        ? "У браўзеры вылучыце тэкст бачных каментарыяў і націсніце Ctrl+C. Вярніцеся ў Monitor і націсніце «Уставіць каментарыі». Парадак спачатку выберыце ў TikTok; апрацоўваюцца толькі скапіраваныя каментарыі."
        : "В браузере выделите видимый текст комментариев, нажмите Ctrl+C, вернитесь в Monitor и нажмите «Вставить комментарии». Для популярных или последних сначала выберите порядок в TikTok. Отбор возможен только среди скопированных комментариев."}</p>
      <div className="transcription-comment-list">
        {state.comments.length===0&&<div className="report-empty">{be?"Каментарыі пакуль не дададзены.":"Комментарии пока не добавлены."}</div>}
        {state.comments.map((comment,index)=><div key={comment.id} className="transcription-comment-row">
          <div className="transcription-comment-number">{index+1}</div>
          <textarea spellCheck={true} value={comment.text} onChange={(e)=>setState((current)=>({...current,comments:current.comments.map((item)=>item.id===comment.id?{...item,text:e.target.value}:item)}))}/>
          <div className="transcription-comment-actions">{comment.likes>0&&<small>♥ {comment.likes.toLocaleString()}</small>}<button className="ghost-button small-button" onClick={()=>setState((current)=>({...current,comments:current.comments.filter((item)=>item.id!==comment.id)}))}>×</button></div>
        </div>)}
      </div>
    </section>

    <section className="panel transcription-export">
      <div className="panel-head"><div><h3>{be ? "4. Экспарт" : "4. Экспорт"}</h3><p>{be ? "Экспарт адрэдагаванага тэксту і каментарыяў у Word." : "Экспорт отредактированного текста и комментариев в Word."}</p></div><button className="primary-button" disabled={busy!==""||!state.editorialText.trim()} onClick={exportDocx}>{busy==="export"?"…":"DOCX"}</button></div>
    </section>
  </div>;
}
