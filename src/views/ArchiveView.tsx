import { useEffect, useMemo, useState } from "react";
import { desktopApi } from "../api";
import type { ArchiveFacets, ArchivePage, PeriodDays } from "../types";
import { useI18n } from "../i18n";
import { PublicationCard } from "../components/PublicationCard";
import { PeriodSelector } from "../components/PeriodSelector";
import { localizeDataLabel } from "../dataLabels";

const EMPTY_FACETS: ArchiveFacets = { categories: [], regions: [], sources: [] };

export function ArchiveView({ initialQuery = "" }: { initialQuery?: string }) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const [period, setPeriod] = useState<PeriodDays>(30);
  const [category, setCategory] = useState("");
  const [region, setRegion] = useState("");
  const [source, setSource] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest" | "score">("newest");
  const [facets, setFacets] = useState<ArchiveFacets>(EMPTY_FACETS);
  const [page, setPage] = useState<ArchivePage>({ total: 0, items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const pageSize = 30;

  useEffect(() => { setQuery(initialQuery); setOffset(0); }, [initialQuery]);
  useEffect(() => { desktopApi.archiveFacets().then(setFacets).catch((reason) => setError(String(reason))); }, []);
  useEffect(() => {
    setLoading(true);
    desktopApi.archive({ query, periodDays: period, category, region, source, sort, limit: pageSize, offset })
      .then((result) => { setPage(result); setError(""); })
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
  }, [query, period, category, region, source, sort, offset]);

  const pageNumber = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(page.total / pageSize));
  const hasFilters = useMemo(() => Boolean(query || category || region || source || period !== 30 || sort !== "newest"), [query, category, region, source, period, sort]);
  function reset() { setQuery(""); setPeriod(30); setCategory(""); setRegion(""); setSource(""); setSort("newest"); setOffset(0); }

  return <div className="view-stack">
    <section className="view-heading archive-heading"><div><div className="eyebrow dark">{t("archive.eyebrow")}</div><h2>{t("archive.title")}</h2><p>{t("archive.subtitle")}</p></div><PeriodSelector value={period} onChange={(value) => { setPeriod(value); setOffset(0); }} /></section>
    <section className="panel filters-panel">
      <div className="archive-search-row"><div className="archive-search-box"><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder={t("archive.search")} /></div><select value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); setOffset(0); }}><option value="newest">{t("archive.newest")}</option><option value="oldest">{t("archive.oldest")}</option><option value="score">{t("archive.score")}</option></select></div>
      <div className="filter-row"><select value={category} onChange={(event) => { setCategory(event.target.value); setOffset(0); }}><option value="">{t("archive.allCategories")}</option>{facets.categories.map((value) => <option key={value} value={value}>{localizeDataLabel(value, locale, "category")}</option>)}</select><select value={region} onChange={(event) => { setRegion(event.target.value); setOffset(0); }}><option value="">{t("archive.allRegions")}</option>{facets.regions.map((value) => <option key={value} value={value}>{localizeDataLabel(value, locale, "region")}</option>)}</select><select value={source} onChange={(event) => { setSource(event.target.value); setOffset(0); }}><option value="">{t("archive.allSources")}</option>{facets.sources.map((value) => <option key={value}>{value}</option>)}</select>{hasFilters && <button className="ghost-button" onClick={reset}>{t("archive.reset")}</button>}</div>
    </section>
    {error && <div className="notice error">{error}</div>}
    <div className="archive-summary"><b>{loading ? t("archive.searching") : page.total}</b> {t("archive.materials")} <span>· {t("archive.page", { page: pageNumber, pages })}</span></div>
    <section className="archive-list">{!loading && page.items.length === 0 ? <div className="panel empty-state">{t("archive.empty")}</div> : page.items.map((item) => <PublicationCard key={item.id} item={item} />)}</section>
    <div className="pagination"><button className="secondary-button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>{t("archive.back")}</button><span>{pageNumber} / {pages}</span><button className="secondary-button" disabled={offset + pageSize >= page.total || loading} onClick={() => setOffset(offset + pageSize)}>{t("archive.next")}</button></div>
  </div>;
}
