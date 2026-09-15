export type ViewKey = "dashboard" | "archive" | "analytics" | "sources" | "data";
export type PeriodDays = 1 | 7 | 30 | 365 | null;

export type RunSummary = {
  id: number;
  monitorKey: string;
  monitorName: string;
  runNumber: number | null;
  externalRunId: string | null;
  startedAt: string | null;
  lookbackHours: number | null;
  dryRun: boolean | null;
  contractVersion: string;
  importedAt: string;
  publications: number;
  sourcesInResult: number;
  sourcesInCoverage: number;
};

export type DatabaseStats = {
  databasePath: string;
  databaseSizeBytes: number;
  schemaVersion: number;
  monitors: number;
  runs: number;
  documents: number;
  sources: number;
  monitorItems: number;
};

export type ImportResult = {
  status: "imported" | "replaced" | "already_imported";
  runId: number;
  monitorKey: string;
  runNumber: number | null;
  dryRun: boolean | null;
  contractVersion: string;
  publications: number;
  sourcesInResult: number;
  sourcesInCoverage: number;
  bundleSha256: string;
  inputKind: "direct_bundle" | "github_artifact_wrapper";
};

export type CountPoint = {
  label: string;
  count: number;
};

export type PublicationSummary = {
  id: number;
  title: string;
  url: string;
  publishedAt: string | null;
  source: string;
  category: string | null;
  subcategory: string | null;
  region: string | null;
  locality: string | null;
  eventObject: string | null;
  eventProblem: string | null;
  excerpt: string | null;
  score: number | null;
  officialResponse: boolean | null;
  seenInRuns: number;
};

export type DashboardOverview = {
  periodDays: number | null;
  publications: number;
  activeSources: number;
  regions: number;
  categories: number;
  officialResponses: number;
  trend: CountPoint[];
  categoryBreakdown: CountPoint[];
  sourceBreakdown: CountPoint[];
  regionBreakdown: CountPoint[];
  recent: PublicationSummary[];
};

export type ArchivePage = {
  total: number;
  items: PublicationSummary[];
};

export type ArchiveFacets = {
  categories: string[];
  regions: string[];
  sources: string[];
};

export type ArchiveQuery = {
  monitorKey?: string;
  query?: string;
  periodDays?: number | null;
  category?: string;
  region?: string;
  source?: string;
  sort?: "newest" | "oldest" | "score";
  limit?: number;
  offset?: number;
};

export type SourceSummary = {
  id: number;
  name: string;
  domain: string | null;
  sourceType: string | null;
  region: string | null;
  locality: string | null;
  priority: string | null;
  publications: number;
  totalResults: number;
  lastSeenAt: string | null;
  accessStatus: string | null;
  admissionStatus: string | null;
};

export type WorkroomLocalItem = {
  id: string;
  kind: "note" | "announcement";
  author: string;
  text: string;
  createdAt: string;
  pinned?: boolean;
};

export type SyncSettings = {
  repository: string;
  token: string;
  autoSync: boolean;
  intervalMinutes: number;
};

export type SyncResult = {
  checkedArtifacts: number;
  latestAvailableRun: number | null;
  importedRuns: number[];
  skippedDryRuns: number[];
  alreadyPresent: number;
  errors: string[];
};
