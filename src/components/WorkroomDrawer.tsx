import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicationLink, WorkroomConfig, WorkroomLocalItem, WorkroomMessage, WorkroomProfile, WorkroomSession } from "../types";
import { useI18n } from "../i18n";
import { clearWorkroomConfig, clearWorkroomSession, createWorkroomMessage, deleteWorkroomMessage, getWorkroomProfile, ensureWorkroomSession, listWorkroomMessages, listWorkroomContacts, listWorkroomConversation, listWorkroomUnread, loadCachedMessages, loadWorkroomConfig, loadWorkroomSession, markWorkroomRead, markConversationRead, sendWorkroomPrivateMessage, saveWorkroomConfig, saveWorkroomSession, signInWorkroom, updateWorkroomProfileName, hydrateWorkroomPersistence, type WorkroomContact } from "../workroom";
import { desktopApi } from "../api";
const LEGACY_STORAGE_KEY="monitor-dashboard-workroom-local-notes-v1";
function loadLegacyItems():WorkroomLocalItem[]{try{const raw=localStorage.getItem(LEGACY_STORAGE_KEY);return raw?JSON.parse(raw) as WorkroomLocalItem[]:[]}catch{return[]}}
function saveLegacyItems(items:WorkroomLocalItem[]){localStorage.setItem(LEGACY_STORAGE_KEY,JSON.stringify(items))}
function isConfigured(config:WorkroomConfig){return Boolean(config.url.trim()&&config.anonKey.trim())}
export function WorkroomDrawer({open,onClose,onUnreadChange}:{open:boolean;onClose:()=>void;onUnreadChange?:(count:number)=>void;}){
 const{t,formatLocale}=useI18n(); const[config,setConfig]=useState<WorkroomConfig>(loadWorkroomConfig),[session,setSession]=useState<WorkroomSession|null>(loadWorkroomSession),[profile,setProfile]=useState<WorkroomProfile|null>(null),[profileName,setProfileName]=useState(""),[editingName,setEditingName]=useState(false),[messages,setMessages]=useState<WorkroomMessage[]>(()=>isConfigured(loadWorkroomConfig())?loadCachedMessages(loadWorkroomConfig(),loadWorkroomSession()?.userId):[]),[legacyItems,setLegacyItems]=useState<WorkroomLocalItem[]>(loadLegacyItems),[text,setText]=useState(""),[kind,setKind]=useState<"note"|"announcement">("note"),[linkedPublication,setLinkedPublication]=useState<PublicationLink|null>(null),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[busy,setBusy]=useState(false),[feedBusy,setFeedBusy]=useState(false),[status,setStatus]=useState<"idle"|"online"|"offline">("idle"),[error,setError]=useState(""),[showSettings,setShowSettings]=useState(false),[draftConfig,setDraftConfig]=useState<WorkroomConfig>(config);
 const profileReady = Boolean(profile?.nameConfirmed && !editingName);
 const [peer, setPeer] = useState("");
 const [contacts, setContacts] = useState<WorkroomContact[]>([]);
 const [privateDrafts, setPrivateDrafts] = useState<Record<string, string>>({});
 const [conversation, setConversation] = useState<{ contact: string; items: WorkroomMessage[] } | null>(null);
 const [unread, setUnread] = useState({common: 0, contacts: {} as Record<string, number>});
 const [privateError, setPrivateError] = useState("");
 const [focused, setFocused] = useState(() => document.hasFocus() && !document.hidden);
 const request = useRef<AbortController | null>(null);
 const userId = session?.userId;
 const contact = contacts.find((item) => item.id === peer);

 useEffect(() => {
  let cancelled = false;
  hydrateWorkroomPersistence().then(({config: nextConfig, session: nextSession}) => {
   if (cancelled) return;
   setConfig(nextConfig); setDraftConfig(nextConfig); setSession(nextSession);
   setMessages(loadCachedMessages(nextConfig, nextSession?.userId));
  }).catch(() => undefined);
  return () => { cancelled = true; };
 }, []);

 useEffect(() => {
  function updateFocus() { setFocused(document.hasFocus() && !document.hidden); }
  window.addEventListener("focus", updateFocus);
  window.addEventListener("blur", updateFocus);
  document.addEventListener("visibilitychange", updateFocus);
  return () => {
   window.removeEventListener("focus", updateFocus);
   window.removeEventListener("blur", updateFocus);
   document.removeEventListener("visibilitychange", updateFocus);
  };
 }, []);

 const refresh = useCallback(async (silent = false) => {
  const active = loadWorkroomSession();
  if (!isConfigured(config) || !active || !userId || active.userId !== userId) return;
  if (silent && request.current) return;
  request.current?.abort();
  const controller = new AbortController();
  request.current = controller;
  const { signal } = controller;
  if (!silent) setFeedBusy(true);
  try {
   // Reuse the refreshed session for all requests in this poll.
   const activeSession = await ensureWorkroomSession(config, active);
   if (signal.aborted || activeSession.userId !== userId) return;
   if (open && !showSettings) {
    if (peer) {
     const items = await listWorkroomConversation(config, activeSession, peer, signal);
     if (signal.aborted) return;
     setConversation({contact: peer, items});
     if (focused && profileReady) {
      await markConversationRead(config, activeSession, items, signal);
     }
    } else {
     const result = await listWorkroomMessages(config, activeSession, signal);
     if (signal.aborted) return;
     setMessages(result.messages);
     if (focused && result.messages.length) {
      markWorkroomRead(config, userId, result.messages[0].createdAt);
     }
    }
    try {
     const next = await listWorkroomContacts(config, activeSession, signal);
     if (!signal.aborted) { setContacts(next); setPrivateError(""); }
    } catch (reason) {
     if (!signal.aborted) setPrivateError(String(reason));
    }
   }
   const counts = await listWorkroomUnread(config, activeSession, signal);
   if (!signal.aborted) {
    setUnread(counts); setStatus("online");
    if (loadWorkroomSession()?.userId === userId) {
     setSession((current) => current?.accessToken === activeSession.accessToken ? current : activeSession);
    }
   }
  } catch (reason) {
   if (signal.aborted) return;
   const message = String(reason);
   if (message.includes("AUTH_REQUIRED")) {
    setSession(null); setProfile(null); setMessages([]); setConversation(null);
   }
   setStatus("offline");
   if (!silent) setError(message);
  } finally {
   if (request.current === controller) { request.current = null; setFeedBusy(false); }
  }
 }, [config, userId, open, peer, focused, showSettings, profileReady]);

 useEffect(() => {
  const total = unread.common + Object.values(unread.contacts).reduce((sum, count) => sum + count, 0);
  onUnreadChange?.(userId ? total : 0);
 }, [onUnreadChange, unread, userId]);

 useEffect(() => {
  function onCompose(event: Event) {
   const detail = (event as CustomEvent<PublicationLink>).detail;
   if (detail?.url) { setPeer(""); setLinkedPublication(detail); }
  }
  window.addEventListener("monitor:workroom-compose", onCompose);
  return () => window.removeEventListener("monitor:workroom-compose", onCompose);
 }, []);

 useEffect(() => {
  if (!userId || !isConfigured(config)) return;
  void refresh(true);
  const interval = window.setInterval(() => void refresh(true), 20_000);
  return () => { window.clearInterval(interval); request.current?.abort(); request.current = null; };
 }, [config, userId, refresh]);

 useEffect(()=>{if(!isConfigured(config)||!session||profile?.id===session.userId)return;getWorkroomProfile(config,session).then(({profile:next,session:active})=>{setProfile(next);setProfileName(next.displayName);setEditingName(!next.nameConfirmed);setSession(active);saveWorkroomSession(active)}).catch(()=>undefined)},[config,session,profile?.id]);
 const sorted=useMemo(()=>[...messages].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.createdAt.localeCompare(a.createdAt)),[messages]);
 async function login(){if(!email.trim()||!password)return;setBusy(true);setError("");try{const next=await signInWorkroom(config,email.trim(),password);setSession(next);setPassword("");const identity=await getWorkroomProfile(config,next);setProfile(identity.profile);setProfileName(identity.profile.displayName);setEditingName(!identity.profile.nameConfirmed);setSession(identity.session);saveWorkroomSession(identity.session);setStatus("online");window.dispatchEvent(new Event("monitor:workroom-session-changed"))}catch(reason){setError(String(reason))}finally{setBusy(false)}}
 function resetConversations() {
  request.current?.abort();
  setPeer(""); setContacts([]); setPrivateDrafts({}); setConversation(null);
  setUnread({common: 0, contacts: {}}); setPrivateError("");
 }
 function logout(){clearWorkroomSession();setSession(null);setProfile(null);setProfileName("");setEditingName(false);setMessages([]);setStatus("idle");resetConversations();window.dispatchEvent(new Event("monitor:workroom-session-changed"))}
 function applySettings(){const saved=saveWorkroomConfig(draftConfig);clearWorkroomSession();setConfig(saved);setDraftConfig(saved);setSession(null);setProfile(null);setMessages([]);setShowSettings(false);setError("");setStatus("idle");resetConversations();window.dispatchEvent(new Event("monitor:workroom-session-changed"))}
 function removeSettings(){clearWorkroomConfig();const defaults=loadWorkroomConfig();saveWorkroomConfig(defaults);setConfig(defaults);setDraftConfig(defaults);setSession(null);setProfile(null);setMessages([]);setShowSettings(false);setStatus("idle");resetConversations();window.dispatchEvent(new Event("monitor:workroom-session-changed"))}
 async function saveProfileName(){if(!session)return;const value=profileName.trim();if(value.length<2||value.length>80){setError(t("workroom.nameRequired"));return}setBusy(true);setError("");try{const result=await updateWorkroomProfileName(config,session,value);setProfile(result.profile);setProfileName(result.profile.displayName);setEditingName(false);setSession(result.session);saveWorkroomSession(result.session);window.dispatchEvent(new Event("monitor:workroom-session-changed"))}catch(reason){setError(String(reason))}finally{setBusy(false)}}
 async function postMessage(input?:WorkroomLocalItem){const value=(input?.text??text).trim();if(!value||!session||!profile?.nameConfirmed||busy)return;setBusy(true);setError("");try{const result=await createWorkroomMessage(config,session,{kind:input?.kind??kind,text:value,publicationTitle:input?null:linkedPublication?.title??null,publicationUrl:input?null:linkedPublication?.url??null});setSession(result.session);saveWorkroomSession(result.session);if(!input){setText("");setLinkedPublication(null)}else{const nextLegacy=legacyItems.filter(item=>item.id!==input.id);setLegacyItems(nextLegacy);saveLegacyItems(nextLegacy)}await refresh(false)}catch(reason){setError(String(reason))}finally{setBusy(false)}}
 async function removeMessage(message:WorkroomMessage){if(!session)return;setBusy(true);setError("");try{const active=await deleteWorkroomMessage(config,session,message.id);setSession(active);saveWorkroomSession(active);await refresh(false)}catch(reason){setError(String(reason))}finally{setBusy(false)}}
 async function sendPrivate() {
  const value = (privateDrafts[peer] || "").trim();
  if (!session || !profileReady || !contact?.canReceive || !value || busy) return;
  const recipient = peer;
  setBusy(true); setError("");
  try {
   const result = await sendWorkroomPrivateMessage(config, session, recipient, value);
   setSession(result.session);
   setPrivateDrafts((drafts) => ({...drafts, [recipient]: ""}));
   await refresh(false);
  } catch (reason) { setError(String(reason)); }
  finally { setBusy(false); }
 }
 async function openLinked(url:string){try{await desktopApi.openUrl(url)}catch(reason){setError(String(reason))}}
 if(!open)return null;const configured=isConfigured(config),canDelete=(message:WorkroomMessage)=>Boolean(session&&(message.authorId===session.userId||profile?.isAdmin));
 return <><div className="drawer-backdrop" onMouseDown={onClose}/><aside className="workroom-drawer network-workroom"><div className="workroom-head"><div><span className="eyebrow">{t("workroom.eyebrow")}</span><h3>{t("workroom.title")}</h3></div><div className="workroom-head-actions">{configured&&<span className={`connection-dot ${status}`} title={status==="online"?t("workroom.online"):status==="offline"?t("workroom.offline"):t("workroom.connecting")}/>} {configured&&<button className="icon-button small" onClick={()=>setShowSettings(v=>!v)} title={t("workroom.settings")}>⚙</button>}<button className="icon-button" onClick={onClose}>×</button></div></div>
 {(!configured||showSettings)&&<div className="workroom-setup"><b>{t("workroom.setupTitle")}</b><p>{t("workroom.setupHelp")}</p><label>{t("workroom.projectUrl")}<input value={draftConfig.url} onChange={e=>setDraftConfig({...draftConfig,url:e.target.value})} placeholder="https://xxxx.supabase.co"/></label><label>{t("workroom.publicKey")}<input type="password" value={draftConfig.anonKey} onChange={e=>setDraftConfig({...draftConfig,anonKey:e.target.value})}/></label><label>{t("workroom.roomKey")}<input value={draftConfig.roomKey} onChange={e=>setDraftConfig({...draftConfig,roomKey:e.target.value})}/></label><div className="workroom-setup-actions"><button className="primary-button" onClick={applySettings}>{t("workroom.saveSettings")}</button>{configured&&<button className="ghost-button" onClick={()=>{setDraftConfig(config);setShowSettings(false)}}>{t("common.cancel")}</button>}{configured&&<button className="text-danger" onClick={removeSettings}>{t("workroom.clearSettings")}</button>}</div></div>}
 {configured&&!showSettings&&!session&&<div className="workroom-login"><b>{t("workroom.loginTitle")}</b><p>{t("workroom.loginHelp")}</p><label>{t("workroom.email")}<input value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username"/></label><label>{t("workroom.password")}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" onKeyDown={e=>{if(e.key==="Enter")login()}}/></label><button className="primary-button" disabled={busy} onClick={login}>{busy?t("workroom.connecting"):t("workroom.login")}</button></div>}
 {configured&&!showSettings&&session&&<><div className="workroom-session"><div><b>{profile?.displayName||session.email}</b><span>{status==="online"?t("workroom.online"):status==="offline"?t("workroom.offlineCached"):t("workroom.connecting")}{profile?.isAdmin?` · ${t("workroom.admin")}`:""}</span></div><div><button className="ghost-button small-button" disabled={feedBusy} onClick={()=>refresh(false)}>{feedBusy?"…":t("workroom.refresh")}</button><button className="ghost-button small-button" onClick={()=>{setProfileName(profile?.displayName??"");setEditingName(true)}}>{t("workroom.editName")}</button><button className="ghost-button small-button" onClick={logout}>{t("workroom.logout")}</button></div></div>
 {!profileReady&&<div className="workroom-profile-setup"><b>{t("workroom.profileTitle")}</b><p>{t("workroom.profileHelp")}</p><label>{t("workroom.displayName")}<input value={profileName} maxLength={80} onChange={e=>setProfileName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")saveProfileName()}}/></label><div className="workroom-setup-actions"><button className="primary-button" disabled={busy} onClick={saveProfileName}>{t("workroom.saveName")}</button>{profile?.nameConfirmed&&<button className="ghost-button" onClick={()=>{setProfileName(profile.displayName);setEditingName(false)}}>{t("common.cancel")}</button>}</div></div>}
 {profileReady&&<div className="workroom-conversation-picker">
   <label htmlFor="workroom-conversation">{t("workroom.conversation")}</label>
   <select id="workroom-conversation" value={peer} disabled={busy}
     onChange={(event) => { setPeer(event.target.value); setError(""); }}>
     <option value="">{t("workroom.commonChat")}{unread.common ? ` (${unread.common})` : ""}</option>
     {contacts.map((person) => <option key={person.id} value={person.id}>
       {person.name}{contacts.some((other) => other.id !== person.id && other.name === person.name)
         ? ` · ${person.id.slice(-6)}` : ""}{unread.contacts[person.id] ? ` (${unread.contacts[person.id]})` : ""}
     </option>)}
   </select>
 </div>}
 {privateError && <div className="workroom-error">{t("workroom.contactsUnavailable")}</div>}
 {profileReady && peer && <div className="workroom-compose">
   <label htmlFor="workroom-private-text">{t("workroom.privateTo", {name: contact?.name || t("workroom.user")})}</label>
   <textarea id="workroom-private-text" value={privateDrafts[peer] || ""} maxLength={4000}
     onChange={(event) => setPrivateDrafts({...privateDrafts, [peer]: event.target.value})}
     placeholder={t("workroom.privatePlaceholder")} disabled={busy || !contact?.canReceive}/>
   <button className="primary-button" disabled={busy || !contact?.canReceive || !(privateDrafts[peer] || "").trim()}
     onClick={() => void sendPrivate()}>{t("workroom.sendPrivate")}</button>
 </div>}
 {profileReady&&!peer&&<><div className="workroom-compose"><div className="segmented compact-segmented"><button className={kind==="note"?"active":""} onClick={()=>setKind("note")}>{t("workroom.note")}</button><button className={kind==="announcement"?"active":""} onClick={()=>setKind("announcement")}>{t("workroom.announcement")}</button></div>{linkedPublication&&<div className="linked-publication"><div><span>{t("workroom.linkedPublication")}</span><b>{linkedPublication.title}</b></div><button className="icon-button small" onClick={()=>setLinkedPublication(null)}>×</button></div>}<textarea value={text} maxLength={4000} onChange={e=>setText(e.target.value)} placeholder={t("workroom.placeholder")}/><button className="primary-button" disabled={busy||!text.trim()} onClick={()=>postMessage()}>{busy?t("workroom.sending"):t("workroom.send")}</button></div>{legacyItems.length>0&&<div className="legacy-note-block"><b>{t("workroom.localDrafts",{count:legacyItems.length})}</b><p>{t("workroom.localDraftsHelp")}</p>{legacyItems.slice(0,5).map(item=><div className="legacy-note-row" key={item.id}><span>{item.text}</span><button className="link-button" disabled={busy} onClick={()=>postMessage(item)}>{t("workroom.publish")}</button></div>)}</div>}</>}
 {error&&<div className="workroom-error">{error}</div>}
 {peer ? <div className="workroom-feed" aria-label={t("workroom.privateChat")}>
   {conversation?.contact === peer && (conversation.items.length
     ? conversation.items.map((item) => <article className="workroom-item note" key={item.id}>
       <div className="workroom-item-meta">
         <b>{item.authorId === userId ? profile?.displayName : contact?.name}</b>
         <span>{new Date(item.createdAt).toLocaleString(formatLocale)}</span>
       </div>
       <p>{item.text}</p>
     </article>)
     : <div className="empty-state">{t("workroom.emptyPrivate")}</div>)}
 </div> : <div className="workroom-feed">{sorted.length===0?<div className="empty-state">{t("workroom.emptyNetwork")}</div>:sorted.map(item=><article className={`workroom-item ${item.kind} ${item.pinned?"pinned":""}`} key={item.id}><div className="workroom-item-meta"><div><b>{item.authorName||t("workroom.user")}</b>{item.kind==="announcement"&&<span className="announcement-badge">{t("workroom.announcement")}</span>}</div><span>{new Date(item.createdAt).toLocaleString(formatLocale)}</span></div><p>{item.text}</p>{item.publicationUrl&&<button className="workroom-publication-link" onClick={()=>openLinked(item.publicationUrl!)}><span>{t("workroom.material")}</span><b>{item.publicationTitle||item.publicationUrl}</b></button>}<div className="workroom-item-actions">{item.pinned&&<span className="pin-label">{t("workroom.pinned")}</span>}{item.authorId !== userId && contacts.some((person) => person.id === item.authorId && person.canReceive) &&
   <button className="link-button" disabled={busy} onClick={() => { setPeer(item.authorId); setError(""); }}>{t("workroom.replyPrivate")}</button>}
 {canDelete(item)&&<button className="text-danger" disabled={busy} onClick={()=>removeMessage(item)}>{t("workroom.delete")}</button>}</div></article>)}</div>}</>}
 </aside></>;
}
