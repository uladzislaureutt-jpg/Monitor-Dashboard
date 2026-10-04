import { invoke } from "@tauri-apps/api/core";
import type {
  WorkroomConfig,
  WorkroomMessage,
  WorkroomProfile,
  WorkroomSession,
  PublicationModerationFlag,
  PublicationModerationExclusion,
  PublicationModerationSnapshot,
  AccessRequestLocalState,
  AdminSnapshot,
  MonitorAccessState,
} from "./types";

const CONFIG_KEY = "monitor-workroom-network-config-v1";
const SESSION_KEY = "monitor-workroom-network-session-v1";
const PERSIST_CONFIG_KEY = "workroom.config.v1";
const PERSIST_SESSION_KEY = "workroom.session.v1";
const DEFAULT_WORKROOM_CONFIG: WorkroomConfig = {
  url: "https://kcmmnngcjfmyjzzczvko.supabase.co",
  anonKey: "sb_publishable_YBBgEf75Jl6TRlSIgILGgQ_uz15ucef",
  roomKey: "sep-monitor",
};
const CACHE_PREFIX = "monitor-workroom-message-cache-v1";
const READ_PREFIX = "monitor-workroom-last-read-v1";
const ACCESS_REQUEST_KEY = "monitor-access-request-v1";

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function configScope(config: WorkroomConfig) {
  return `${normalizeBaseUrl(config.url)}::${config.roomKey.trim() || "sep-monitor"}`;
}

function cacheKey(config: WorkroomConfig) {
  return `${CACHE_PREFIX}:${configScope(config)}`;
}

function readKey(config: WorkroomConfig) {
  return `${READ_PREFIX}:${configScope(config)}`;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function loadWorkroomConfig(): WorkroomConfig {
  const parsed = parseJson<Partial<WorkroomConfig>>(localStorage.getItem(CONFIG_KEY));
  return {
    url: typeof parsed?.url === "string" && parsed.url.trim() ? parsed.url : DEFAULT_WORKROOM_CONFIG.url,
    anonKey: typeof parsed?.anonKey === "string" && parsed.anonKey.trim() ? parsed.anonKey : DEFAULT_WORKROOM_CONFIG.anonKey,
    roomKey: typeof parsed?.roomKey === "string" && parsed.roomKey.trim() ? parsed.roomKey : DEFAULT_WORKROOM_CONFIG.roomKey,
  };
}

async function persistentGet(key: string) {
  try { return await invoke<string | null>("get_app_setting", { key }); } catch { return null; }
}
async function persistentSet(key: string, value: string) {
  try { await invoke<void>("set_app_setting", { key, value }); } catch { /* localStorage remains compatibility fallback */ }
}
async function persistentDelete(key: string) {
  try { await invoke<void>("delete_app_setting", { key }); } catch { /* best effort */ }
}

export async function hydrateWorkroomPersistence() {
  const localConfig = loadWorkroomConfig();
  const storedConfigRaw = await persistentGet(PERSIST_CONFIG_KEY);
  const storedConfig = parseJson<Partial<WorkroomConfig>>(storedConfigRaw);
  const config: WorkroomConfig = storedConfig ? {
    url: typeof storedConfig.url === "string" && storedConfig.url.trim() ? storedConfig.url : DEFAULT_WORKROOM_CONFIG.url,
    anonKey: typeof storedConfig.anonKey === "string" && storedConfig.anonKey.trim() ? storedConfig.anonKey : DEFAULT_WORKROOM_CONFIG.anonKey,
    roomKey: typeof storedConfig.roomKey === "string" && storedConfig.roomKey.trim() ? storedConfig.roomKey : DEFAULT_WORKROOM_CONFIG.roomKey,
  } : localConfig;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  if (!storedConfigRaw) await persistentSet(PERSIST_CONFIG_KEY, JSON.stringify(config));

  const localSession = loadWorkroomSession();
  const storedSessionRaw = await persistentGet(PERSIST_SESSION_KEY);
  const storedSession = parseJson<WorkroomSession>(storedSessionRaw);
  const session = storedSession ?? localSession;
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    if (!storedSessionRaw) await persistentSet(PERSIST_SESSION_KEY, JSON.stringify(session));
  }
  return { config, session };
}

