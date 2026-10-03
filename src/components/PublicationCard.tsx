import { desktopApi } from "../api";
import type { PublicationSummary } from "../types";
import { useI18n } from "../i18n";
import { localizeDataLabel } from "../dataLabels";
import { useModeration } from "../moderation";
import { useReportWorkspace } from "../reportWorkspace";

export function PublicationCard({ item, compact = false }: { item: PublicationSummary; compact?: boolean }) {
  const { t, formatLocale, locale } = useI18n();
  const moderation = useModeration();
  const report = useReportWorkspace();
  const flags = moderation.flagsFor(item.documentUid);
  const ownFlag = moderation.isOwnFlag(item.documentUid);
  const moderationBusy = moderation.busyDocumentUid === item.documentUid;
  const reportBusy = report.busyDocumentUid === item.documentUid;
  const inReport = report.contains(item.documentUid);
  const flaggers = [...new Set(flags.map((flag) => flag.userName).filter(Boolean))];
  const flagTitle = flags.length
    ? t("moderation.flaggedBy", { names: flaggers.join(", ") || t("workroom.user") })
    : moderation.profile
      ? t("moderation.flag")
      : t("moderation.loginToFlag");

  const formatDate = (value: string | null) => {
    if (!value) return t("publication.dateUnknown");
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(formatLocale, { dateStyle: "medium", timeStyle: "short" });
  };

  async function openOriginal() { try { await desktopApi.openUrl(item.url); } catch (error) { console.error(error); } }
  function discuss() { window.dispatchEvent(new CustomEvent("monitor:workroom-compose", { detail: { title: item.title, url: item.url } })); }
  async function toggleFlag() { try { await moderation.toggleFlag(item); } catch (error) { console.error(error); } }
  async function toggleReport() {
    try { await report.toggle(item); }
    catch (error) {
      if (String(error).includes("REPORT_MAX_ITEMS")) window.alert(locale === "be" ? "У агляд можна дадаць не больш за 8 матэрыялаў." : "В обзор можно добавить не более 8 материалов.");
      else console.error(error);
    }
  }
  async function keepAsRelevant() {
    if (!window.confirm(t("moderation.keepConfirm"))) return;
    try { await moderation.clearFlags(item); } catch (error) { console.error(error); }
  }
  async function excludeAsIrrelevant() {
    if (!window.confirm(t("moderation.excludeConfirm"))) return;
    try { await moderation.exclude(item); } catch (error) { console.error(error); }
  }

  const reportLabel = inReport
    ? (locale === "be" ? "У аглядзе ✓" : "В обзоре ✓")
    : (locale === "be" ? "У агляд" : "В обзор");

  return <article className={`publication-card ${compact ? "compact" : ""} ${flags.length ? "flagged" : ""}`}>
    <div className="publication-meta">
      <span className="source-chip">{item.source}</span>
      <span>{formatDate(item.publishedAt)}</span>
      {item.region && <span>{localizeDataLabel(item.region, locale, "region")}{item.locality && item.locality !== item.region ? ` · ${item.locality}` : ""}</span>}
      {item.officialResponse && <span className="reaction-badge" title={t("publication.reactionHelp")}>✓ {t("publication.reaction")}</span>}
      {flags.length > 0 && <span className="flagged-badge" title={flagTitle}>🚩 {t("moderation.flagged")}</span>}
    </div>
    <button className="publication-title" onClick={openOriginal}>{item.title}</button>
    {!compact && item.excerpt && <p className="publication-excerpt">{item.excerpt}</p>}
    <div className="publication-footer">
      <div className="tag-row">
        {item.category && <span className="tag">{localizeDataLabel(item.category, locale, "category")}</span>}
        {item.eventObject && <span className="tag subtle">{item.eventObject}</span>}
        {item.eventProblem && <span className="tag subtle">{item.eventProblem}</span>}
      </div>
      <div className="publication-actions">
        {item.seenInRuns > 1 && <span className="seen-count">{t("publication.inRuns", { count: item.seenInRuns })}</span>}
        <button className={`secondary-button small-button report-select-button ${inReport ? "active" : ""}`} disabled={reportBusy || (!inReport && report.maxItems !== null && report.items.length >= report.maxItems)} onClick={toggleReport}>{reportBusy ? "…" : reportLabel}</button>
        <button className={`moderation-flag-button ${flags.length ? "active" : ""} ${ownFlag ? "own" : ""}`} disabled={moderationBusy} onClick={toggleFlag} title={flagTitle} aria-label={flagTitle}>🚩</button>
        {moderation.profile?.isAdmin && flags.length > 0 && <button className="link-button moderation-keep" disabled={moderationBusy} onClick={keepAsRelevant} title={t("moderation.keepHelp")}>{t("moderation.keep")}</button>}
        {moderation.profile?.isAdmin && <button className="link-button moderation-delete" disabled={moderationBusy} onClick={excludeAsIrrelevant} title={t("moderation.excludeHelp")}>{t("moderation.exclude")}</button>}
        <button className="link-button discuss-link" onClick={discuss}>{t("publication.discuss")}</button>
        <button className="link-button" onClick={openOriginal}>{t("publication.open")}</button>
      </div>
    </div>
  </article>;
}
