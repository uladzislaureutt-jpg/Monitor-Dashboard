import { useMonitorAccess } from "../access";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "../workroom";
import { useI18n } from "../i18n";
import { TrendColumns, TrendLine } from "../components/Charts";
import { NetworkEditorView, networkTranscriptKey } from "./NetworkEditorView";
import { applyTikTokCloudModeration, downloadTikTokCloud, migrateTikTokLocalModeration, moveTikTokReviewCard, uploadTikTokFinalCards } from "../tiktokCloudSync";
import { contextFromCard, normalizeSourceContext, rememberSourceContext, type TikTokSourceContextMap } from "../networkEditorMetadata";
import {
  compareOperatorReview, importNetworkCards, isTikTokVideoUrl, latestOperatorRuns, mergeNetworkCards,
  networkOperatorSection, networkSectionName, networkTrend, normalizeNetworkModeration,
  operatorReviewLabel, operatorRun, publishedTimestamp, safeTikTokPreview, selectOperatorArchive,
  TIKTOK_SECTIONS, type NetworkCard, type NetworkModeration, type TikTokMoveSection,
} from "../networks";

const CARDS_STORAGE_KEY = "networks.tiktok.cards.v1";
const SLOTS_STORAGE_KEY = "monitor-networks-tiktok-video-slots-v1";
const SYNC_RUNS_KEY = "networks.tiktok.completed-runs.v2";
const LEGACY_SYNC_RUNS_KEY = "networks.tiktok.completed-runs.v1";
const MODERATION_KEY = "networks.tiktok.moderation.v1";
const CLOUD_MIGRATED_KEY = "networks.tiktok.cloud-moderation-migrated.v1";
const EDITOR_CONTEXT_KEY = "monitor-networks-editor-source-context-v1";
export type NetworkPage = "home" | "archive" | "editor";
export type NetworkPlatform = "tiktok" | "threads";
type TrendKind = "bars" | "line";

function initialContext(key: string): TikTokSourceContextMap {
  try { return normalizeSourceContext(JSON.parse(localStorage.getItem(key) || "null")); }
  catch { return {}; }
}