export function saveWorkroomConfig(config: WorkroomConfig) {
  const normalized = {
    url: normalizeBaseUrl(config.url),
    anonKey: config.anonKey.trim(),
    roomKey: config.roomKey.trim() || "sep-monitor",
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
  void persistentSet(PERSIST_CONFIG_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearWorkroomConfig() {
  localStorage.removeItem(CONFIG_KEY);
  void persistentDelete(PERSIST_CONFIG_KEY);
  clearWorkroomSession();
}

export function loadWorkroomSession(): WorkroomSession | null {
  return parseJson<WorkroomSession>(localStorage.getItem(SESSION_KEY));
}

export function saveWorkroomSession(session: WorkroomSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  void persistentSet(PERSIST_SESSION_KEY, JSON.stringify(session));
}

export function clearWorkroomSession() {
  localStorage.removeItem(SESSION_KEY);
  void persistentDelete(PERSIST_SESSION_KEY);
}

export function loadCachedMessages(config: WorkroomConfig): WorkroomMessage[] {
  return parseJson<WorkroomMessage[]>(localStorage.getItem(cacheKey(config))) ?? [];
}

function saveCachedMessages(config: WorkroomConfig, messages: WorkroomMessage[]) {
  localStorage.setItem(cacheKey(config), JSON.stringify(messages.slice(0, 120)));
}

export function loadLastRead(config: WorkroomConfig): string {
  return localStorage.getItem(readKey(config)) ?? "";
}

export function markWorkroomRead(config: WorkroomConfig, at: string) {
  localStorage.setItem(readKey(config), at);
}

function assertConfigured(config: WorkroomConfig) {
  if (!config.url.trim() || !config.anonKey.trim()) throw new Error("WORKROOM_NOT_CONFIGURED");
}

async function readResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function messageFromRow(row: Record<string, unknown>): WorkroomMessage {
  return {
    id: String(row.id ?? ""),
    roomKey: String(row.room_key ?? "sep-monitor"),
    kind: row.kind === "announcement" ? "announcement" : "note",
    authorId: String(row.author_id ?? ""),
    authorName: String(row.author_name ?? ""),
    text: String(row.text ?? ""),
    publicationTitle: row.publication_title ? String(row.publication_title) : null,
    publicationUrl: row.publication_url ? String(row.publication_url) : null,
    pinned: Boolean(row.pinned),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? row.created_at ?? ""),
  };
}

function sessionFromAuth(payload: Record<string, unknown>): WorkroomSession {
  const user = (payload.user ?? {}) as Record<string, unknown>;
  const expiresIn = Number(payload.expires_in ?? 3600);
  return {
    accessToken: String(payload.access_token ?? ""),
    refreshToken: String(payload.refresh_token ?? ""),
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
    userId: String(user.id ?? ""),
    email: String(user.email ?? ""),
  };
}

async function authRequest(config: WorkroomConfig, path: string, body: unknown) {
  assertConfigured(config);
  const response = await fetch(`${normalizeBaseUrl(config.url)}${path}`, {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await readResponse(response);
  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`AUTH_${response.status}: ${detail}`);
  }
  return payload as Record<string, unknown>;
}

export async function signInWorkroom(config: WorkroomConfig, email: string, password: string) {
  const payload = await authRequest(config, "/auth/v1/token?grant_type=password", { email, password });
  const session = sessionFromAuth(payload);
  if (!session.accessToken || !session.refreshToken || !session.userId) throw new Error("AUTH_INVALID_RESPONSE");
  saveWorkroomSession(session);
  return session;
}

async function refreshSession(config: WorkroomConfig, session: WorkroomSession) {
  const payload = await authRequest(config, "/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refreshToken });
  const next = sessionFromAuth(payload);
  saveWorkroomSession(next);
  return next;
}

export async function ensureWorkroomSession(config: WorkroomConfig, session: WorkroomSession | null) {
  if (!session) throw new Error("AUTH_REQUIRED");
  if (session.expiresAt - Date.now() > 60_000) return session;
  try { return await refreshSession(config, session); }
  catch (error) { clearWorkroomSession(); throw error; }
}

async function apiRequest(
  config: WorkroomConfig,
  session: WorkroomSession,
  path: string,
  init: RequestInit = {},
) {
  const active = await ensureWorkroomSession(config, session);
  const response = await fetch(`${normalizeBaseUrl(config.url)}${path}`, {
    ...init,
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${active.accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const payload = await readResponse(response);
  if (response.status === 401) {
    clearWorkroomSession();
    throw new Error("AUTH_REQUIRED");
  }
  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`WORKROOM_${response.status}: ${detail}`);
  }
  return { payload, session: active };
}

export async function getWorkroomProfile(config: WorkroomConfig, session: WorkroomSession) {
  const params = new URLSearchParams({
    select: "id,display_name,email,is_admin,name_confirmed,status,locale",
    id: `eq.${session.userId}`,
    limit: "1",
  });
  const { payload, session: active } = await apiRequest(config, session, `/rest/v1/monitor_profiles?${params.toString()}`);
  const rows = Array.isArray(payload) ? payload as Array<Record<string, unknown>> : [];
  const row = rows[0];
  if (!row) throw new Error("PROFILE_NOT_FOUND");
  const profile: WorkroomProfile = {
    id: session.userId,
    displayName: row.display_name ? String(row.display_name) : session.email,
    email: row.email ? String(row.email) : session.email,
    isAdmin: Boolean(row.is_admin),
    nameConfirmed: Boolean(row.name_confirmed),
    status: row.status === "suspended" ? "suspended" : "active",
    locale: row.locale === "be" ? "be" : "ru",
  };
  return { profile, session: active };
}

export async function updateWorkroomProfileName(config: WorkroomConfig, session: WorkroomSession, displayName: string) {
  const value = displayName.trim(); if (value.length < 2 || value.length > 80) throw new Error("PROFILE_NAME_INVALID");
  const params = new URLSearchParams({ id: `eq.${session.userId}` });
  const { payload, session: active } = await apiRequest(config, session, `/rest/v1/monitor_profiles?${params.toString()}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ display_name: value, name_confirmed: true }) });
  const rows = Array.isArray(payload) ? payload as Array<Record<string, unknown>> : []; const row=rows[0];
  const profile: WorkroomProfile = { id: session.userId, displayName: row?.display_name ? String(row.display_name) : value, email: row?.email ? String(row.email) : session.email, isAdmin: Boolean(row?.is_admin), nameConfirmed: Boolean(row?.name_confirmed ?? true), status: row?.status === "suspended" ? "suspended" : "active", locale: row?.locale === "be" ? "be" : "ru" };
  return { profile, session: active };
}

export async function updateWorkroomProfileLocale(config: WorkroomConfig, session: WorkroomSession, locale: "ru" | "be") {
  const params = new URLSearchParams({ id: `eq.${session.userId}` });
  const { session: active } = await apiRequest(config, session, `/rest/v1/monitor_profiles?${params.toString()}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ locale }),
  });
  return active;
}

export async function listWorkroomMessages(config: WorkroomConfig, session: WorkroomSession) {
  const params = new URLSearchParams({
    select: "id,room_key,kind,author_id,author_name,text,publication_title,publication_url,pinned,created_at,updated_at",
    room_key: `eq.${config.roomKey}`,
    order: "pinned.desc,created_at.desc",
    limit: "100",
  });
  const { payload, session: active } = await apiRequest(config, session, `/rest/v1/workroom_messages?${params.toString()}`);
  const messages = (Array.isArray(payload) ? payload : []).map((row) => messageFromRow(row as Record<string, unknown>));
  saveCachedMessages(config, messages);
  return { messages, session: active };
}

export async function createWorkroomMessage(
  config: WorkroomConfig,
  session: WorkroomSession,
  input: {
    kind: "note" | "announcement";
    text: string;
    publicationTitle?: string | null;
    publicationUrl?: string | null;
  },
) {
  const { payload, session: active } = await apiRequest(config, session, "/rest/v1/workroom_messages", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      room_key: config.roomKey,
      kind: input.kind,
      text: input.text,
      publication_title: input.publicationTitle || null,
      publication_url: input.publicationUrl || null,
    }),
  });
  const rows = Array.isArray(payload) ? payload as Array<Record<string, unknown>> : [];
  const message = rows[0] ? messageFromRow(rows[0]) : null;
  return { message, session: active };
}

