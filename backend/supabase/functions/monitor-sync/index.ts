import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { filterLMonitorBundle } from "./l-monitor-bundle.ts";
import {
  FALLBACK_BUCKET, FALLBACK_MAX_BYTES, FALLBACK_ID_BASE, fallbackArtifactId,
  fallbackRunFromId, fallbackPath, isValidFallbackName,
  decodeFallbackZipBase64, validateFallbackZip, sha256Hex,
} from "./bundle-fallback.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

// 0.9.0 is the first versioned Windows build that imports the Assistant feed.
const firstAssistantVersion = "0.9.0";

const monitors: Record<string, { repo: string; prefix: string; secret: string }> = {
  social_economic: {
    repo: "uladzislaureutt-jpg/SE-monitor",
    prefix: "dashboard-bundle-social-",
    secret: "GITHUB_SE_MONITOR_TOKEN",
  },
  lukashenko: {
    repo: "vladreuth-cmd/M-Trouble",
    prefix: "dashboard-bundle-l-monitor-",
    secret: "GITHUB_L_MONITOR_TOKEN",
  },
  tiktok: {
    repo: "vlreuth-ctrl/TikTok-Monitor",
    prefix: "dashboard-bundle-tiktok-",
    secret: "GITHUB_TIKTOK_MONITOR_TOKEN",
  },
};

