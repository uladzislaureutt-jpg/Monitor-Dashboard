import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { desktopApi } from "../api";
import { ensureWorkroomSession, loadWorkroomConfig, loadWorkroomSession } from "../workroom";
import { useI18n } from "../i18n";
import { TrendColumns, TrendLine } from "../components/Charts";
import { TranscriptionView } from "./TranscriptionView";
import {
  cardTimestamp, effectiveCategory, importNetworkCards, isTikTokVideoUrl,
  mergeNetworkCards, NETWORK_GROUPS, networkCategoryName, networkTrend,
  publishedTimestamp, type NetworkCard, type NetworkCategory,
} from "../networks";

const CARDS_STORAGE_KEY = "networks.tiktok.cards.v1";
const SLOTS_STORAGE_KEY = "monitor-networks-tiktok-video-slots-v1";
type NetworkPage = "home" | "archive";
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

function ClipCard({ item, be, checked, onToggle }: {
  item: NetworkCard; be: boolean; checked: boolean; onToggle: (item: NetworkCard) => void;
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
      <strong>{item.title || (be ? "Відэа без загалоўка" : "Видео без заголовка")}</strong>
      {shortText && <p>{shortText.slice(0, 440)}{shortText.length > 440 ? "…" : ""}</p>}
      <div className="network-clip-bottom">
        <button className="link-button" onClick={() => void desktopApi.openUrl(item.source_url)}>
          {be ? "Адкрыць відэа ў TikTok ↗" : "Открыть видео в TikTok ↗"}
        </button>
        <span>{item.item_id}</span>
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
  const [transcribingBatch, setTranscribingBatch] = useState(false);
  const [batchRevision, setBatchRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    desktopApi.getSetting(CARDS_STORAGE_KEY).then((data) => {
      if (cancelled || !data) return;
      const parsed: unknown = JSON.parse(data);
      if (!Array.isArray(parsed)) throw new Error("Invalid stored networks cards");
      setCards(mergeNetworkCards([], parsed as NetworkCard[]));
    }).catch((reason) => {
      if (!cancelled) setError(be ? "Памылка чытання лакальнага архіва: " + reason : "Ошибка чтения локального архива: " + reason);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { localStorage.setItem(SLOTS_STORAGE_KEY, JSON.stringify(slots)); }, [slots]);

  const now = Date.now();
  const trend = useMemo(() => networkTrend(cards, period, now), [cards, period]);
  const inPeriod = useMemo(() => cards.filter((item) => {
    if (period === null) return true;
    const date = publishedTimestamp(item) || cardTimestamp(item);
    return date > 0 && date >= now - period * 86_400_000 && date <= now + 86_400_000;
  }), [cards, period]);
  const recent = useMemo(() => inPeriod.filter((item) =>
    item.queue !== "archive" && effectiveCategory(item) !== "REJECT" && item.queue !== "date_unknown" && publishedTimestamp(item) > 0
  ), [inPeriod]);
  const archive = useMemo(() => cards.filter((item) => {
    if (archiveCategory !== "ALL" && effectiveCategory(item) !== archiveCategory) return false;
    const query = archiveQuery.trim().toLocaleLowerCase();
    return !query || [item.title, item.text_excerpt, item.transcript_excerpt, item.source_url, item.item_id]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  }), [cards, archiveCategory, archiveQuery]);
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
    if (!path || Array.isArray(path)) return;
    setImporting(true); setNotice(""); setError("");
    try {
      const source = await desktopApi.readNetworksJsonl(path);
      const next = importNetworkCards(source);
      const merged = mergeNetworkCards(cards, next);
      await desktopApi.setSetting(CARDS_STORAGE_KEY, JSON.stringify(merged));
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
    checked={selectedUrls.has(item.source_url)} onToggle={toggleClip} />;

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
        </div>
        <button className="secondary-button small-button" disabled={importing} onClick={() => void importFile()}>
          {importing ? "…" : be ? "Імпарт вынікаў TikTok" : "Импорт результатов TikTok"}
        </button>
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
      <section className="panel network-transcription-select">
        <div className="panel-head"><div><h3>{be ? "Апрацоўка выбраных відэа" : "Обработка выбранных видео"}</h3>
          <p>{be ? "Адзначце ролікі вышэй. Да пяці незалежных транскрыпцый; кожны тэкст і каментарыі захоўваюцца асобна." : "Отметьте ролики выше. До пяти независимых транскрипций; текст и комментарии каждого видео сохраняются отдельно."}</p></div></div>
        <div className="network-video-slots">
          {slots.map((url, index) => <div className="network-video-slot" key={index}>
            <button className={activeSlot === index ? "primary-button small-button" : "secondary-button small-button"}
              onClick={() => setActiveSlot(index)}>{be ? "Відэа" : "Видео"} {index + 1}</button>
            <input value={url} onChange={(event) => setSlot(index, event.target.value)}
              placeholder="https://www.tiktok.com/@.../video/..." aria-label={`Видео ${index + 1} URL`} />
            {url && <button className="ghost-button small-button" title={be ? "Ачысціць слот" : "Очистить слот"} onClick={() => setSlot(index, "")}>×</button>}
          </div>)}
          {slots.length < 5 && <button className="secondary-button small-button network-add-slot"
            onClick={() => { setSlots((old) => [...old, ""]); setActiveSlot(slots.length); }}
            title={be ? "Дадаць відэа" : "Добавить видео"}>+ {be ? "Відэа" : "Видео"} {slots.length + 1}</button>}
        </div>
        <div className="network-batch-actions"><button className="primary-button small-button" disabled={transcribingBatch || !slots.some((url) => !!url.trim())} onClick={() => void transcribeSelected()}>{transcribingBatch ? (be ? "Транскрыпцыя…" : "Транскрипция…") : be ? "Транскрыбаваць выбраныя відэа" : "Транскрибировать выбранные видео"}</button><span>{be ? "Па чарзе, без паўторнай апрацоўкі гатовых тэкстаў." : "Последовательно, без повторной обработки готовых текстов."}</span></div>
        {activeUrl && !isTikTokVideoUrl(activeUrl) && <div className="notice error">{be ? "Патрэбна прамая спасылка на відэа TikTok." : "Нужна прямая ссылка на видео TikTok."}</div>}
      </section>
      {activeUrl && isTikTokVideoUrl(activeUrl) ?
        <TranscriptionView key={`${activeUrl}:${batchRevision}`} initialUrl={activeUrl}
          storageKey={`monitor-networks-transcription:${activeUrl}`} embedded />
        : <section className="panel network-empty">
          <p>{be ? "Абярыце відэа для транскрыпцыі. Ніжэй з'явяцца зыходны тэкст, тэкст для экспарту, надпісы на відэа, каментарыі і DOCX." : "Выберите видео для транскрипции. Здесь появятся исходный текст, текст для экспорта, надписи на видео, комментарии и DOCX."}</p>
        </section>}
    </>}
  </div>;
}