export async function deleteWorkroomMessage(config: WorkroomConfig, session: WorkroomSession, id: string) {
  const params = new URLSearchParams({ id: `eq.${id}` });
  const { session: active } = await apiRequest(config, session, `/rest/v1/workroom_messages?${params.toString()}`, {
    method: "DELETE",
  });
  return active;
}


function moderationFlagFromRow(row: Record<string, unknown>): PublicationModerationFlag {
  return {
    documentUid: String(row.document_uid ?? ""),
    userId: String(row.user_id ?? ""),
    userName: String(row.user_name ?? ""),
    flaggedAt: String(row.created_at ?? ""),
  };
}

function moderationExclusionFromRow(row: Record<string, unknown>): PublicationModerationExclusion {
  return {
    documentUid: String(row.document_uid ?? ""),
    excludedByName: String(row.excluded_by_name ?? ""),
    excludedAt: String(row.created_at ?? ""),
  };
}

export async function listPublicationModeration(config: WorkroomConfig, session: WorkroomSession, monitorKey = "social_economic") {
  const common = { room_key: `eq.${config.roomKey}`, monitor_key: `eq.${monitorKey}` };
  const flagParams = new URLSearchParams({
    select: "document_uid,user_id,user_name,created_at",
    ...common,
    order: "created_at.asc",
  });
  const exclusionParams = new URLSearchParams({
    select: "document_uid,excluded_by_name,created_at",
    ...common,
    order: "created_at.asc",
  });
  const first = await apiRequest(config, session, `/rest/v1/publication_flags?${flagParams.toString()}`);
  const second = await apiRequest(config, first.session, `/rest/v1/publication_exclusions?${exclusionParams.toString()}`);
  const snapshot: PublicationModerationSnapshot = {
    flags: (Array.isArray(first.payload) ? first.payload : []).map((row) => moderationFlagFromRow(row as Record<string, unknown>)),
    exclusions: (Array.isArray(second.payload) ? second.payload : []).map((row) => moderationExclusionFromRow(row as Record<string, unknown>)),
  };
  return { snapshot, session: second.session };
}

