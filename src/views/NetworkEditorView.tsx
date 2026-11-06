import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { useI18n } from "../i18n";
import { isTikTokVideoUrl } from "../networks";
import { clearReviewVideos, removeReviewVideo, selectedVideoCount } from "../networkReviewSelection";
import type { TikTokSourceContextMap } from "../networkEditorMetadata";
import { TranscriptionView } from "./TranscriptionView";

function EditorVideoPreview({ source, title, be }: { source: string; title: string; be: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [source]);
  if (!source || failed) return null;
  return <img className="network-editor-source-image" src={source}
    loading="lazy" decoding="async" referrerPolicy="no-referrer"
    alt={(be ? "Вокладка роліка: " : "Обложка ролика: ") + title.slice(0, 80)}
    onError={() => setFailed(true)} />;
}

export type NetworkEditorItem = {
  url: string; text: string; imageText: string; comments: string[];
};

const stateKey = (url: string) => `monitor-networks-transcription:${url}`;
export function collectEditorItems(urls: string[]): NetworkEditorItem[] {
  const items: NetworkEditorItem[] = [];
  for (const url of [...new Set(urls.map((item) => item.trim()).filter(Boolean))].slice(0, 5)) {
    if (!isTikTokVideoUrl(url)) continue;
    let raw: Record<string, unknown> = {};
    try { raw = JSON.parse(localStorage.getItem(stateKey(url)) || "{}") as Record<string, unknown>; }
    catch { /* ignore corrupt draft */ }
    const comments = [
      ...(Array.isArray(raw.comments) ? raw.comments.map((value) => String((value as { text?: string })?.text || "")) : []),
      ...(Array.isArray(raw.manualComments) ? raw.manualComments.map((value) => String(value || "")) : []),
    ].map((value) => value.trim()).filter(Boolean).slice(0, 30);
    items.push({
      url, text: String(raw.editorialText || "").trim(),
      imageText: String(raw.imageText || "").trim(), comments,
    });
  }
  return items;
}