function initialSlots(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
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

function ClipCard({ item, be, checked, flagged, decision, moderationBusy, canModerate, onToggle, onFlag, onDelete, onAdd, onMove }: {
  item: NetworkCard; be: boolean; checked: boolean; flagged: boolean;
  decision?: TikTokMoveSection; moderationBusy: boolean; canModerate: boolean;
  onToggle: (item: NetworkCard) => void;
  onFlag: (item: NetworkCard) => void;
  onDelete: (item: NetworkCard) => void;
  onAdd: (item: NetworkCard) => void;
  onMove: (item: NetworkCard, section: TikTokMoveSection | null) => void;
}) {
  const section = networkOperatorSection(item, decision);
  const date = publishedTimestamp(item) ? item.publication.published_at : null;
  const run = operatorRun(item);
  const preview = safeTikTokPreview(item.preview_image_url);
  const excerpt = item.text_excerpt === item.title ? item.transcript_excerpt : item.text_excerpt;
  const shortText = excerpt || item.transcript_excerpt || "";
  return <article className="network-clip">
    <label className="network-clip-pick">
      <input type="checkbox" checked={checked} onChange={() => onToggle(item)}
        aria-label={(be ? "Выбраць відэа " : "Выбрать видео ") + (item.title || item.item_id)} />
    </label>
    {preview && <img key={preview} className="network-clip-preview" src={preview} alt={be ? "Мініяцюра TikTok" : "Миниатюра TikTok"}
      loading="lazy" decoding="async" referrerPolicy="no-referrer"
      onError={(event) => { event.currentTarget.style.display = "none"; }} />}
    <div className="network-clip-body">
      <div className="network-clip-top">
        <span>{displayDate(date, be ? "be" : "ru")}</span>
        {run > 0 && <span>#{run}</span>}
        {(decision || item.review_status === "operator_confirmed") && <span>{be ? "Пацверджана аператарам" : "Подтверждено оператором"}</span>}
      </div>
      <strong className="network-clip-title">{item.title || (be ? "Відэа без загалоўка" : "Видео без заголовка")}</strong>
      {shortText && <p className="network-clip-excerpt">{shortText.slice(0, 320)}{shortText.length > 320 ? "…" : ""}</p>}
      {section === "review" && <small className="network-review-note">
        {operatorReviewLabel(item, be)}
      </small>}
      <div className="network-clip-bottom">
        <button className="link-button" onClick={() => void desktopApi.openUrl(item.source_url)}>
          {be ? "Адкрыць відэа ў TikTok ↗" : "Открыть видео в TikTok ↗"}
        </button>
        <span>{item.item_id}</span>
      </div>
      <div className="network-clip-controls">
        <button className="secondary-button small-button" onClick={() => onAdd(item)}
          disabled={checked}>{checked ? (be ? "У аглядзе" : "В обзоре") : be ? "У агляд" : "В обзор"}</button>
        {canModerate && <>
          <button className={flagged ? "network-flag active" : "network-flag"} onClick={() => onFlag(item)} disabled={moderationBusy}
            title={be ? "Чырвоны сцяжок: пазначыць / зняць" : "Красный флажок: поставить / снять"}
            aria-label={be ? "Чырвоны сцяжок" : "Красный флажок"} aria-pressed={flagged}>⚑</button>
          {section === "review" && <>
            <button className="secondary-button small-button" disabled={moderationBusy}
              onClick={() => onMove(item, "appeals")}>{be ? "У звароты" : "В обращения"}</button>
            <button className="secondary-button small-button" disabled={moderationBusy}
              onClick={() => onMove(item, "complaints")}>{be ? "У скаргі" : "В жалобы"}</button>
        </>}
        {decision && <button className="ghost-button small-button" disabled={moderationBusy}
          onClick={() => onMove(item, null)}>{be ? "Адмяніць перанос" : "Отменить перенос"}</button>}
        <button className="ghost-button small-button network-delete" disabled={moderationBusy} onClick={() => onDelete(item)}
          title={be ? "Выдаліць ролік з Monitor" : "Удалить ролик из Monitor"}>{be ? "Выдаліць" : "Удалить"}</button>
        </>}
      </div>
    </div>
  </article>;
}

/** The social networks never alter the active SEP/L database or its sync route. */
export function NetworksView({ page, platform, onPlatformChange }: {
  page: NetworkPage;
  platform: NetworkPlatform; onPlatformChange: (platform: NetworkPlatform) => void;
}) {
  const { locale } = useI18n();
  const be = locale === "be";
  const { profile, session } = useMonitorAccess();
  const isAdmin = profile.isAdmin;
  const operatorId = isAdmin ? undefined : session.userId;
  const slotsKey = operatorId ? `${SLOTS_STORAGE_KEY}:${operatorId}` : SLOTS_STORAGE_KEY;
  const contextKey = operatorId ? `${EDITOR_CONTEXT_KEY}:${operatorId}` : EDITOR_CONTEXT_KEY;
  const setPlatform = onPlatformChange;
  const [cards, setCards] = useState<NetworkCard[]>([]);
  const [period, setPeriod] = useState<number | null>(30);
  const [trendKind, setTrendKind] = useState<TrendKind>("bars");
  const [slots, setSlots] = useState<string[]>(() => initialSlots(slotsKey));
  const [sourceContext, setSourceContext] = useState<TikTokSourceContextMap>(() => initialContext(contextKey));
  const [activeSlot, setActiveSlot] = useState(0);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archivePage, setArchivePage] = useState(0);
  const [completedRuns, setCompletedRuns] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [cloudState, setCloudState] = useState("");
  const cloudLock = useRef(false);
  const [moderationLoaded, setModerationLoaded] = useState(false);
  const moderationBusyRef = useRef(false);
  const [moderationBusy, setModerationBusy] = useState(false);
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
    if (!isAdmin) { setLoading(false); return; }
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
  }, [isAdmin]);


  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    desktopApi.getSetting(SYNC_RUNS_KEY).then((raw) => {
      const runs: unknown = raw ? JSON.parse(raw) : [];
      if (!cancelled && Array.isArray(runs)) setCompletedRuns(runs);
    }).catch(() => { /* Existing cards still carry their report run. */ });
    return () => { cancelled = true; };
  }, [isAdmin]);

  /** Reconcile both computers against the same server data and tombstones. */
  const syncCloud = useCallback(async () => {
    if (cloudLock.current || moderationBusyRef.current) return;
    cloudLock.current = true;
    setCloudSyncing(true);
    try {
      if (isAdmin) {
        // Each old installation publishes its historic deletions exactly once.
        if (localStorage.getItem(CLOUD_MIGRATED_KEY) !== "1") {
          await migrateTikTokLocalModeration(moderationRef.current);
          localStorage.setItem(CLOUD_MIGRATED_KEY, "1");
        }
        await uploadTikTokFinalCards(cardsRef.current);
      }
      const remote = await downloadTikTokCloud();
      const merged = isAdmin ? mergeNetworkCards(cardsRef.current, remote.cards) : remote.cards;
      if (isAdmin) {
        await desktopApi.setSetting(CARDS_STORAGE_KEY, JSON.stringify(merged));
        await desktopApi.setSetting(MODERATION_KEY, JSON.stringify(remote.moderation));
      }
      cardsRef.current = merged;
      setCards(merged);
      moderationRef.current = remote.moderation;
      setModeration(remote.moderation);
      const deleted = new Set(remote.moderation.deleted);
      const deletedUrls = new Set(merged.filter((card) => deleted.has(card.item_id)).map((card) => card.source_url));
      if (deletedUrls.size) setSlots((old) => {
        const remaining = old.filter((url) => url && !deletedUrls.has(url));
        return remaining.length ? remaining : [""];
      });
      setCloudState(be ? "Воблачная сінхранізацыя завершана" : "Облачная синхронизация завершена");
    } catch (reason) {
      setError((be ? "Сінхранізацыя воблака: " : "Синхронизация облака: ") + String(reason));
      if (!isAdmin) {
        cardsRef.current = [];
        setCards([]);
        setModeration({ flagged: [], deleted: [] });
      }
      setCloudState(isAdmin
        ? (be ? "Воблака недаступнае — паказаны лакальныя даныя" : "Облако недоступно — показаны локальные данные")
        : (be ? "Воблачны архіў недаступны" : "Облачный архив недоступен"));
    } finally {
      cloudLock.current = false;
      setCloudSyncing(false);
    }
  }, [be, isAdmin]);

  const syncNetwork = useCallback(async (silent = false) => {
    if (!isAdmin) {
      if (!silent) setError("");
      await syncCloud();
      return;
    }
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
      const legacy = previous == null ? await desktopApi.getSetting(LEGACY_SYNC_RUNS_KEY) : null;
      const parsed: unknown = previous ? JSON.parse(previous) : legacy ? JSON.parse(legacy) : [];
      const entries = Array.isArray(parsed)
        ? parsed.filter((n): n is number => Number.isSafeInteger(n) && n > 0).slice(-3000) : [];
      // Upgrade old receipt format: explicitly refresh the last four runs,
      // including repaired run #33. They were marked imported before the
      // operator audit lanes were available in GitHub bundles.
      const obsolete = new Set(previous == null ? [...entries].sort((a,b)=>b-a).slice(0,4) : []);
      const known = entries.filter((id) => !obsolete.has(id));
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
          const receipts = [...done].sort((a, b) => a - b).slice(-3000);
          await desktopApi.setSetting(SYNC_RUNS_KEY, JSON.stringify(receipts));
          setCompletedRuns(receipts);
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
        ? `Сінхранізавана запускаў: ${imported}.`
        : `Синхронизировано запусков: ${imported}.`);
      if (failures.length) setError(failures.join("\n"));
    } catch (reason) {
      setError((be ? "Сінхранізацыя TikTok: " : "Синхронизация TikTok: ") + String(reason));
    } finally { await syncCloud(); syncLock.current = false; setSyncing(false); }
  }, [be, isAdmin, syncCloud]);

  useEffect(() => {
    if (loading || !moderationLoaded) return;
    void syncNetwork(true);
    const artifactsInterval = isAdmin ? window.setInterval(() => void syncNetwork(true), 30 * 60 * 1000) : undefined;
    // Moderation and cloud archive convergence are much faster than GitHub artifact polling.
    const cloudInterval = window.setInterval(() => void syncCloud(), 2 * 60 * 1000);
    return () => { window.clearInterval(artifactsInterval); window.clearInterval(cloudInterval); };
  }, [loading, moderationLoaded, isAdmin, syncNetwork, syncCloud]);

  useEffect(() => {
    if (!isAdmin) { setModerationLoaded(true); return; }
    let cancelled = false;
    desktopApi.getSetting(MODERATION_KEY).then((value) => {
      if (cancelled) return;
      const parsed = normalizeNetworkModeration(value ? JSON.parse(value) : null);
      moderationRef.current = parsed; setModeration(parsed);
    }).catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setModerationLoaded(true); });
    return () => { cancelled = true; };
  }, [isAdmin]);

  async function updateModerationCloud(item: NetworkCard, change: { flagged?: boolean; delete?: boolean }) {
    if (moderationBusyRef.current || cloudLock.current) return;
    moderationBusyRef.current = true;
    setModerationBusy(true);
    try {
      const result = await applyTikTokCloudModeration(item.item_id, change);
      const old = moderationRef.current;
      const flagged = new Set(old.flagged), deleted = new Set(old.deleted);
      if (result.deleted) deleted.add(item.item_id);
      if (result.flagged && !result.deleted) flagged.add(item.item_id);
      else flagged.delete(item.item_id);
      const next: NetworkModeration = { ...old, flagged: [...flagged], deleted: [...deleted] };
      await desktopApi.setSetting(MODERATION_KEY, JSON.stringify(next));
      moderationRef.current = next;
      setModeration(next);
      if (result.deleted) setSlots((existing) => {
        const rest = existing.filter((url) => url && url !== item.source_url);
        return rest.length ? rest : [""];
      });
    } catch (reason) {
      setError((be ? "Не атрымалася захаваць на ўсіх прыладах: " : "Не удалось сохранить на всех устройствах: ") + String(reason));
    } finally {
      moderationBusyRef.current = false; setModerationBusy(false);
    }
  }
  async function moveClip(item: NetworkCard, section: TikTokMoveSection | null) {
    if (moderationBusyRef.current || cloudLock.current) return;
    moderationBusyRef.current = true;
    setModerationBusy(true);
    setError("");
    try {
      await uploadTikTokFinalCards([item]);
      await moveTikTokReviewCard(item.item_id, section);
      const sections = { ...moderationRef.current.sections };
      if (section) sections[item.item_id] = section;
      else delete sections[item.item_id];
      const next = { ...moderationRef.current, sections };
      moderationRef.current = next;
      setModeration(next);
      await desktopApi.setSetting(MODERATION_KEY, JSON.stringify(next));
    } catch (reason) {
      setError((be ? "Не атрымалася перанесці картку: " : "Не удалось перенести карточку: ") + String(reason));
    } finally {
      moderationBusyRef.current = false;
      setModerationBusy(false);
    }
  }
  function toggleFlag(item: NetworkCard) {
    void updateModerationCloud(item, { flagged: !moderationRef.current.flagged.includes(item.item_id) });
  }
  function removeClip(item: NetworkCard) {
    const approved = window.confirm(be
      ? "Выдаліць ролік з аглядаў і архіва на ўсіх прыладах? Захаваныя транскрыпцыі не выдаляюцца."
      : "Удалить ролик из обзоров и архива на всех устройствах? Сохранённые транскрипции не удаляются.");
    if (!approved) return;
    void updateModerationCloud(item, { delete: true });
  }

  useEffect(() => { localStorage.setItem(slotsKey, JSON.stringify(slots)); }, [slotsKey, slots]);
  useEffect(() => { localStorage.setItem(contextKey, JSON.stringify(sourceContext)); }, [contextKey, sourceContext]);
  // Migration: previously selected videos had a URL but no descriptive snapshot.
  // Recover their original captions from the already imported local Networks cards.
  useEffect(() => {
    if (!cards.length) return;
    setSourceContext((existing) => {
      let next = existing;
      for (const url of slots.filter(Boolean)) {
        if (next[url]) continue;
        const source = cards.find((item) => item.source_url === url);
        if (source) next = rememberSourceContext(next, url, contextFromCard(source));
      }
      return next;
    });
  }, [cards, slots]);

  const visible = useMemo(() => {
    const deleted = new Set(moderation.deleted);
    return selectOperatorArchive(cards).filter((item) => !deleted.has(item.item_id));
  }, [cards, moderation.deleted]);
  const runs = useMemo(() => latestOperatorRuns(cards, completedRuns), [cards, completedRuns]);
  const recent = useMemo(() => visible.filter((item) => runs.includes(operatorRun(item))), [visible, runs]);
  const trend = useMemo(() => networkTrend(visible, period, Date.now(), moderation.sections), [visible, period, moderation.sections]);
  const archive = useMemo(() => {
    const query = archiveQuery.trim().toLocaleLowerCase();
    return visible.filter((item) => !query || [
      item.title, item.text_excerpt, item.transcript_excerpt, item.source_url, item.item_id,
    ].some((value) => String(value || "").toLocaleLowerCase().includes(query)));
  }, [visible, archiveQuery]);
  const currentArchivePage = Math.min(archivePage, Math.max(0, Math.ceil(archive.length / 40) - 1));
  const selectedUrls = new Set(slots.filter(Boolean));

  function setSlot(index: number, url: string) {
    setSlots((previous) => previous.map((old, i) => i === index ? url : old));
  }

  function toggleClip(item: NetworkCard) {
    setError("");
    setSourceContext((current) => rememberSourceContext(current, item.source_url, contextFromCard(item)));
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
    if (!isAdmin) return;
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
        const key = networkTranscriptKey(url, operatorId);
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

  const renderCard = (item: NetworkCard) => <ClipCard key={item.item_id} item={item} be={be}
    checked={selectedUrls.has(item.source_url)} flagged={moderation.flagged.includes(item.item_id)}
    decision={moderation.sections?.[item.item_id]} canModerate={isAdmin} moderationBusy={moderationBusy || cloudSyncing}
    onToggle={toggleClip} onAdd={toggleClip} onFlag={toggleFlag} onDelete={removeClip} onMove={moveClip} />;

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

        <div className="network-sync-controls">
          <span className="network-sync-status">{syncing || cloudSyncing ? (be ? "Сінхранізацыя…" : "Синхронизация…") : cloudState || syncState || (isAdmin ? (be ? "Сінхранізацыя: архіў кожныя 30 хв., воблака кожныя 2 хв." : "Синхронизация: архив каждые 30 мин., облако каждые 2 мин.") : (be ? "Сінхранізацыя з воблачным архівам" : "Синхронизация с облачным архивом"))}</span>
          <button className="primary-button small-button" disabled={syncing || importing || cloudSyncing || moderationBusy} onClick={() => void syncNetwork(false)}>
            {be ? "Сінхранізаваць" : "Синхронизировать"}
          </button>
          {isAdmin && <button className="secondary-button small-button" disabled={importing || syncing} onClick={() => void importFile()}>
            {importing ? "…" : be ? "Імпарт ZIP / JSONL" : "Импорт ZIP / JSONL"}
          </button>}
        </div>
      </div>
      {notice && <div className="notice success">{notice}</div>}
      {error && <div className="notice error">{error}</div>}
      {loading && <div className="report-empty">{be ? "Чытаем лакальны архіў…" : "Загружаем локальный архив…"}</div>}
      {page === "home" && <div className="network-overview">
        {runs.length > 0 && <small className="network-run-label">
          {be ? "Запускі" : "Прогоны"} {runs.map((run) => `#${run}`).join(" · ")}
        </small>}
        {TIKTOK_SECTIONS.map((section) => {
          const group = recent.filter((item) => networkOperatorSection(item, moderation.sections?.[item.item_id]) === section);
          if (section === "review") {
            group.sort((a, b) => operatorRun(b) - operatorRun(a) || compareOperatorReview(a, b));
          }
          return <section className="panel network-group" key={section}>
            <div className="panel-head"><h3>{networkSectionName(section, be)}</h3></div>
            {group.length > 0
              ? <div className="network-card-list">{group.map(renderCard)}</div>
              : !loading && <div className="report-empty">{be ? "Няма матэрыялаў." : "Нет материалов."}</div>}
          </section>;
        })}
      </div>}
      {page === "archive" && <div className="network-overview">
        <section className="panel network-archive">
          <div className="panel-head"><h3>{be ? "Архіў TikTok" : "Архив TikTok"}</h3></div>
          <div className="network-archive-controls">
            <input value={archiveQuery} onChange={(event) => { setArchiveQuery(event.target.value); setArchivePage(0); }}
              placeholder={be ? "Пошук у архіве…" : "Поиск по архиву…"} aria-label={be ? "Пошук" : "Поиск"} />
          </div>
          <div className="network-card-list">{archive.slice(currentArchivePage * 40, (currentArchivePage + 1) * 40).map(renderCard)}</div>
          {!loading && !archive.length && <div className="report-empty">{be ? "Карткі не знойдзены." : "Карточки не найдены."}</div>}
          {archive.length > 40 && <div className="network-pagination">
            <button className="secondary-button small-button" disabled={currentArchivePage === 0}
              onClick={() => setArchivePage(currentArchivePage - 1)}>Назад</button>
            <span>{currentArchivePage + 1} / {Math.ceil(archive.length / 40)}</span>
            <button className="secondary-button small-button" disabled={(currentArchivePage + 1) * 40 >= archive.length}
              onClick={() => setArchivePage(currentArchivePage + 1)}>{be ? "Далей" : "Далее"}</button>
          </div>}
        </section>
        <details className="panel network-trend">
          <summary>{be ? "Дынаміка публікацый" : "Динамика публикаций"}</summary>
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
        </details>
      </div>}
      {page === "editor" && <NetworkEditorView operatorId={operatorId} slots={slots} setSlots={setSlots} sourceContext={sourceContext}
        onRemove={() => {}} transcribeSelected={() => void transcribeSelected()}
        batchBusy={transcribingBatch} batchRevision={batchRevision} />}
    </>}
  </div>;
}
