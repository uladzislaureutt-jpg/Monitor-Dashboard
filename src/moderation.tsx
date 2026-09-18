import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { desktopApi } from "./api";
import type { PublicationModerationFlag, PublicationModerationSnapshot, PublicationSummary, WorkroomProfile } from "./types";
import {
  clearPublicationFlags,
  excludePublication,
  flagPublication,
  getWorkroomProfile,
  listPublicationModeration,
  loadWorkroomConfig,
  loadWorkroomSession,
  saveWorkroomSession,
  unflagPublication,
} from "./workroom";

const MONITOR_KEY = "social_economic";
const CACHE_KEY = "monitor-publication-moderation-cache-v1";
const EMPTY: PublicationModerationSnapshot = { flags: [], exclusions: [] };

type ModerationContextValue = {
  snapshot: PublicationModerationSnapshot;
  profile: WorkroomProfile | null;
  ready: boolean;
  busyDocumentUid: string | null;
  flagsFor: (documentUid: string) => PublicationModerationFlag[];
  isOwnFlag: (documentUid: string) => boolean;
  toggleFlag: (item: PublicationSummary) => Promise<void>;
  clearFlags: (item: PublicationSummary) => Promise<void>;
  exclude: (item: PublicationSummary) => Promise<void>;
  refresh: (announce?: boolean) => Promise<void>;
};

const ModerationContext = createContext<ModerationContextValue | null>(null);

function loadCached(): PublicationModerationSnapshot {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as PublicationModerationSnapshot | null;
    return parsed && Array.isArray(parsed.flags) && Array.isArray(parsed.exclusions) ? parsed : EMPTY;
  } catch {
    return EMPTY;
  }
}

function saveCached(snapshot: PublicationModerationSnapshot) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
}

function sameSnapshot(a: PublicationModerationSnapshot, b: PublicationModerationSnapshot) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function openWorkroom() {
  window.dispatchEvent(new CustomEvent("monitor:workroom-compose", { detail: null }));
}

export function ModerationProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<PublicationModerationSnapshot>(loadCached);
  const [profile, setProfile] = useState<WorkroomProfile | null>(null);
  const [ready, setReady] = useState(false);
  const [busyDocumentUid, setBusyDocumentUid] = useState<string | null>(null);
  const snapshotRef = useRef(snapshot);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);

  const refresh = useCallback(async (announce = false) => {
    const config = loadWorkroomConfig();
    const session = loadWorkroomSession();
    if (!config.url.trim() || !config.anonKey.trim() || !session) {
      setProfile(null);
      setReady(false);
      return;
    }
    try {
      const identity = await getWorkroomProfile(config, session);
      setProfile(identity.profile);
      saveWorkroomSession(identity.session);
      const result = await listPublicationModeration(config, identity.session, MONITOR_KEY);
      saveWorkroomSession(result.session);
      await desktopApi.replaceModerationSnapshot(result.snapshot);
      const changed = !sameSnapshot(snapshotRef.current, result.snapshot);
      setSnapshot(result.snapshot);
      saveCached(result.snapshot);
      setReady(true);
      if (changed || announce) window.dispatchEvent(new Event("monitor:moderation-changed"));
    } catch {
      setReady(false);
    }
  }, []);

  useEffect(() => {
    refresh(false);
    const interval = window.setInterval(() => refresh(false), 30_000);
    const onAuth = () => refresh(true);
    window.addEventListener("monitor:workroom-session-changed", onAuth);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("monitor:workroom-session-changed", onAuth);
    };
  }, [refresh]);

  const action = useCallback(async (documentUid: string, run: (config: ReturnType<typeof loadWorkroomConfig>, session: NonNullable<ReturnType<typeof loadWorkroomSession>>) => Promise<unknown>) => {
    const config = loadWorkroomConfig();
    const session = loadWorkroomSession();
    if (!config.url.trim() || !config.anonKey.trim() || !session) {
      openWorkroom();
      return;
    }
    setBusyDocumentUid(documentUid);
    try {
      await run(config, session);
      await refresh(true);
    } finally {
      setBusyDocumentUid(null);
    }
  }, [refresh]);

  const flagsByDocument = useMemo(() => {
    const map = new Map<string, PublicationModerationFlag[]>();
    for (const flag of snapshot.flags) {
      const list = map.get(flag.documentUid) ?? [];
      list.push(flag);
      map.set(flag.documentUid, list);
    }
    return map;
  }, [snapshot.flags]);

  const flagsFor = useCallback((documentUid: string) => flagsByDocument.get(documentUid) ?? [], [flagsByDocument]);
  const isOwnFlag = useCallback((documentUid: string) => Boolean(profile && flagsFor(documentUid).some((flag) => flag.userId === profile.id)), [flagsFor, profile]);

  const toggleFlag = useCallback(async (item: PublicationSummary) => {
    const own = isOwnFlag(item.documentUid);
    await action(item.documentUid, (config, session) => own
      ? unflagPublication(config, session, item.documentUid, MONITOR_KEY)
      : flagPublication(config, session, item.documentUid, MONITOR_KEY));
  }, [action, isOwnFlag]);

  const clearFlags = useCallback(async (item: PublicationSummary) => {
    if (!profile?.isAdmin) return;
    await action(item.documentUid, (config, session) => clearPublicationFlags(config, session, item.documentUid, MONITOR_KEY));
  }, [action, profile?.isAdmin]);

  const exclude = useCallback(async (item: PublicationSummary) => {
    if (!profile?.isAdmin) return;
    await action(item.documentUid, (config, session) => excludePublication(config, session, item.documentUid, MONITOR_KEY));
  }, [action, profile?.isAdmin]);

  const value = useMemo<ModerationContextValue>(() => ({
    snapshot,
    profile,
    ready,
    busyDocumentUid,
    flagsFor,
    isOwnFlag,
    toggleFlag,
    clearFlags,
    exclude,
    refresh,
  }), [snapshot, profile, ready, busyDocumentUid, flagsFor, isOwnFlag, toggleFlag, clearFlags, exclude, refresh]);

  return <ModerationContext.Provider value={value}>{children}</ModerationContext.Provider>;
}

export function useModeration() {
  const value = useContext(ModerationContext);
  if (!value) throw new Error("useModeration must be used inside ModerationProvider");
  return value;
}