export async function flagPublication(config: WorkroomConfig, session: WorkroomSession, documentUid: string, monitorKey = "social_economic") {
  const cleared = await unflagPublication(config, session, documentUid, monitorKey);
  const { session: active } = await apiRequest(config, cleared, "/rest/v1/publication_flags", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ room_key: config.roomKey, monitor_key: monitorKey, document_uid: documentUid, user_id: cleared.userId }),
  });
  return active;
}

export async function unflagPublication(config: WorkroomConfig, session: WorkroomSession, documentUid: string, monitorKey = "social_economic") {
  const query = new URLSearchParams({
    room_key: `eq.${config.roomKey}`,
    monitor_key: `eq.${monitorKey}`,
    document_uid: `eq.${documentUid}`,
    user_id: `eq.${session.userId}`,
  });
  const { session: active } = await apiRequest(config, session, `/rest/v1/publication_flags?${query.toString()}`, { method: "DELETE" });
  return active;
}

export async function clearPublicationFlags(config: WorkroomConfig, session: WorkroomSession, documentUid: string, monitorKey = "social_economic") {
  const query = new URLSearchParams({
    room_key: `eq.${config.roomKey}`,
    monitor_key: `eq.${monitorKey}`,
    document_uid: `eq.${documentUid}`,
  });
  const { session: active } = await apiRequest(config, session, `/rest/v1/publication_flags?${query.toString()}`, { method: "DELETE" });
  return active;
}

export async function excludePublication(config: WorkroomConfig, session: WorkroomSession, documentUid: string, monitorKey = "social_economic") {
  const query = new URLSearchParams({ room_key: `eq.${config.roomKey}`, monitor_key: `eq.${monitorKey}`, document_uid: `eq.${documentUid}` });
  const cleared = await apiRequest(config, session, `/rest/v1/publication_exclusions?${query.toString()}`, { method: "DELETE" });
  const { session: active } = await apiRequest(config, cleared.session, "/rest/v1/publication_exclusions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ room_key: config.roomKey, monitor_key: monitorKey, document_uid: documentUid, excluded_by: cleared.session.userId }),
  });
  return clearPublicationFlags(config, active, documentUid, monitorKey);
}


function randomRequestToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function loadAccessRequest(): AccessRequestLocalState | null {
  return parseJson<AccessRequestLocalState>(localStorage.getItem(ACCESS_REQUEST_KEY));
}

export function clearAccessRequest() {
  localStorage.removeItem(ACCESS_REQUEST_KEY);
}

