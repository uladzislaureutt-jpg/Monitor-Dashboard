import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "./i18n";
import type { MonitorAccessState, WorkroomProfile, WorkroomSession } from "./types";
import {
  checkMonitorAccessRequest,
  clearAccessRequest,
  clearWorkroomSession,
  completeMonitorRegistration,
  getWorkroomProfile,
  hydrateWorkroomPersistence,
  listMonitorAccess,
  loadAccessRequest,
  loadWorkroomConfig,
  requestMonitorAccess,
  requestPasswordRecovery,
  saveWorkroomSession,
  signInWorkroom,
  updateWorkroomProfileLocale,
} from "./workroom";

type AccessContextValue = {
  profile: WorkroomProfile;
  session: WorkroomSession;
  monitors: MonitorAccessState[];
  refreshAccess: () => Promise<void>;
  setPreferredLocale: (locale: "ru" | "be") => Promise<void>;
  logout: () => void;
};

const AccessContext = createContext<AccessContextValue | null>(null);

export function useMonitorAccess() {
  const value = useContext(AccessContext);
  if (!value) throw new Error("useMonitorAccess must be used inside MonitorAccessProvider");
  return value;
}

export function MonitorAccessProvider({ children }: { children: ReactNode }) {
  const { locale, setLocale } = useI18n();
  const [session, setSession] = useState<WorkroomSession | null>(null);
  const [profile, setProfile] = useState<WorkroomProfile | null>(null);
  const [monitors, setMonitors] = useState<MonitorAccessState[]>([]);
  const [loading, setLoading] = useState(true);

  async function refreshAccess(activeSession = session) {
    if (!activeSession) return;
    try {
      const config = loadWorkroomConfig();
      const identity = await getWorkroomProfile(config, activeSession);
      setSession(identity.session);
      saveWorkroomSession(identity.session);
      setProfile(identity.profile);
      if (identity.profile.locale !== locale) setLocale(identity.profile.locale);
      if (identity.profile.status !== "active") return;
      const access = await listMonitorAccess(config, identity.session);
      setSession(access.session);
      saveWorkroomSession(access.session);
      setMonitors(access.monitors);
    } catch {
      clearWorkroomSession();
      setSession(null);
      setProfile(null);
      setMonitors([]);
    }
  }

  useEffect(() => {
    let cancelled = false;
    hydrateWorkroomPersistence().then(async ({ session: restored }) => {
      if (cancelled) return;
      if (!restored) { setLoading(false); return; }
      setSession(restored);
      try {
        const config = loadWorkroomConfig();
        const identity = await getWorkroomProfile(config, restored);
        if (cancelled) return;
        setSession(identity.session);
        saveWorkroomSession(identity.session);
        setProfile(identity.profile);
        if (identity.profile.locale !== locale) setLocale(identity.profile.locale);
        if (identity.profile.status === "active") {
          const access = await listMonitorAccess(config, identity.session);
          if (!cancelled) {
            setSession(access.session);
            saveWorkroomSession(access.session);
            setMonitors(access.monitors);
          }
        }
      } catch {
        clearWorkroomSession();
        if (!cancelled) { setSession(null); setProfile(null); setMonitors([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }).catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => { void refreshAccess(session); }, 30_000);
    return () => window.clearInterval(timer);
  }, [session?.userId]);
  useEffect(() => {
    const onSessionChanged = () => {
      const current = localStorage.getItem("monitor-workroom-network-session-v1");
      if (!current) {
        setSession(null);
        setProfile(null);
        setMonitors([]);
      }
    };
    window.addEventListener("monitor:workroom-session-changed", onSessionChanged);
    return () => window.removeEventListener("monitor:workroom-session-changed", onSessionChanged);
  }, []);

  async function setPreferredLocale(nextLocale: "ru" | "be") {
    setLocale(nextLocale);
    if (!session) return;
    try {
      const active = await updateWorkroomProfileLocale(loadWorkroomConfig(), session, nextLocale);
      setSession(active);
      saveWorkroomSession(active);
      setProfile((current) => current ? { ...current, locale: nextLocale } : current);
    } catch { /* local language switch remains available */ }
  }


  function logout() {
    clearWorkroomSession();
    setSession(null);
    setProfile(null);
    setMonitors([]);
    window.dispatchEvent(new Event("monitor:workroom-session-changed"));
  }

  if (loading) return <div className="access-splash"><div className="brand-mark large">M</div><span>Monitor</span></div>;
  if (!session || !profile) return <AccessScreen onAuthenticated={(nextSession, nextProfile, nextMonitors) => {
    setSession(nextSession); setProfile(nextProfile); setMonitors(nextMonitors);
    if (nextProfile.locale !== locale) setLocale(nextProfile.locale);
  }} />;
  if (profile.status !== "active") return <div className="access-shell"><div className="access-card suspended-card"><div className="brand-mark large">M</div><h1>{locale === "be" ? "Доступ прыпынены" : "Доступ приостановлен"}</h1><p>{locale === "be" ? "Доступ да Monitor прыпынены адміністратарам." : "Доступ к Monitor приостановлен администратором."}</p><button className="primary-button" onClick={logout}>{locale === "be" ? "Выйсці" : "Выйти"}</button></div></div>;

  const value: AccessContextValue = { profile, session, monitors, refreshAccess: () => refreshAccess(session), setPreferredLocale, logout };
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

function AccessScreen({ onAuthenticated }: { onAuthenticated: (session: WorkroomSession, profile: WorkroomProfile, monitors: MonitorAccessState[]) => void }) {
  const { locale, setLocale } = useI18n();
  const config = loadWorkroomConfig();
  const [mode, setMode] = useState<"login" | "request">("login");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [requestState, setRequestState] = useState(loadAccessRequest);
  const [requestStatus, setRequestStatus] = useState<"pending" | "approved" | "rejected" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const be = locale === "be";
  const tx = {
    title: be ? "Маніторынг СМІ" : "Мониторинг СМИ",
    subtitle: be ? "Увайдзіце ў Monitor або запытайце доступ у адміністратара." : "Войдите в Monitor или запросите доступ у администратора.",
    login: be ? "Увайсці" : "Войти",
    request: be ? "Запытаць доступ" : "Запросить доступ",
    name: be ? "Імя / лагін" : "Имя / логин",
    email: "E-mail",
    password: be ? "Пароль" : "Пароль",
    confirm: be ? "Паўтарыце пароль" : "Повторите пароль",
    send: be ? "Адправіць запыт" : "Отправить запрос",
    pending: be ? "Запыт адпраўлены і чакае рашэння адміністратара." : "Запрос отправлен и ожидает решения администратора.",
    approved: be ? "Доступ дазволены. Прыдумайце пароль: не менш за 8 сімвалаў, мінімум адна літара і адна лічба." : "Доступ разрешён. Придумайте пароль: не менее 8 символов, минимум одна буква и одна цифра.",
    rejected: be ? "Запыт адхілены адміністратарам." : "Запрос отклонён администратором.",
    check: be ? "Праверыць рашэнне" : "Проверить решение",
    create: be ? "Стварыць уліковы запіс" : "Создать учётную запись",
    forgot: be ? "Забылі пароль?" : "Забыли пароль?",
    recovery: be ? "Спасылка для аднаўлення адпраўлена, калі адрас зарэгістраваны." : "Ссылка для восстановления отправлена, если адрес зарегистрирован.",
  };

  useEffect(() => {
    if (requestState) {
      setMode("request");
      setEmail(requestState.email);
      setDisplayName(requestState.displayName);
      void checkRequest(requestState, true);
    }
  }, []);

  async function login() {
    if (!email.trim() || !password) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await signInWorkroom(config, email.trim(), password);
      const identity = await getWorkroomProfile(config, next);
      if (identity.profile.status !== "active") {
        clearWorkroomSession();
        setError(be ? "Доступ прыпынены адміністратарам." : "Доступ приостановлен администратором.");
        return;
      }
      const access = await listMonitorAccess(config, identity.session);
      saveWorkroomSession(access.session);
      onAuthenticated(access.session, identity.profile, access.monitors);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function submitRequest() {
    if (displayName.trim().length < 2 || !email.includes("@")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const state = await requestMonitorAccess(config, displayName, email, locale);
      setRequestState(state); setRequestStatus("pending"); setMessage(tx.pending);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function checkRequest(state = requestState, silent = false) {
    if (!state) return;
    if (!silent) setBusy(true);
    setError("");
    try {
      const result = await checkMonitorAccessRequest(config, state);
      setRequestStatus(result.status);
      if (!silent) setMessage(result.status === "pending" ? tx.pending : result.status === "approved" ? tx.approved : tx.rejected);
    } catch (reason) { if (!silent) setError(String(reason)); }
    finally { if (!silent) setBusy(false); }
  }

  async function completeRegistration() {
    if (!requestState) return;
    if (password.length < 8 || !/[A-Za-zА-Яа-яЁёІіЎў]/.test(password) || !/\d/.test(password) || password !== confirm) {
      setError(be ? "Пароль павінен мець не менш за 8 сімвалаў, літару і лічбу; абодва ўводы павінны супадаць." : "Пароль должен содержать не менее 8 символов, букву и цифру; оба ввода должны совпадать.");
      return;
    }
    setBusy(true); setError("");
    try {
      await completeMonitorRegistration(config, requestState, password);
      setRequestState(null); setRequestStatus(null);
      const next = await signInWorkroom(config, requestState.email, password);
      const identity = await getWorkroomProfile(config, next);
      const access = await listMonitorAccess(config, identity.session);
      saveWorkroomSession(access.session);
      onAuthenticated(access.session, identity.profile, access.monitors);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function recover() {
    if (!email.trim()) return;
    setBusy(true); setError("");
    try { await requestPasswordRecovery(config, email); setMessage(tx.recovery); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  function resetRejected() {
    clearAccessRequest();
    setRequestState(null); setRequestStatus(null); setMessage(""); setError("");
  }

  return <div className="access-shell">
    <div className="access-card">
      <div className="access-brand"><div className="brand-mark large">M</div><div><b>Monitor</b><span>{tx.title}</span></div></div>
      <div className="access-language"><button className={locale === "ru" ? "active" : ""} onClick={() => setLocale("ru")}>РУ</button><button className={locale === "be" ? "active" : ""} onClick={() => setLocale("be")}>БЕЛ</button></div>
      <h1>{tx.title}</h1><p>{tx.subtitle}</p>
      {!requestState && <div className="access-tabs"><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>{tx.login}</button><button className={mode === "request" ? "active" : ""} onClick={() => setMode("request")}>{tx.request}</button></div>}
      {message && <div className="notice success">{message}</div>}
      {error && <div className="notice error">{error}</div>}
      {mode === "login" && !requestState && <div className="access-form">
        <label>{tx.email}<input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
        <label>{tx.password}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={(e) => { if (e.key === "Enter") void login(); }} /></label>
        <button className="primary-button" disabled={busy} onClick={login}>{busy ? "…" : tx.login}</button>
        <button className="link-button access-forgot" disabled={busy || !email.trim()} onClick={recover}>{tx.forgot}</button>
      </div>}
      {(mode === "request" || requestState) && <div className="access-form">
        {!requestState && <><label>{tx.name}<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} /></label><label>{tx.email}<input value={email} onChange={(e) => setEmail(e.target.value)} /></label><button className="primary-button" disabled={busy || displayName.trim().length < 2 || !email.includes("@")} onClick={submitRequest}>{busy ? "…" : tx.send}</button></>}
        {requestState && requestStatus !== "approved" && requestStatus !== "rejected" && <><div className="access-request-state">{tx.pending}</div><button className="secondary-button" disabled={busy} onClick={() => checkRequest()}>{busy ? "…" : tx.check}</button></>}
        {requestState && requestStatus === "approved" && <><div className="access-request-state approved">{tx.approved}</div><label>{tx.password}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label><label>{tx.confirm}<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label><button className="primary-button" disabled={busy} onClick={completeRegistration}>{busy ? "…" : tx.create}</button></>}
        {requestState && requestStatus === "rejected" && <><div className="access-request-state rejected">{tx.rejected}</div><button className="secondary-button" onClick={resetRejected}>{tx.request}</button></>}
      </div>}
    </div>
  </div>;
}
