import { invoke } from "@tauri-apps/api/core";
import type {
  ArchiveFacets,
  ArchivePage,
  ArchiveQuery,
  DatabaseStats,
  DashboardOverview,
  EditorialSource,
  ImportResult,
  RunSummary,
  SourceSummary,
  SyncResult,
  PublicationModerationSnapshot,
  PublicationSummary,
  ReportExportItem,
  FullTextHydrationResult,
} from "./types";

let activeMonitorKey = "social_economic";

export const desktopApi = {
  setActiveMonitorKey: (monitorKey: string) => { activeMonitorKey = monitorKey; },
  activeMonitorKey: () => activeMonitorKey,
  stats: () => invoke<DatabaseStats>("get_database_stats"),
  runs: () => invoke<RunSummary[]>("list_runs"),
  importBundle: (path: string) =>
    invoke<ImportResult>("import_dashboard_bundle", { path }),
  dashboard: (periodDays: number | null) =>
    invoke<DashboardOverview>("get_dashboard_overview", {
      monitorKey: activeMonitorKey,
      periodDays,
    }),
  archiveFacets: () =>
    invoke<ArchiveFacets>("get_archive_facets", { monitorKey: activeMonitorKey }),
  archive: (options: ArchiveQuery = {}) =>
    invoke<ArchivePage>("list_publications", {
      monitorKey: options.monitorKey ?? activeMonitorKey,
      query: options.query ?? "",
      periodDays: options.periodDays ?? null,
      category: options.category ?? "",
      region: options.region ?? "",
      source: options.source ?? "",
      sources: options.sources ?? [],
      sort: options.sort ?? "newest",
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    }),
  topicBucketPublications: (category: string, bucket: string, limit = 8) =>
    invoke<PublicationSummary[]>("list_topic_bucket_publications", {
      monitorKey: activeMonitorKey,
      category,
      bucket,
      limit,
    }),
  search: (query: string, limit = 12) =>
    invoke<ArchivePage>("list_publications", {
      monitorKey: activeMonitorKey,
      query,
      periodDays: null,
      category: "",
      region: "",
      source: "",
      sources: [],
      sort: "newest",
      limit,
      offset: 0,
    }),
  sources: (periodDays: number | null = 30) =>
    invoke<SourceSummary[]>("list_sources", { monitorKey: activeMonitorKey, periodDays }),
  editorialSource: (documentUid: string) =>
    invoke<EditorialSource | null>("get_editorial_source", { monitorKey: activeMonitorKey, documentUid }),
  hydrateReportFullTexts: (documentUids: string[]) =>
    invoke<FullTextHydrationResult[]>("hydrate_report_full_texts", { monitorKey: activeMonitorKey, documentUids }),
  exportReport: (path: string, date: string, items: ReportExportItem[]) =>
    invoke<void>("export_report_docx", { path, date, items }),
  syncGithub: (repository: string, token: string) =>
    invoke<SyncResult>("sync_github_artifacts", { repository, token }),
  replaceModerationSnapshot: (snapshot: PublicationModerationSnapshot) =>
    invoke<void>("replace_moderation_snapshot", { monitorKey: activeMonitorKey, flags: snapshot.flags, exclusions: snapshot.exclusions }),
  getSetting: (key: string) => invoke<string | null>("get_app_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_app_setting", { key, value }),
  deleteSetting: (key: string) => invoke<void>("delete_app_setting", { key }),
  openUrl: (url: string) => invoke<void>("open_external_url", { url }),
};