async function edgeRequest(config: WorkroomConfig, slug: string, body: unknown, session?: WorkroomSession | null) {
  assertConfigured(config);
  const active = session ? await ensureWorkroomSession(config, session) : null;
  const response = await fetch(`${normalizeBaseUrl(config.url)}/functions/v1/${slug}`, {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      "Content-Type": "application/json",
      ...(active ? { Authorization: `Bearer ${active.accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await readResponse(response);
  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`EDGE_${response.status}: ${detail}`);
  }
  return { payload: payload as Record<string, unknown>, session: active };
}

export async function requestMonitorAccess(config: WorkroomConfig, displayName: string, email: string, locale: "ru" | "be") {
  const requestToken = randomRequestToken();
  const { payload } = await edgeRequest(config, "monitor-access", {
    action: "request",
    display_name: displayName.trim(),
    email: email.trim().toLowerCase(),
    locale,
    request_token: requestToken,
  });
  const state: AccessRequestLocalState = {
    requestId: String(payload.request_id ?? ""),
    requestToken,
    email: email.trim().toLowerCase(),
    displayName: displayName.trim(),
    locale,
  };
  if (!state.requestId) throw new Error("ACCESS_REQUEST_INVALID_RESPONSE");
  localStorage.setItem(ACCESS_REQUEST_KEY, JSON.stringify(state));
  return state;
}

export async function checkMonitorAccessRequest(config: WorkroomConfig, state: AccessRequestLocalState) {
  const { payload } = await edgeRequest(config, "monitor-access", {
    action: "status",
    request_id: state.requestId,
    request_token: state.requestToken,
  });
  return {
    status: String(payload.status ?? "pending") as "pending" | "approved" | "rejected",
    registered: Boolean(payload.registered),
  };
}

export async function completeMonitorRegistration(config: WorkroomConfig, state: AccessRequestLocalState, password: string) {
  await edgeRequest(config, "monitor-access", {
    action: "complete",
    request_id: state.requestId,
    request_token: state.requestToken,
    password,
  });
  clearAccessRequest();
}

export async function requestPasswordRecovery(config: WorkroomConfig, email: string) {
  await authRequest(config, "/auth/v1/recover", { email: email.trim().toLowerCase() });
}

function monitorAccessFromRow(row: Record<string, unknown>): MonitorAccessState {
  return {
    monitorKey: String(row.monitor_key ?? ""),
    enabled: Boolean(row.enabled),
    maintenanceMessageRu: String(row.maintenance_message_ru ?? "Технические работы"),
    maintenanceMessageBe: String(row.maintenance_message_be ?? "Тэхнічныя работы"),
  };
}

export async function listMonitorAccess(config: WorkroomConfig, session: WorkroomSession) {
  const params = new URLSearchParams({
    select: "monitor_key,enabled,maintenance_message_ru,maintenance_message_be",
    order: "monitor_key.asc",
  });
  const { payload, session: active } = await apiRequest(config, session, `/rest/v1/monitor_access?${params.toString()}`);
  return {
    monitors: (Array.isArray(payload) ? payload : []).map((row) => monitorAccessFromRow(row as Record<string, unknown>)),
    session: active,
  };
}

export async function adminAccessAction(config: WorkroomConfig, session: WorkroomSession, body: Record<string, unknown>) {
  const { payload, session: active } = await edgeRequest(config, "monitor-admin", body, session);
  return { payload, session: active! };
}

export async function getAdminSnapshot(config: WorkroomConfig, session: WorkroomSession) {
  const { payload, session: active } = await adminAccessAction(config, session, { action: "list" });
  const requests = (Array.isArray(payload.requests) ? payload.requests : []).map((row: any) => ({
    id: String(row.id),
    displayName: String(row.display_name ?? ""),
    email: String(row.email ?? ""),
    locale: row.locale === "be" ? "be" as const : "ru" as const,
    status: (row.status === "approved" || row.status === "rejected" ? row.status : "pending") as "pending" | "approved" | "rejected",
    requestedAt: String(row.requested_at ?? ""),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    registeredAt: row.registered_at ? String(row.registered_at) : null,
  }));
  const users = (Array.isArray(payload.users) ? payload.users : []).map((row: any) => ({
    id: String(row.id),
    displayName: String(row.display_name ?? ""),
    email: String(row.email ?? ""),
    isAdmin: Boolean(row.is_admin),
    status: row.status === "suspended" ? "suspended" as const : "active" as const,
    locale: row.locale === "be" ? "be" as const : "ru" as const,
    createdAt: String(row.created_at ?? ""),
    lastSignInAt: row.last_sign_in_at ? String(row.last_sign_in_at) : null,
  }));
  const monitors = (Array.isArray(payload.monitors) ? payload.monitors : []).map((row: any) => monitorAccessFromRow(row));
  const audit = (Array.isArray(payload.audit) ? payload.audit : []).map((row: any) => ({
    id: Number(row.id),
    action: String(row.action ?? ""),
    targetUserId: row.target_user_id ? String(row.target_user_id) : null,
    monitorKey: row.monitor_key ? String(row.monitor_key) : null,
    createdAt: String(row.created_at ?? ""),
  }));
  const snapshot: AdminSnapshot = { requests, users, monitors, audit };
  return { snapshot, session: active };
}
