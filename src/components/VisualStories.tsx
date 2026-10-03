import { useState } from "react";
import type { PublicationSummary } from "../types";
import { desktopApi } from "../api";
import { useI18n } from "../i18n";

function VisualTile({ item }: { item: PublicationSummary }) {
  const [failed, setFailed] = useState(false);
  if (!item.previewImageUrl || failed) return null;
  return <button className="visual-story" onClick={() => desktopApi.openUrl(item.url).catch(() => undefined)} title={item.title}>
    <img src={item.previewImageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    <span className="visual-story-shade" />
    <span className="visual-story-copy"><small>{item.source}</small><b>{item.title}</b></span>
  </button>;
}

export function VisualStories({ items, maxItems = 4, showEmpty = false, row = false }: { items: PublicationSummary[]; maxItems?: number; showEmpty?: boolean; row?: boolean }) {
  const { t, locale } = useI18n();
  const available = items.filter((item) => Boolean(item.previewImageUrl)).slice(0, maxItems);
  if (!available.length && !showEmpty) return null;
  return <section className="panel visual-stories-panel">
    <div className="panel-head"><div><h3>{t("dashboard.visual")}</h3><p>{t("dashboard.visualHelp")}</p></div></div>
    {available.length
      ? <div className={`visual-stories-grid ${row ? "visual-stories-row" : ""}`}>{available.map((item) => <VisualTile item={item} key={item.id} />)}</div>
      : <div className="visual-stories-empty">{locale === "be" ? "У гэтым пакеце няма даступных выяў з публікацый." : "В этом пакете нет доступных изображений из публикаций."}</div>}
  </section>;
}
