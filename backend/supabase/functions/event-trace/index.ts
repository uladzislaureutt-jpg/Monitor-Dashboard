import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { eventPublicationWindow, TASK_LIMIT } from "./core.ts";
import { cloudflareConfigured } from "./providers.ts";
import { newscatcherConfigured, newsPageLimit, type NewsAccounting } from "./newscatcher.ts";
import { trace, type TraceInput } from "./trace.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const table = "monitor_event_runs";
const columns = "id,task,options,status,stage,result,created_at,updated_at";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !service) return json({ error: "not_configured" }, 503);
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  try {
    const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { data: { user }, error: userError } = await auth.auth.getUser();
    if (userError || !user) return json({ error: "unauthorized" }, 401);
    const { data: profile, error: profileError } = await admin.from("monitor_profiles").select("is_admin,status").eq("id", user.id).maybeSingle();
    if (profileError) return json({ error: "access_check_failed" }, 503);
    if (!profile || profile.status !== "active") return json({ error: "access_denied" }, 403);

    if (!profile.is_admin) {
      const [module, personal] = await Promise.all([
        admin.from("monitor_access").select("enabled").eq("monitor_key", "event_trace").maybeSingle(),
        admin.from("user_monitor_access").select("enabled").eq("user_id", user.id).eq("monitor_key", "event_trace").maybeSingle(),
      ]);
      if (module.error || personal.error) return json({ error: "access_check_failed" }, 503);
      if (!module.data?.enabled || !personal.data?.enabled) return json({ error: "access_denied" }, 403);
    }

    let data;
    try {
      const raw = await request.text();
      if (raw.length > 4096) return json({ error: "invalid_input" }, 400);
      data = JSON.parse(raw);
    } catch { return json({ error: "invalid_json" }, 400); }

    if (data?.action === "health" && profile.is_admin) return json({
      tavily: Boolean(Deno.env.get("TAVILY_API_KEY") || Deno.env.get("EVENT_TAVILY_API_KEY")),
      brightData: Boolean(Deno.env.get("BRIGHT_DATA_API_KEY") || Deno.env.get("EVENT_BRIGHT_DATA_API_KEY")),
      newscatcher: newscatcherConfigured(),
      cloudflare: cloudflareConfigured(),
    });

    const readRun = async (id?: string) => {
      let select = admin.from(table).select(columns).eq("owner_id", user.id);
      if (id) select = select.eq("id", id);
      const { data: run, error } = await select.order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) return json({ error: "read_failed" }, 503);
      if (!run || run.options?.cleared === true) return json({ run: null }, id ? 404 : 200);
      if (run.status === "running" && Date.now() - Date.parse(run.created_at) > 115_000) {
        const result = run.result ? { ...run.result, warnings: [...new Set([...(run.result.warnings ?? []), "deadline"])] } : null;
        const status = run.result ? "partial" : "failed";
        const { data: expired, error: expiryError } = await admin.from(table)
          .update({ status, stage: "done", result, updated_at: new Date().toISOString() })
          .eq("owner_id", user.id).eq("id", run.id).eq("status", "running").select(columns).maybeSingle();
        if (expiryError) return json({ error: "read_failed" }, 503);
        if (expired) return json({ run: expired });
        const { data: current, error: currentError } = await admin.from(table).select(columns)
          .eq("owner_id", user.id).eq("id", run.id).maybeSingle();
        return currentError ? json({ error: "read_failed" }, 503)
          : json({ run: current?.options?.cleared === true ? null : current });
      }
      return json({ run });
    };

    if (data?.action === "latest") return await readRun();
    if (data?.action === "status") return typeof data.id === "string" && uuid.test(data.id)
      ? await readRun(data.id) : json({ error: "invalid_input" }, 400);
    if (data?.action === "clear") {
      if (typeof data.id !== "string" || !uuid.test(data.id)) return json({ error: "invalid_input" }, 400);
      // Keep the latest run's identity so earlier runs do not reappear and a retry cannot start it again.
      const { data: cleared, error } = await admin.from(table)
        .update({ task: " ", result: null, options: { cleared: true }, updated_at: new Date().toISOString() })
        .eq("owner_id", user.id).eq("id", data.id).in("status", ["complete", "partial", "failed"])
        .select("id").maybeSingle();
      if (error) return json({ error: "clear_failed" }, 503);
      return cleared ? json({ run: null }) : json({ error: "clear_unavailable" }, 409);
    }
    if (data?.action !== "start" || typeof data.id !== "string" || !uuid.test(data.id) || typeof data.task !== "string")
      return json({ error: "invalid_input" }, 400);

    const task = data.task.trim();
    if (data.from == null || data.from === "") return json({ error: "date_required" }, 400);
    const window = eventPublicationWindow(data.from, data.through);
    if (!task || [...task].length > TASK_LIMIT || !window) return json({ error: "invalid_input" }, 400);
    const payload: TraceInput = { task, window, locale: data.locale === "be" ? "be" : "ru" };
    const { data: run, error: insertError } = await admin.from(table)
      .insert({ id: data.id, owner_id: user.id, task, options: payload.window, status: "running", stage: "search" })
      .select(columns).single();
    if (insertError?.code === "23505") return await readRun(data.id);
    if (insertError || !run) return json({ error: "start_failed" }, 503);

    const write = async (update: Record<string, unknown>) => {
      const { error } = await admin.from(table).update({ ...update, updated_at: new Date().toISOString() })
        .eq("owner_id", user.id).eq("id", run.id).eq("status", "running");
      if (error) throw new Error("event_checkpoint_failed");
    };
    EdgeRuntime.waitUntil((async () => {
      let checkpointResult: unknown = null;
      let newsRequested = false;
      const accounting: NewsAccounting = {
        reserve: async (page) => {
          const { data: id, error } = await admin.rpc("l_news_reserve_call", {
            p_run: null, p_job: null, p_provider: "newscatcher", p_endpoint: "event_articles",
            p_page: page, p_run_limit: newsPageLimit, p_month_limit: 1800,
          });
          if (error) throw new Error("newscatcher_accounting_failed");
          if (id !== null) newsRequested = true;
          return id;
        },
        record: async (id, entry) => {
          const { error } = await admin.from("l_news_usage").update({ ...entry, details: { event_run_id: run.id } }).eq("id", id);
          if (error) throw new Error("newscatcher_accounting_failed");
        },
      };
      try {
        const result = await trace(payload, async (stage, result) => {
          await write({ stage, result });
          checkpointResult = result;
        }, undefined, accounting);
        const partial = !result.entries.length || result.warnings.some((warning) => warning !== "summary_unavailable");
        await write({ status: partial ? "partial" : "complete", stage: "done", result });
      } catch {
        await write({ status: checkpointResult ? "partial" : "failed", stage: "done" }).catch(() => {});
      } finally {
        if (newsRequested) {
          const { error } = await admin.from("l_news_jobs").upsert({
            kind: "probe", payload: { pages: [], skip_perigon: true }, dedupe_key: "event-newscatcher-quota:" + run.id,
          }, { onConflict: "dedupe_key", ignoreDuplicates: true });
          if (error) console.error("event_newscatcher_quota_enqueue_failed", error.code);
          else {
            const { error: wakeError } = await admin.rpc("l_news_wake");
            if (wakeError) console.error("event_newscatcher_quota_wake_failed", wakeError.code);
          }
        }
      }
    })());
    return json({ run }, 202);
  } catch {
    return json({ error: "event_unavailable" }, 503);
  }
});
