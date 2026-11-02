import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "../workroom";
import { useI18n } from "../i18n";
import { TrendColumns, TrendLine } from "../components/Charts";
import { NetworkEditorView } from "./NetworkEditorView";
import {
  cardTimestamp, effectiveCategory, importNetworkCards, isTikTokVideoUrl,
  includedInOperatorOverview, normalizeNetworkModeration, type NetworkModeration,
  mergeNetworkCards, NETWORK_GROUPS, networkCategoryName, networkTrend,
  publishedTimestamp, type NetworkCard, type NetworkCategory,
} from "../networks";

const CARDS_STORAGE_KEY = "networks.tiktok.cards.v1";
const SLOTS_STORAGE_KEY = "monitor-networks-tiktok-video-slots-v1";
const SYNC_RUNS_KEY = "networks.tiktok.completed-runs.v1";
const MODERATION_KEY = "networks.tiktok.moderation.v1";
type NetworkPage = "home" | "archive" | "editor";
type NetworkPlatform = "tiktok" | "threads";
type TrendKind = "bars" | "line";

function initialSlots(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(SLOTS_STORAGE_KEY) || "null");
    if (Array.isArray(value) && value.length && value.length <= 5) {
      return value.map((item) => typeof item === "string" ? item : "");
    }
  } catch { /* use a single empty field */ }
  return [""];
}

function displayDate(raw: string | null | undefined, locale: string): string {
  if (!raw || !Number.isFinite(Date.parse(raw))) return locale === "be" ? "дата невядомая" : "дата неизвестна";
  return new Date(raw).toLocaleString(locale === "be" ? "be-BY" : "ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function ClipCard({ item, be, checked, flagged, onToggle, onFlag, onDelete, onAdd }: {
  item: NetworkCard; be: boolean; checked: boolean; flagged: boolean;
  onToggle: (item: NetworkCard) => void;
  onFlag: (item: NetworkCard) => void;
  onDelete: (item: NetworkCard) => void;
  onAdd: (item: NetworkCard) => void;
}) {
  const date = item.publication.published_at;
  const shortText = item.text_excerpt || item.transcript_excerpt || "";
  return <article className="network-clip">
    <label className="network-clip-pick">
      <input type="checkbox" checked={checked} onChange={() => onToggle(item)}
        aria-label={(be ? "Выбраць відэа " : "Выбрать видео ") + (item.title || item.item_id)} />
    </label>
    <div className="network-clip-body">
      <div className="network-clip-top">
        <span>{displayDate(date, be ? "be" : "ru")}</span>
        {item.queue === "date_unknown" && <span>{be ? "Патрабуе праверкі даты" : "Требует проверки даты"}</span>}
        {item.review_status === "operator_confirmed" && <span>{be ? "Пацверджана аператарам" : "Подтверждено оператором"}</span>}
      </div>
      <strong className="network-clip-title">{item.title || (be ? "Відэа без загалоўка" : "Видео без заголовка")}</strong>
      {shortText && <p className="network-clip-excerpt">{shortText.slice(0, 320)}{shortText.length > 320 ? "…" : ""}</p>}
      <div className="network-clip-bottom">
        <button className="link-button" onClick={() => void desktopApi.openUrl(item.source_url)}>
          {be ? "Адкрыць відэа ў TikTok ↗" : "Открыть видео в TikTok ↗"}
        </button>
        <span>{item.item_id}</span>
      </div>
      <div className="network-clip-controls">
        <button className="secondary-button small-button" onClick={() => onAdd(item)}
          disabled={checked}>{checked ? (be ? "У аглядзе" : "В обзоре") : be ? "У агляд" : "В обзор"}</button>
        <button className={flagged ? "network-flag active" : "network-flag"} onClick={() => onFlag(item)}
          title={be ? "Чырвоны сцяжок: пазначыць / зняць" : "Красный флажок: поставить / снять"}
          aria-label={be ? "Чырвоны сцяжок" : "Красный флажок"} aria-pressed={flagged}>⚑</button>
        <button className="ghost-button small-button network-delete" onClick={() => onDelete(item)}
          title={be ? "Выдаліць ролік з Monitor" : "Удалить ролик из Monitor"}>{be ? "Выдаліць" : "Удалить"}</button>
      </div>
    </div>
  </article>;
}

