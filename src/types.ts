export type ViewKey = "dashboard" | "archive" | "report" | "analytics" | "sources" | "data";
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

export type TopicTrendPoint = {
  bucket: string;
  category: string;
  count: number;
};


export type SourceDiversitySummary = {
  activeSources: number;
  topSource: string | null;
  topSourceShare: number;
  topFiveShare: number;
  diversityIndex: number;
  effectiveSources: number;
};

export type CoverageHealthSummary = {
  runNumber: number | null;
  totalSources: number;
  stableSources: number;
  recoverySources: number;
  limitedSources: number;
  attentionSources: number;
};

export type PublicationSummary = {
  id: number;
  documentUid: string;
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
  previewImageUrl: string | null;
  hasFullText: boolean;
  seenInRuns: number;
};

export type StorySummary = {
  title: string;
  representative: PublicationSummary;
  publications: PublicationSummary[];
};

export type DashboardOverview = {
  periodDays: number | null;
  publications: number;
  activeSources: number;
  regions: number;
  categories: number;
  officialResponses: number;
  trend: CountPoint[];
  topicTrend: TopicTrendPoint[];
  categoryBreakdown: CountPoint[];
  sourceBreakdown: CountPoint[];
  regionBreakdown: CountPoint[];
  conceptBreakdown: CountPoint[];
  personBreakdown: CountPoint[];
  stories: StorySummary[];
  resonanceItems: PublicationSummary[];
  resonanceFallback: boolean;
  sourceDiversity: SourceDiversitySummary;
  coverageHealth: CoverageHealthSummary;
  visuals: PublicationSummary[];
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
  sources?: string[];
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

export type WorkroomConfig = {
  url: string;
  anonKey: string;
  roomKey: string;
};

export type WorkroomSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email: string;
};

export type WorkroomProfile = {
  id: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  nameConfirmed: boolean;
  status: "active" | "suspended";
  locale: "ru" | "be";
};

export type MonitorAccessState = {
  monitorKey: "social_economic" | "lukashenko" | string;
  enabled: boolean;
  maintenanceMessageRu: string;
  maintenanceMessageBe: string;
};

export type AccessRequestLocalState = {
  requestId: string;
  requestToken: string;
  email: string;
  displayName: string;
  locale: "ru" | "be";
};

export type AdminAccessRequest = {
  id: string;
  displayName: string;
  email: string;
  locale: "ru" | "be";
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  reviewedAt: string | null;
  registeredAt: string | null;
};

export type AdminUser = {
  id: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  status: "active" | "suspended";
  locale: "ru" | "be";
  createdAt: string;
  lastSignInAt: string | null;
};

export type AdminAuditItem = {
  id: number;
  action: string;
  targetUserId: string | null;
  monitorKey: string | null;
  createdAt: string;
};

export type AdminSnapshot = {
  requests: AdminAccessRequest[];
  users: AdminUser[];
  monitors: MonitorAccessState[];
  audit: AdminAuditItem[];
};

export type WorkroomMessage = {
  id: string;
  roomKey: string;
  kind: "note" | "announcement";
  authorId: string;
  authorName: string;
  text: string;
  publicationTitle: string | null;
  publicationUrl: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PublicationLink = {
  title: string;
  url: string;
};

export type EditorialEntity = {
  entityType: string;
  name: string;
  surfaceForm: string | null;
  confidence: number | null;
  mentions: number;
  method: string | null;
};

export type EditorialSource = {
  documentUid: string;
  title: string;
  url: string;
  source: string;
  fullText: string | null;
  textSha256: string | null;
  quality: string | null;
  extractionStrategy: string | null;
  transport: string | null;
  entities: EditorialEntity[];
};



export type ReportDraftItem = {
  documentUid: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  region: string | null;
  locality: string | null;
  excerpt: string | null;
  score: number | null;
  officialResponse: boolean | null;
  sourceText: string;
  sourceQuality: "full" | "partial" | "missing";
  sourceOrigin?: "contract" | "manual" | "excerpt";
  editorialText: string;
};

export type ReportExportItem = {
  source: string;
  location: string;
  title: string;
  text: string;
  url: string;
};

export type FullTextHydrationResult = {
  documentUid: string;
  status: "fetched" | "already_present" | "failed";
  textLength: number | null;
  detail: string | null;
};

export type KnownSourceArticleResult = {
  title: string;
  source: string;
  region: string | null;
  url: string;
  text: string;
  quality: "full" | "partial";
  strategy: string;
};

export type KnownSourceMetadataResult = {
  source: string;
  region: string | null;
  url: string;
};


export type PublicationModerationFlag = {
  documentUid: string;
  userId: string;
  userName: string;
  flaggedAt: string;
};

export type PublicationModerationExclusion = {
  documentUid: string;
  excludedByName: string;
  excludedAt: string;
};

export type PublicationModerationSnapshot = {
  flags: PublicationModerationFlag[];
  exclusions: PublicationModerationExclusion[];
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
  latestRemoteRun: number | null;
  latestImportedRun: number | null;
  importedRuns: number[];
  skippedDryRuns: number[];
  alreadyPresent: number;
  errors: string[];
};