function versionAtLeast(current: string, minimum: string) {
  const parse = (value: string) => value.split(".").map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  const a = parse(current), b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i += 1) {
    const left = a[i] || 0, right = b[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

async function enforceVersion(admin: any, appVersion: string) {
  const { data, error } = await admin.from("monitor_runtime_config")
    .select("minimum_allowed_version,latest_version,update_mode")
    .eq("id", true)
    .maybeSingle();
  if (error) return { ok: false, response: json({ error: "VERSION_CHECK_FAILED" }, 503) } as const;
  const minimumSupported = String(data?.minimum_allowed_version || "0.0.0");
  const latest = String(data?.latest_version || minimumSupported);
  const updateMode = data?.update_mode === "required" ? "required" : "optional";
  const effectiveMinimum = updateMode === "required" ? latest : minimumSupported;
  if (!versionAtLeast(appVersion, effectiveMinimum)) {
    return { ok: false, response: json({
      error: "APP_UPDATE_REQUIRED",
      minimum_supported_version: minimumSupported,
      latest_version: latest,
      update_mode: updateMode,
      effective_minimum_version: effectiveMinimum,
    }, 426) } as const;
  }
  return { ok: true, minimumSupported, latest, updateMode, effectiveMinimum } as const;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Monitor-Workroom-Sync/1.0",
  };
}

function parseRun(name: string, prefix: string) {
  if (!name.startsWith(prefix)) return null;
  const run = Number(name.slice(prefix.length));
  return Number.isSafeInteger(run) && run > 0 ? run : null;
}

function bytesToBase64(bytes: Uint8Array) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return json({ error: "UNAUTHORIZED" }, 401);

  const { data: profile, error: profileError } = await admin
    .from("monitor_profiles")
    .select("id,status,is_admin")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError || !profile || profile.status !== "active") {
    return json({ error: "PROFILE_NOT_ACTIVE" }, 403);
  }

  const payload = await req.json().catch(() => ({}));
  const appVersion = String(payload?.app_version || "0.8.11");
  const versionCheck = await enforceVersion(admin, appVersion);
  if (!versionCheck.ok) return versionCheck.response;
  const monitorKey = String(payload?.monitor_key ?? "");
  const cfg = monitors[monitorKey];
  if (!cfg) return json({ error: "INVALID_MONITOR" }, 400);
  // TikTok-Monitor / Сети is administrator-only until the operator role is released.
  if (monitorKey === "tiktok" && !profile.is_admin) return json({ error: "MONITOR_ACCESS_DENIED" }, 403);

  if (!profile.is_admin) {
    const [{ data: globalAccess, error: globalError }, { data: personalAccess, error: personalError }] = await Promise.all([
      admin.from("monitor_access").select("enabled").eq("monitor_key", monitorKey).maybeSingle(),
      admin.from("user_monitor_access").select("enabled").eq("user_id", userData.user.id).eq("monitor_key", monitorKey).maybeSingle(),
    ]);
    if (globalError || personalError) return json({ error: "MONITOR_ACCESS_CHECK_FAILED" }, 503);
    if (!globalAccess?.enabled || !personalAccess?.enabled) return json({ error: "MONITOR_ACCESS_DENIED", monitor_key: monitorKey }, 403);
  }

  const token = Deno.env.get(cfg.secret) ?? "";
  const action = String(payload?.action ?? "list");

  // An administrator can publish an already-built production ZIP when
  // GitHub Actions billing blocks the usual dashboard export. The bucket
  // remains private: only this authenticated Edge Function uses service-role.
  if (action === "publish") {
    if (!profile.is_admin || monitorKey !== "social_economic") {
      return json({ error: "PUBLISH_FORBIDDEN" }, 403);
    }
    let bytes: Uint8Array;
    let checked: { run: number; publications: number };
    try {
      bytes = decodeFallbackZipBase64(payload?.zip_base64);
      checked = validateFallbackZip(bytes, monitorKey);
    } catch (error) {
      return json({ error: "INVALID_PUBLISHED_BUNDLE", detail: String(error) }, 400);
    }
    const run = checked.run;
    const expectedRun = Number(payload?.run_number ?? run);
    if (expectedRun !== run) return json({ error: "PUBLISH_RUN_MISMATCH" }, 400);
    const objectPath = fallbackPath(monitorKey, cfg.prefix, run);
    const digest = await sha256Hex(bytes);
    const bucket = admin.storage.from(FALLBACK_BUCKET);
    const { data: existing, error: existingError } = await bucket.download(objectPath);
    if (existing) {
      const existingBytes = new Uint8Array(await existing.arrayBuffer());
      return (await sha256Hex(existingBytes)) === digest
        ? json({ ok: true, status: "already_published", run_number: run, publications: checked.publications, sha256: digest })
        : json({ error: "RUN_ALREADY_PUBLISHED", run_number: run }, 409);
    }
    if (existingError && !["404", "NoSuchKey", "not_found"].includes(String((existingError as any).statusCode || "")) &&
        !/not found|does not exist|object not found/i.test(String(existingError.message || ""))) {
      return json({ error: "FALLBACK_STORAGE_UNAVAILABLE" }, 502);
    }
    const { error: uploadError } = await bucket.upload(objectPath, bytes, {
      contentType: "application/zip", upsert: false, cacheControl: "300",
    });
    if (uploadError) {
      const status = Number((uploadError as any).statusCode || 0);
      return json({ error: status === 409 ? "RUN_ALREADY_PUBLISHED" : "FALLBACK_UPLOAD_FAILED" },
        status === 409 ? 409 : 502);
    }
    return json({ ok: true, status: "published", run_number: run,
      publications: checked.publications, sha256: digest, size_in_bytes: bytes.byteLength });
  }

  if (action === "list") {
    const byRun = new Map<number, any>();
    let githubError = "";
    let storageError = "";
    if (token) {
      try {
        for (let page = 1; page <= 10; page += 1) {
          const response = await fetch(
            `https://api.github.com/repos/${cfg.repo}/actions/artifacts?per_page=100&page=${page}`,
            { headers: githubHeaders(token) },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          const pageArtifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
          for (const artifact of pageArtifacts) {
            if (artifact?.expired) continue;
            const run = parseRun(String(artifact?.name ?? ""), cfg.prefix);
            if (run == null) continue;
            const id = Number(artifact?.id ?? 0);
            if (!Number.isSafeInteger(id) || id <= 0 || id >= FALLBACK_ID_BASE) continue;
            const existing = byRun.get(run);
            if (!existing || (existing.origin === "github" && id > existing.id)) {
              byRun.set(run, {
                id, name: String(artifact.name), run_number: run,
                size_in_bytes: Number(artifact?.size_in_bytes ?? 0),
                origin: "github",
              });
            }
          }
          if (pageArtifacts.length < 100) break;
        }
      } catch (error) { githubError = String(error); }
    } else githubError = "GITHUB_SYNC_TOKEN_NOT_CONFIGURED";

    // The fallback is visible to all already-authorized Monitor users.
    // No Storage URL, signing key or raw object path is returned to clients.
    if (monitorKey === "social_economic") {
      const { data: stored, error } = await admin.storage.from(FALLBACK_BUCKET)
        .list(monitorKey, { limit: 1000, sortBy: { column: "name", order: "desc" } });
      if (error) storageError = String(error.message || "storage list failed");
      else for (const item of stored ?? []) {
        const run = isValidFallbackName(String(item.name || ""), cfg.prefix);
        if (run == null || byRun.has(run)) continue; // original GitHub bundle wins
        byRun.set(run, {
          id: fallbackArtifactId(run),
          name: cfg.prefix + run, run_number: run,
          size_in_bytes: Number(item.metadata?.size ?? 0),
          origin: "supabase",
        });
      }
    }

    if (!byRun.size && githubError) {
      return json({ error: "BUNDLE_LIST_UNAVAILABLE", github: githubError.slice(0, 160),
        storage: storageError.slice(0, 160) }, 502);
    }
    if (!byRun.size && storageError) return json({ error: "FALLBACK_LIST_FAILED" }, 502);
    const artifacts = [...byRun.values()].sort((a, b) => a.run_number - b.run_number);
    return json({ ok: true, monitor_key: monitorKey, artifacts,
      latest_remote_run: artifacts.length ? artifacts[artifacts.length - 1].run_number : null,
      github_degraded: Boolean(githubError), supabase_degraded: Boolean(storageError) });
  }

  if (action === "download") {
    const artifactId = Number(payload?.artifact_id ?? 0);
    if (!Number.isSafeInteger(artifactId) || artifactId <= 0) {
      return json({ error: "INVALID_ARTIFACT_ID" }, 400);
    }
    if (artifactId >= FALLBACK_ID_BASE) {
      const run = fallbackRunFromId(artifactId);
      if (monitorKey !== "social_economic" || run == null) {
        return json({ error: "INVALID_FALLBACK_ARTIFACT" }, 400);
      }
      const path = fallbackPath(monitorKey, cfg.prefix, run);
      const { data, error } = await admin.storage.from(FALLBACK_BUCKET).download(path);
      if (error || !data) return json({ error: "FALLBACK_DOWNLOAD_FAILED" }, 502);
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (bytes.byteLength > FALLBACK_MAX_BYTES) return json({ error: "ARTIFACT_TOO_LARGE" }, 413);
      try {
        const verified = validateFallbackZip(bytes, monitorKey);
        if (verified.run !== run) return json({ error: "FALLBACK_RUN_MISMATCH" }, 409);
      } catch {
        return json({ error: "FALLBACK_BUNDLE_INVALID" }, 502);
      }
      return json({ ok: true, monitor_key: monitorKey, artifact_id: artifactId,
        run_number: run, name: cfg.prefix + run,
        zip_base64: bytesToBase64(bytes), size_in_bytes: bytes.byteLength });
    }
    if (!token) return json({ error: "SYNC_TOKEN_NOT_CONFIGURED" }, 503);

    const metaResponse = await fetch(
      `https://api.github.com/repos/${cfg.repo}/actions/artifacts/${artifactId}`,
      { headers: githubHeaders(token) },
    );
    if (!metaResponse.ok) {
      const body = (await metaResponse.text()).slice(0, 400);
      return json({ error: "GITHUB_ARTIFACT_FAILED", status: metaResponse.status, detail: body }, 502);
    }
    const meta = await metaResponse.json();
    const run = parseRun(String(meta?.name ?? ""), cfg.prefix);
    if (run == null || meta?.expired) return json({ error: "ARTIFACT_NOT_ALLOWED" }, 403);

    const zipResponse = await fetch(
      `https://api.github.com/repos/${cfg.repo}/actions/artifacts/${artifactId}/zip`,
      { headers: githubHeaders(token), redirect: "follow" },
    );
    if (!zipResponse.ok) {
      const body = (await zipResponse.text()).slice(0, 400);
      return json({ error: "GITHUB_DOWNLOAD_FAILED", status: zipResponse.status, detail: body }, 502);
    }
    let bytes: Uint8Array = new Uint8Array(await zipResponse.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) return json({ error: "ARTIFACT_TOO_LARGE" }, 413);

    if (monitorKey === "lukashenko" && versionAtLeast(appVersion, firstAssistantVersion)) {
      try {
        const filtered = await filterLMonitorBundle(bytes, async (keys, asOf) => {
          const found = new Set<string>();
          for (let i = 0; i < keys.length; i += 30) {
            const batch = keys.slice(i, i + 30);
            const [aliases, canonical] = await Promise.all([
              admin.from("l_news_url_aliases")
                .select("alias,l_news_items!inner()")
                .in("alias", batch)
                .eq("l_news_items.state", "ready")
                .lte("l_news_items.ready_at", asOf)
                .not("l_news_items.card", "is", null),
              admin.from("l_news_items")
                .select("canonical_url")
                .in("canonical_url", batch)
                .eq("state", "ready")
                .lte("ready_at", asOf)
                .not("card", "is", null),
            ]);
            if (aliases.error || canonical.error) throw new Error(aliases.error?.message ?? canonical.error?.message);
            for (const row of aliases.data ?? []) found.add(row.alias);
            for (const row of canonical.data ?? []) found.add(row.canonical_url);
          }
          return found;
        });
        bytes = filtered.bytes;
      } catch (error) {
        console.error("L-Monitor dashboard deduplication failed", String(error));
        return json({ error: "L_MONITOR_DEDUP_FAILED" }, 502);
      }
    }

    return json({
      ok: true,
      monitor_key: monitorKey,
      artifact_id: artifactId,
      run_number: run,
      name: String(meta.name),
      zip_base64: bytesToBase64(bytes),
      size_in_bytes: bytes.length,
    });
  }

  return json({ error: "UNKNOWN_ACTION" }, 400);
});