/** The social networks never alter the active SEP/L database or its sync route. */
export function NetworksView() {
  const { locale } = useI18n();
  const be = locale === "be";
  const [platform, setPlatform] = useState<NetworkPlatform>("tiktok");
  const [page, setPage] = useState<NetworkPage>("home");
  const [cards, setCards] = useState<NetworkCard[]>([]);
  const [period, setPeriod] = useState<number | null>(30);
  const [trendKind, setTrendKind] = useState<TrendKind>("bars");
  const [slots, setSlots] = useState<string[]>(initialSlots);
  const [activeSlot, setActiveSlot] = useState(0);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveCategory, setArchiveCategory] = useState<NetworkCategory | "ALL">("ALL");
  const [archivePage, setArchivePage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncState, setSyncState] = useState("");
  const cardsRef = useRef<NetworkCard[]>([]);
  const syncLock = useRef(false);
  const [transcribingBatch, setTranscribingBatch] = useState(false);
  const [batchRevision, setBatchRevision] = useState(0);
  const [moderation, setModeration] = useState<NetworkModeration>({ flagged: [], deleted: [] });
  const moderationRef = useRef<NetworkModeration>({ flagged: [], deleted: [] });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    desktopApi.getSetting(CARDS_STORAGE_KEY).then((data) => {
      if (cancelled || !data) return;
      const parsed: unknown = JSON.parse(data);
      if (!Array.isArray(parsed)) throw new Error("Invalid stored networks cards");
      const initial = mergeNetworkCards([], parsed as NetworkCard[]);
      cardsRef.current = initial;
      setCards(initial);
    }).catch((reason) => {
      if (!cancelled) setError(be ? "Памылка чытання лакальнага архіва: " + reason : "Ошибка чтения локального архива: " + reason);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const syncNetwork = useCallback(async (silent = false) => {
    if (syncLock.current) return;
    syncLock.current = true;
    setSyncing(true);
    if (!silent) { setError(""); setSyncState(""); }
    let imported = 0;
    const failures: string[] = [];
    try {
      const config = loadWorkroomConfig();
      const session = await ensureWorkroomSession(config, loadWorkroomSession());
      const previous = await desktopApi.getSetting(SYNC_RUNS_KEY);
      const parsed: unknown = previous ? JSON.parse(previous) : [];
      const known = Array.isArray(parsed)
        ? parsed.filter((n): n is number => Number.isSafeInteger(n) && n > 0).slice(-3000) : [];
      const done = new Set(known);
      const answer = await desktopApi.syncTikTokBundles(config.url, config.anonKey, session.accessToken, known);
      failures.push(...answer.errors);
      for (const bundle of answer.bundles) {
        if (done.has(bundle.runNumber)) continue;
        try {
          const incoming = bundle.cardsJsonl.trim() ? importNetworkCards(bundle.cardsJsonl) : [];
          const merged = mergeNetworkCards(cardsRef.current, incoming);
          // Write content BEFORE the receipt. If interrupted, a retry is safely idempotent.
          await desktopApi.setSetting(CARDS_STORAGE_KEY, JSON.stringify(merged));
          done.add(bundle.runNumber);
          await desktopApi.setSetting(SYNC_RUNS_KEY, JSON.stringify([...done].sort((a, b) => a - b).slice(-3000)));
          cardsRef.current = merged;
          setCards(merged);
          imported += 1;
        } catch (reason) {
          failures.push(`#${bundle.runNumber}: ${String(reason)}`);
        }
      }
      setSyncState((be ? "Апошняя праверка: " : "Последняя проверка: ") +
        new Date().toLocaleTimeString(be ? "be-BY" : "ru-RU", { hour: "2-digit", minute: "2-digit" }) +
        (answer.latestRemoteRun == null ? "" : ` · GitHub #${answer.latestRemoteRun}`));
      if (imported && !silent) setNotice(be
        ? `Сінхранізавана запускаў: ${imported}. Ролікаў у архіве: ${cardsRef.current.length}.`
        : `Синхронизировано запусков: ${imported}. Роликов в архиве: ${cardsRef.current.length}.`);
      if (failures.length) setError(failures.join("\n"));
    } catch (reason) {
      setError((be ? "Сінхранізацыя TikTok: " : "Синхронизация TikTok: ") + String(reason));
    } finally { syncLock.current = false; setSyncing(false); }
  }, [be]);

  useEffect(() => {
    if (loading) return;
    void syncNetwork(true);
    const interval = window.setInterval(() => void syncNetwork(true), 30 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [loading, syncNetwork]);

  useEffect(() => {
    let cancelled = false;
    desktopApi.getSetting(MODERATION_KEY).then((value) => {
      if (cancelled) return;
      const parsed = normalizeNetworkModeration(value ? JSON.parse(value) : null);
      moderationRef.current = parsed; setModeration(parsed);
    }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, []);

  async function updateModeration(next: NetworkModeration) {
    try {
      await desktopApi.setSetting(MODERATION_KEY, JSON.stringify(next));
      moderationRef.current = next; setModeration(next);
    } catch (reason) { setError(String(reason)); }
  }
  function toggleFlag(item: NetworkCard) {
    const flagged = new Set(moderationRef.current.flagged);
    if (flagged.has(item.item_id)) flagged.delete(item.item_id); else flagged.add(item.item_id);
    void updateModeration({ ...moderationRef.current, flagged: [...flagged] });
  }
  function removeClip(item: NetworkCard) {
    const approved = window.confirm(be
      ? "Выдаліць гэты ролік з аглядаў і архіва Monitor? Ён больш не будзе з'яўляцца пры сінхранізацыі."
      : "Удалить этот ролик из обзоров и архива Monitor? При следующей синхронизации он не появится снова.");
    if (!approved) return;
    const deleted = new Set(moderationRef.current.deleted);
    deleted.add(item.item_id);
    void updateModeration({ ...moderationRef.current, deleted: [...deleted] });
    setSlots((old) => old.map((url) => url === item.source_url ? "" : url));
  }

  useEffect(() => { localStorage.setItem(SLOTS_STORAGE_KEY, JSON.stringify(slots)); }, [slots]);

  const now = Date.now();
  const visible = useMemo(() => cards.filter((item) => includedInOperatorOverview(item) && !moderation.deleted.includes(item.item_id)), [cards, moderation.deleted]);
  const trend = useMemo(() => networkTrend(visible, period, now), [visible, period]);
  const inPeriod = useMemo(() => visible.filter((item) => {
    if (period === null) return true;
    const date = publishedTimestamp(item) || cardTimestamp(item);
    return date > 0 && date >= now - period * 86_400_000 && date <= now + 86_400_000;
  }), [visible, period]);
  const recent = useMemo(() => inPeriod.filter((item) =>
    item.queue !== "archive" && effectiveCategory(item) !== "REJECT" && item.queue !== "date_unknown" && publishedTimestamp(item) > 0
  ), [inPeriod]);
  const archive = useMemo(() => visible.filter((item) => {
    if (archiveCategory !== "ALL" && effectiveCategory(item) !== archiveCategory) return false;
    const query = archiveQuery.trim().toLocaleLowerCase();
    return !query || [item.title, item.text_excerpt, item.transcript_excerpt, item.source_url, item.item_id]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  }), [visible, archiveCategory, archiveQuery]);
  const activeUrl = slots[activeSlot] || "";
  const selectedUrls = new Set(slots.filter(Boolean));

  function setSlot(index: number, url: string) {
    setSlots((previous) => previous.map((old, i) => i === index ? url : old));
  }

  function toggleClip(item: NetworkCard) {
    setError("");
    const current = [...slots];
    if (current.includes(item.source_url)) {
      setSlots(current.map((url) => url === item.source_url ? "" : url));
      return;
    }
    const empty = current.findIndex((url) => !url.trim());
    if (empty >= 0) {
      current[empty] = item.source_url;
      setSlots(current);
      setActiveSlot(empty);
      return;
    }
    if (current.length >= 5) {
      setError(be ? "Можна выбраць не больш за 5 відэа за раз." : "Можно выбрать не более 5 видео за раз.");
      return;
    }
    setSlots([...current, item.source_url]);
    setActiveSlot(current.length);
  }

  async function importFile() {
    const path = await open({ multiple: false, directory: false,
      title: be ? "Імпарт TikTok networks.v1" : "Импорт TikTok networks.v1",
      filters: [{ name: "Networks JSONL / ZIP", extensions: ["jsonl", "zip"] }] });
    if (!path || Array.isArray(path) || syncLock.current) return;
    setImporting(true); setNotice(""); setError("");
    try {
      const source = await desktopApi.readNetworksJsonl(path);
      const next = importNetworkCards(source);
      const merged = mergeNetworkCards(cardsRef.current, next);
      await desktopApi.setSetting(CARDS_STORAGE_KEY, JSON.stringify(merged));
      cardsRef.current = merged;
      setCards(merged);
      setNotice(be
        ? `Імпартавана: ${next.length} картак. У лакальным архіве ўнікальных відэа: ${merged.length}.`
        : `Импортировано: ${next.length} карточек. В локальном архиве уникальных видео: ${merged.length}.`);
    } catch (reason) { setError(String(reason)); }
    finally { setImporting(false); }
  }

  async function transcribeSelected() {
    const urls = [...new Set(slots.map((url) => url.trim()).filter(Boolean))];
    if (!urls.length) return;
    if (urls.some((url) => !isTikTokVideoUrl(url))) {
      setError(be ? "Праверце спасылкі: патрабуюцца прамыя відэа TikTok." : "Проверьте ссылки: нужны прямые видео TikTok.");
      return;
    }
    setTranscribingBatch(true); setError(""); setNotice("");
    const errors: string[] = [];
    let completed = 0;
    let skipped = 0;
    try {
      const config = loadWorkroomConfig();
      const session = await ensureWorkroomSession(config, loadWorkroomSession());
      for (const url of urls) {
        const key = `monitor-networks-transcription:${url}`;
        let saved: Record<string, unknown> = {};
        try {
          const raw = localStorage.getItem(key);
          if (raw) saved = JSON.parse(raw) as Record<string, unknown>;
        } catch { /* start fresh if a local draft is corrupt */ }
        if (typeof saved.rawText === "string" && saved.rawText.trim()) { skipped++; continue; }
        try {
          const transcript = await desktopApi.transcribeTikTok(url, config.url, config.anonKey, session.accessToken);
          localStorage.setItem(key, JSON.stringify({
            ...saved, url: transcript.url || url, title: transcript.title || "TikTok",
            rawText: transcript.text, editorialText: transcript.text,
            language: transcript.language, duration: transcript.duration,
            comments: Array.isArray(saved.comments) ? saved.comments : [],
            manualComments: Array.isArray(saved.manualComments) ? saved.manualComments : ["", "", "", "", ""],
            imageText: typeof saved.imageText === "string" ? saved.imageText : "", commentMode: saved.commentMode || "popular",
          }));
          completed++;
        } catch (reason) {
          errors.push(`${url}: ${String(reason)}`);
        }
      }
      setNotice(be
        ? `Гатова новых транскрыпцый: ${completed}. Раней апрацаваны: ${skipped}.`
        : `Готово новых транскрипций: ${completed}. Уже обработаны ранее: ${skipped}.`);
      if (errors.length) setError((be ? "Не атрымалася апрацаваць: " : "Не удалось обработать: ") + errors.join("\n"));
      setBatchRevision((current) => current + 1);
    } catch (reason) { setError(String(reason)); }
    finally { setTranscribingBatch(false); }
  }

  function showArchive(category: NetworkCategory | "ALL" = "ALL") {
    setArchiveCategory(category); setArchivePage(0); setPage("archive");
  }

  const renderCard = (item: NetworkCard) => <ClipCard key={item.item_id} item={item} be={be}
    checked={selectedUrls.has(item.source_url)} flagged={moderation.flagged.includes(item.item_id)}
    onToggle={toggleClip} onAdd={toggleClip} onFlag={toggleFlag} onDelete={removeClip} />;

  return <div className="view-stack networks-view">
    <section className="view-heading">
      <div><div className="eyebrow dark">NETWORKS</div>
        <h2>{be ? "Сеткі" : "Сети"}</h2>
        <p>{be ? "Публічныя паведамленні сацыяльных сетак. Катэгорыі з'яўляюцца папярэднімі і патрабуюць рэдактарскай праверкі." : "Публичные материалы социальных сетей. Автоматические категории предварительны и требуют редакторской проверки."}</p>
      </div>
      <div className="network-top-switch" role="tablist" aria-label={be ? "Платформа" : "Платформа"}>
        <button role="tab" aria-selected={platform === "tiktok"} className={platform === "tiktok" ? "primary-button" : "secondary-button"} onClick={() => setPlatform("tiktok")}>TikTok</button>
        <button role="tab" aria-selected={platform === "threads"} className={platform === "threads" ? "primary-button" : "secondary-button"} onClick={() => setPlatform("threads")}>Threads</button>
      </div>
    </section>
    {platform === "threads" ? <section className="panel network-empty">
      <h3>Threads</h3>
      <p>{be ? "Раздзел зарэзерваваны. Даныя Threads пакуль не імпартуюцца. Да яго вернемся асобным этапам." : "Раздел подготовлен для следующего этапа. Данные Threads пока не импортируются."}</p>
    </section> : <>
      <div className="network-toolbar">
        <div className="network-tabs" role="tablist" aria-label={be ? "Рэжым прагляду" : "Режим просмотра"}>
          <button className={page === "home" ? "active" : ""} onClick={() => setPage("home")}>{be ? "Агляд" : "Обзор"}</button>
          <button className={page === "archive" ? "active" : ""} onClick={() => showArchive()}>{be ? "Архіў" : "Архив"}</button>
          <button className={page === "editor" ? "active" : ""} onClick={() => setPage("editor")}>{be ? "Рэдактар агляду" : "Редактор обзора"} ({slots.filter(Boolean).length})</button>
        </div>
        <div className="network-sync-controls">
          <span className="network-sync-status">{syncing ? (be ? "Сінхранізацыя…" : "Синхронизация…") : syncState || (be ? "Аўтасінхранізацыя: кожныя 30 хвілін" : "Автосинхронизация: каждые 30 минут")}</span>
          <button className="primary-button small-button" disabled={syncing || importing} onClick={() => void syncNetwork(false)}>
            {be ? "Сінхранізаваць" : "Синхронизировать"}
          </button>
          <button className="secondary-button small-button" disabled={importing || syncing} onClick={() => void importFile()}>
            {importing ? "…" : be ? "Імпарт ZIP / JSONL" : "Импорт ZIP / JSONL"}
          </button>
        </div>
      </div>
      {notice && <div className="notice success">{notice}</div>}
      {error && <div className="notice error">{error}</div>}
      {loading && <div className="report-empty">{be ? "Чытаем лакальны архіў…" : "Загружаем локальный архив…"}</div>}
      {page === "home" && <div className="network-overview">
        <section className="panel">
          <div className="panel-head"><div><h3>{be ? "Дынаміка публікацый" : "Динамика публикаций"}</h3>
            <p>{be ? "Унікальныя відэа з вядомай датай публікацыі; без тэматычнага падзелу." : "Уникальные видео с установленной датой публикации; без разделения по темам."}</p></div></div>
          <div className="network-chart-controls">
            <div className="network-tabs" role="group" aria-label={be ? "Перыяд" : "Период"}>
              {([1, 7, 30, 365, null] as Array<number | null>).map((value) => <button key={String(value)}
                className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>
                {value === null ? (be ? "Увесь час" : "Всё время") : be ? (`${value} дн.`) : (`${value} дн.`)}
              </button>)}
            </div>
            <div className="network-tabs" role="group" aria-label={be ? "Выгляд графіка" : "Вид графика"}>
              <button className={trendKind === "bars" ? "active" : ""} onClick={() => setTrendKind("bars")}>{be ? "Слупкі" : "Столбцы"}</button>
              <button className={trendKind === "line" ? "active" : ""} onClick={() => setTrendKind("line")}>{be ? "Лінія" : "Линия"}</button>
            </div>
          </div>
          {trendKind === "bars" ? <TrendColumns data={trend} /> : <TrendLine data={trend} />}
        </section>
        <section className="network-groups">
          {NETWORK_GROUPS.map((category) => {
            const group = recent.filter((item) => effectiveCategory(item) === category);
            if (!group.length) return null;
            return <section className="panel network-group" key={category}>
              <div className="panel-head"><div><h3>{networkCategoryName(category, be)}</h3>
                <p>{be ? "Аўтаматычная ацэнка; адкрыйце арыгінал для праверкі." : "Предварительная оценка; проверьте оригинал ролика."}</p></div>
                {group.length > 8 && <button className="ghost-button small-button" onClick={() => showArchive(category)}>
                  {be ? "Усе ролікі" : "Все ролики"} ({group.length})
                </button>}
              </div>
              <div className="network-card-list">{group.slice(0, 8).map(renderCard)}</div>
            </section>;
          })}
          {!loading && recent.length === 0 && <section className="panel network-empty">
            <p>{cards.length ? (be ? "За выбраны перыяд няма датаваных картак для асноўнай выдачы. Праверце архіў." : "За выбранный период нет датированных карточек для основной выдачи. Проверьте архив.")
              : (be ? "Карткі пакуль не імпартаваны. Загрузіце networks_cards.jsonl або ZIP з вынікамі TikTok-Monitor." : "Карточки пока не импортированы. Загрузите networks_cards.jsonl или ZIP с результатами TikTok-Monitor.")}</p>
          </section>}
        </section>
      </div>}
      {page === "archive" && <section className="panel network-archive">
        <div className="panel-head"><div><h3>{be ? "Архіў відэа TikTok" : "Архив видео TikTok"}</h3>
          <p>{be ? "Усе імпартаваныя ролікі, ад новых да старых; асобна захоўваюцца недатаваныя і выключаныя." : "Все импортированные ролики, сначала новые; сохраняются также недатированные и исключённые."}</p></div></div>
        <div className="network-archive-controls">
          <input value={archiveQuery} onChange={(event) => { setArchiveQuery(event.target.value); setArchivePage(0); }}
            placeholder={be ? "Пошук у архіве…" : "Поиск по архиву…"} aria-label={be ? "Пошук" : "Поиск"} />
          <select value={archiveCategory} onChange={(event) => { setArchiveCategory(event.target.value as NetworkCategory | "ALL"); setArchivePage(0); }}>
            <option value="ALL">{be ? "Усе катэгорыі" : "Все категории"}</option>
            {[...NETWORK_GROUPS, "REJECT" as NetworkCategory].map((category) =>
              <option value={category} key={category}>{networkCategoryName(category, be)}</option>)}
          </select>
        </div>
        <div className="network-card-list">{archive.slice(archivePage * 40, (archivePage + 1) * 40).map(renderCard)}</div>
        {!archive.length && <div className="report-empty">{be ? "Карткі не знойдзены." : "Карточки не найдены."}</div>}
        {archive.length > 40 && <div className="network-pagination">
          <button className="secondary-button small-button" disabled={archivePage === 0} onClick={() => setArchivePage((p) => p - 1)}>{be ? "Назад" : "Назад"}</button>
          <span>{archivePage + 1} / {Math.ceil(archive.length / 40)}</span>
          <button className="secondary-button small-button" disabled={(archivePage + 1) * 40 >= archive.length} onClick={() => setArchivePage((p) => p + 1)}>{be ? "Далей" : "Далее"}</button>
        </div>}
      </section>}
      {page === "editor" && <NetworkEditorView slots={slots} setSlots={setSlots}
        onRemove={() => {}} transcribeSelected={() => void transcribeSelected()}
        batchBusy={transcribingBatch} batchRevision={batchRevision} />}
    </>}
  </div>;
}
