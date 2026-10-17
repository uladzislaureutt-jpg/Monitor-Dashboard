import { useEffect, useState, type ClipboardEvent, type ChangeEvent } from "react";
import type { WorkroomSession } from "../types";
import { adminNotebookRequest, encodeNotebookImage, type AdminNote, type NotebookImage } from "../adminNotebook";

export function AdminNotebook({ session, be }: { session: WorkroomSession; be: boolean }) {
  const [notes, setNotes] = useState<AdminNote[]>([]);
  const [activeId, setActiveId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<NotebookImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const active = notes.find((note) => note.id === activeId) || null;
  const changed = Boolean(active && (title !== active.title || body !== active.body));
  const text = {
    heading: be ? "Запісная кніжка адміністратара" : "Записная книжка администратора",
    help: be ? "Памяткі аб мадэлях, лімітах і працоўных правілах. Даступныя толькі адміністратарам; захоўваюцца ў Supabase." : "Памятки о моделях, лимитах и рабочих правилах. Доступны только администраторам; сохраняются в Supabase.",
    add: be ? "Новая памятка" : "Новая памятка",
    save: be ? "Захаваць" : "Сохранить",
    refresh: be ? "Абнавіць" : "Обновить",
    delete: be ? "Выдаліць" : "Удалить",
    image: be ? "Дадаць скрыншот" : "Добавить скриншот",
    paste: be ? "Можна ўставіць скрыншот праз Ctrl+V у поле тэксту" : "Можно вставить скриншот через Ctrl+V в поле текста",
    empty: be ? "Стварыце першую памятку." : "Создайте первую памятку.",
  };

  async function reload(keepId = activeId) {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await adminNotebookRequest(session, "list");
      const next = Array.isArray(result.notes) ? result.notes as AdminNote[] : [];
      setNotes(next);
      setActiveId(next.some(note => note.id === keepId) ? keepId : (next[0]?.id || ""));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); setLoading(false); }
  }
  useEffect(() => {
    let cancelled = false;
    adminNotebookRequest(session, "list").then((result) => {
      if (cancelled) return;
      const next = Array.isArray(result.notes) ? result.notes as AdminNote[] : [];
      setNotes(next);
      setActiveId(next[0]?.id || "");
    }).catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session.userId]);

  useEffect(() => {
    setTitle(active?.title || "");
    setBody(active?.body || "");
    setImages([]);
    if (!active) return;
    let cancelled = false;
    adminNotebookRequest(session, "image_urls", { note_id: active.id })
      .then((result) => { if (!cancelled) setImages(Array.isArray(result.images) ? result.images : []); })
      .catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [activeId, session.userId]);

  function switchNote(noteId: string) {
    if (changed && !window.confirm(be ? "Ёсць незахаваныя змены. Пакінуць памятку?" : "Есть несохранённые изменения. Перейти без сохранения?")) return;
    setActiveId(noteId); setError(""); setMessage("");
  }
  async function createNote() {
    if (changed && !window.confirm(be ? "Адкінуць незахаваныя змены?" : "Оставить несохранённые изменения?")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await adminNotebookRequest(session, "create");
      const next = result.note as AdminNote;
      setNotes(current => [next, ...current]);
      setActiveId(next.id);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function saveNote() {
    if (!active) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await adminNotebookRequest(session, "save", { note_id: active.id, title: title.trim(), body });
      const saved = result.note as AdminNote;
      setNotes(current => current.map(note => note.id === saved.id ? saved : note));
      setTitle(saved.title);
      setMessage(be ? "Захавана ў Supabase." : "Сохранено в Supabase.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function deleteNote() {
    if (!active || !window.confirm(be ? "Выдаліць памятку разам са скрыншотамі?" : "Удалить памятку вместе со скриншотами?")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await adminNotebookRequest(session, "delete", { note_id: active.id });
      const remaining = notes.filter(note => note.id !== active.id);
      setNotes(remaining); setActiveId(remaining[0]?.id || "");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function uploadFiles(files: File[]) {
    if (!active || busy || !files.length) return;
    if (active.image_paths.length + files.length > 6) {
      setError(be ? "Не больш за 6 скрыншотаў у адной памятцы." : "Не более 6 скриншотов в одной памятке.");
      return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      let updated = active;
      for (const file of files) {
        const converted = await encodeNotebookImage(file);
        const response = await adminNotebookRequest(session, "upload", {
          note_id: active.id, base64: converted.base64, mime: converted.mime,
        });
        updated = response.note as AdminNote;
        setImages(old => [...old, { path: String(response.path), url: String(response.signed_url) }]);
      }
      setNotes(current => current.map(note => note.id === updated.id ? updated : note));
      setMessage(be ? "Скрыншот захаваны." : "Скриншот сохранён.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    void uploadFiles(files);
  }
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return; // Plain text paste continues as usual.
    event.preventDefault();
    void uploadFiles(files);
  }
  async function removeImage(path: string) {
    if (!active || !window.confirm(be ? "Выдаліць скрыншот?" : "Удалить скриншот?")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await adminNotebookRequest(session, "remove_image", { note_id: active.id, path });
      setImages(items => items.filter(item => item.path !== path));
      setNotes(items => items.map(note => note.id === active.id
        ? { ...note, image_paths: note.image_paths.filter(item => item !== path) } : note));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <section className="panel admin-notebook">
    <div className="panel-head">
      <div><h3>{text.heading}</h3><p>{text.help}</p></div>
      <div className="admin-notebook-top-actions">
        <button type="button" className="secondary-button" onClick={() => { if (!changed || window.confirm("Оставить несохранённые изменения?")) void reload(); }} disabled={busy}>{text.refresh}</button>
        <button type="button" className="primary-button" onClick={() => void createNote()} disabled={busy || notes.length >= 30}>{text.add}</button>
      </div>
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice">{message}</p>}
    {loading ? <p className="muted">…</p> : <div className="admin-notebook-layout">
      <nav className="admin-notebook-list" aria-label={text.heading}>
        {notes.length === 0 && <p className="muted">{text.empty}</p>}
        {notes.map(note => <button type="button" key={note.id}
          className={"admin-notebook-list-item" + (activeId === note.id ? " selected" : "")}
          onClick={() => switchNote(note.id)}>
          <strong>{note.title}</strong>
          <small>{new Date(note.updated_at).toLocaleString(be ? "be-BY" : "ru-RU")} · {note.image_paths.length} 📷</small>
        </button>)}
      </nav>
      <div className="admin-notebook-editor">
        {active ? <>
          <label className="admin-notebook-label">{be ? "Назва" : "Заголовок"}
            <input type="text" value={title} maxLength={120} onChange={event => setTitle(event.target.value)}/>
          </label>
          <label className="admin-notebook-label">{be ? "Тэкст памяткі" : "Текст памятки"}
            <textarea rows={12} maxLength={12000} value={body} onChange={event => setBody(event.target.value)}
              onPaste={handlePaste} spellCheck={true} lang={be ? "be" : "ru"}/>
          </label>
          <div className="admin-notebook-toolbar">
            <button className="primary-button" type="button" onClick={() => void saveNote()} disabled={busy || !changed || !title.trim()}>{busy ? "…" : text.save}</button>
            <label className={"secondary-button admin-notebook-upload" + (busy || active.image_paths.length >= 6 ? " disabled" : "")}>
              {text.image}<input type="file" accept="image/png,image/jpeg,image/webp" multiple
                disabled={busy || active.image_paths.length >= 6} onChange={handleFiles}/>
            </label>
            <button className="text-danger" type="button" onClick={() => void deleteNote()} disabled={busy}>{text.delete}</button>
            <span>{body.length.toLocaleString()} / 12 000 · {active.image_paths.length} / 6 📷</span>
          </div>
          <p className="admin-notebook-hint">{text.paste}. {be ? "Не захоўвайце ключы API або паролі." : "Не сохраняйте API-ключи и пароли."}
          {changed ? (be ? " · Ёсць незахаваныя змены." : " · Есть несохранённые изменения.") : ""}</p>
          {images.length > 0 && <div className="admin-notebook-images">
            {images.map(image => <figure key={image.path}>
              {image.url ? <a href={image.url} target="_blank" rel="noreferrer"><img src={image.url} alt={be ? "Скрыншот памяткі" : "Скриншот памятки"}/></a>
                : <span className="muted">{be ? "Выява недаступная" : "Изображение недоступно"}</span>}
              <button className="ghost-button small-button" type="button" disabled={busy} onClick={() => void removeImage(image.path)}>{text.delete}</button>
            </figure>)}
          </div>}
        </> : <p className="muted">{text.empty}</p>}
      </div>
    </div>}
  </section>;
}