export function NetworkEditorView({
  slots, setSlots, sourceContext, onRemove, transcribeSelected, batchBusy, batchRevision,
}: {
  slots: string[];
  setSlots: (next: string[]) => void;
  sourceContext: TikTokSourceContextMap;
  onRemove: (url: string) => void;
  transcribeSelected: () => void;
  batchBusy: boolean;
  batchRevision: number;
}) {
  const { locale } = useI18n();
  const be = locale === "be";
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function update(index: number, value: string) {
    setSlots(slots.map((url, i) => index === i ? value.trim() : url));
  }
  function remove(index: number) {
    const url = slots[index];
    setSlots(removeReviewVideo(slots, index));
    setMessage(""); setError("");
    if (url) onRemove(url);
  }

  function clearAll() {
    if (!selectedVideoCount(slots)) return;
    const approved = window.confirm(be
      ? "Ачысціць увесь праект агляду TikTok? Усе відэа будуць прыбраны з рэдактара. Архіў, апісанні і захаваныя транскрыпцыі не выдаляюцца."
      : "Очистить весь проект обзора TikTok? Все видео будут убраны из редактора. Архив, описания и сохранённые транскрипции не удаляются.");
    if (!approved) return;
    setSlots(clearReviewVideos());
    setError("");
    setMessage(be ? "Праект агляду ачышчаны." : "Проект обзора очищен.");
  }
  async function exportCombined() {
    setError(""); setMessage("");
    const items = collectEditorItems(slots);
    if (items.length === 0 || items.some((item) => !item.text && !item.imageText && !item.comments.length)) {
      setError(be ? "Для экспарту кожнае абранае відэа павінна мець адрэдагаваны тэкст або каментарыі." : "Для экспорта у каждого выбранного видео должен быть текст для экспорта или комментарии.");
      return;
    }
    const path = await save({
      title: be ? "Агульны экспарт TikTok" : "Общий экспорт TikTok",
      defaultPath: "TikTok-обзор-транскрипции.docx",
      filters: [{ name: "Word", extensions: ["docx"] }],
    });
    if (!path) return;
    setExporting(true);
    try {
      await desktopApi.exportTikTokMultiTranscript(path, items);
      setMessage(be ? `Экспартавана відэа: ${items.length}. Усе тэксты і каментарыі ў адным DOCX.` : `Экспортировано видео: ${items.length}. Все тексты и комментарии в одном DOCX.`);
    } catch (reason) { setError(String(reason)); }
    finally { setExporting(false); }
  }

  return <div className="network-editor-workspace">
    <section className="panel">
      <div className="panel-head"><div>
        <h3>{be ? "Рэдактар агляду TikTok" : "Редактор обзора TikTok"}</h3>
        <p>{be ? "Адно відэа – адзін поўны блок: спасылка, транскрыпцыя, рэдагаванне, надпісы на відэа і каментарыі. Не больш за пяць." : "Одно видео — один полный блок: ссылка, транскрипция, редактирование, текст на видео и комментарии. Не более пяти."}</p>
      </div></div>
      <div className="network-editor-actions">
        <button className="secondary-button small-button" disabled={batchBusy || !selectedVideoCount(slots)}
          onClick={transcribeSelected}>{batchBusy ? "…" : be ? "Транскрыбаваць усе" : "Транскрибировать все"}</button>
        <span>{be ? "Гатовыя транскрыпцыі не апрацоўваюцца паўторна." : "Готовые транскрипции не обрабатываются повторно."}</span>
        <button className="secondary-button small-button network-editor-clear-all"
          disabled={batchBusy || exporting || !selectedVideoCount(slots)}
          onClick={clearAll}>{be ? "Ачысціць увесь агляд" : "Очистить весь обзор"} ({selectedVideoCount(slots)})</button>
      </div>
    </section>
    {message && <div className="notice success">{message}</div>}
    {error && <div className="notice error">{error}</div>}
    {slots.map((url, index) => {
      const context = sourceContext[url];
      const title = context?.title?.trim() || "";
      const description = context?.description?.trim() || "";
      const preview = context?.preview_image_url || "";
      return <div className="network-editor-card-shell" key={url || `empty-${index}`}>
        <details className="network-editor-video" open={index === 0}>
      <summary>
        <span className="network-editor-heading">
          <strong>{be ? "Відэа" : "Видео"} {index + 1}</strong>
          <span className="network-editor-summary-title" title={title || url}>
            {title || (url ? url.replace("https://www.tiktok.com/", "") : (be ? "Новае відэа" : "Новое видео"))}
          </span>

        </span>
      </summary>
      <div className="network-editor-video-content">
        <div className="network-editor-url">
          <input value={url} onChange={(event) => update(index, event.target.value)}
            placeholder="https://www.tiktok.com/@.../video/..." aria-label={`Видео ${index + 1} URL`} />
          <button className="ghost-button small-button" disabled={batchBusy || exporting} onClick={() => remove(index)}>{be ? "Прыбраць з агляду" : "Убрать из обзора"}</button>
        </div>
        {(title || description || preview) && <section className="network-editor-source-context" aria-label={be ? "Апісанне роліка" : "Описание ролика"}>
          <div className="network-editor-source-label">{be ? "Арыгінальнае апісанне роліка" : "Оригинальное описание ролика"}</div>
          <div className="network-editor-source-row">
            {preview && <EditorVideoPreview source={preview} title={title || url} be={be} />}
            <div className="network-editor-source-text">
              {title && <h4>{title}</h4>}
              {description && description !== title && <p>{description}</p>}
              <small>{be ? "Захавана з карткі пры даданні ў агляд; не змяняецца транскрыпцыяй." : "Сохранено из карточки при добавлении в обзор; транскрипция не заменяет описание."}</small>
            </div>
          </div>
        </section>}
        {url && isTikTokVideoUrl(url) ? <TranscriptionView key={`${url}:${batchRevision}`}
          initialUrl={url} storageKey={stateKey(url)} embedded hideExport /> :
          <section className="panel network-empty"><p>{be ? "Устаўце прамую спасылку на ролік." : "Вставьте прямую ссылку на ролик."}</p></section>}
      </div>
        </details>
        <button className="secondary-button small-button network-editor-remove-fixed"
          type="button" disabled={batchBusy || exporting}
          title={be ? "Прыбраць гэта відэа толькі з агляду" : "Убрать это видео только из обзора"}
          aria-label={(be ? "Прыбраць відэа " : "Убрать видео ") + (index + 1)}
          onClick={() => remove(index)}>
          {be ? "Прыбраць" : "Убрать"}
        </button>
      </div>;
    })}
    {slots.length < 5 && <button className="secondary-button network-add-slot" onClick={() => setSlots([...slots, ""])}>
      + {be ? "Дадаць відэа" : "Добавить видео"} {slots.length + 1}
    </button>}
    <section className="panel network-total-export">
      <div className="panel-head"><div>
        <h3>{be ? "Агульны экспарт" : "Общий экспорт"}</h3>
        <p>{be ? "Усе абраныя відэа, адрэдагаваныя тэксты і іх каментарыі паслядоўна ў адным дакуменце Word." : "Все выбранные видео, отредактированные тексты и комментарии к каждому ролику последовательно в одном документе Word."}</p>
      </div><button className="primary-button" disabled={exporting || !slots.some(Boolean)} onClick={() => void exportCombined()}>
        {exporting ? "…" : be ? "Экспартаваць DOCX" : "Экспортировать DOCX"}
      </button></div>
    </section>
  </div>;
}
