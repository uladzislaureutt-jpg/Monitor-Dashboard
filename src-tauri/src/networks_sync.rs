//! Secure metadata-only TikTok bundle receiver. GitHub token remains server-side.
//! Reads a GitHub artifact ZIP containing a monitor ZIP containing networks.v1 JSONL.

use std::collections::HashSet;
use std::io::{Cursor, Read};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use base64::Engine as _;

const OUTER_LIMIT: usize = 20 * 1024 * 1024;
const INNER_LIMIT: usize = 16 * 1024 * 1024;
const MAX_DOWNLOADS: usize = 12;

#[derive(Deserialize)]
struct Listed { artifacts: Vec<Artifact>, latest_remote_run: Option<i64> }
#[derive(Deserialize)]
struct Artifact { id: u64, name: String, run_number: i64 }
#[derive(Deserialize)]
struct Download { artifact_id: u64, run_number: i64, zip_base64: String }
#[derive(Deserialize)]
struct BundleManifest {
    schema_version: String, monitor_key: String, run_number: i64,
    dry_run: bool, completed: bool, card_count: usize, sha256: String,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct TikTokRun { run_number: i64, cards_jsonl: String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct TikTokSyncResponse {
    bundles: Vec<TikTokRun>,
    latest_remote_run: Option<i64>,
    checked_artifacts: usize,
    already_present: usize,
    errors: Vec<String>,
}
fn json_post<T: for<'a> Deserialize<'a>>(
    client: &reqwest::blocking::Client,
    base_url: &str, anon_key: &str, access_token: &str,
    body: serde_json::Value,
) -> Result<T, String> {
    let response = client
        .post(format!("{base_url}/functions/v1/monitor-sync"))
        .header("apikey", anon_key)
        .bearer_auth(access_token)
        .json(&body).send()
        .map_err(|e| format!("TIKTOK_SYNC_NETWORK: {e}"))?;
    let status = response.status();
    let text = response.text().map_err(|e| format!("TIKTOK_SYNC_RESPONSE: {e}"))?;
    if !status.is_success() {
        return Err(format!("TIKTOK_SYNC_HTTP_{}: {}", status.as_u16(), text.chars().take(700).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| format!("TIKTOK_SYNC_JSON: {e}"))
}

fn read_entry<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>, target: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut entry = archive.by_name(target).map_err(|_| format!("ZIP_ENTRY_MISSING:{target}"))?;
    if entry.is_dir() || entry.size() > limit as u64 {
        return Err(format!("ZIP_ENTRY_TOO_LARGE:{target}"));
    }
    let mut output = Vec::new();
    (&mut entry).take(limit as u64 + 1).read_to_end(&mut output)
        .map_err(|e| format!("ZIP_READ_FAILED:{e}"))?;
    if output.len() > limit { return Err("ZIP_EXPANSION_LIMIT".into()); }
    Ok(output)
}

fn parse_bundle(outer_zip: &[u8], run_number: i64) -> Result<String, String> {
    if outer_zip.len() > OUTER_LIMIT { return Err("OUTER_ZIP_TOO_LARGE".into()); }
    let mut outer = zip::ZipArchive::new(Cursor::new(outer_zip))
        .map_err(|e| format!("GITHUB_ZIP_INVALID:{e}"))?;
    let expected = format!("dashboard-bundle-tiktok-{run_number}.zip");
    let mut match_index = None;
    for index in 0..outer.len() {
        let name = outer.by_index(index).map_err(|e| e.to_string())?.name()
            .map_err(|e| e.to_string())?.to_string();
        if name == expected || name.rsplit('/').next() == Some(expected.as_str()) {
            if match_index.is_some() { return Err("DUPLICATE_BUNDLE_IN_ARTIFACT".into()); }
            match_index = Some(index);
        }
    }
    let index = match_index.ok_or("MONITOR_BUNDLE_MISSING")?;
    let inner_bytes = {
        let mut entry = outer.by_index(index).map_err(|e| e.to_string())?;
        if entry.size() > OUTER_LIMIT as u64 { return Err("INNER_ZIP_TOO_LARGE".into()); }
        let mut content = Vec::new();
        (&mut entry).take(OUTER_LIMIT as u64 + 1).read_to_end(&mut content)
            .map_err(|e| e.to_string())?;
        if content.len() > OUTER_LIMIT { return Err("INNER_ZIP_TOO_LARGE".into()); }
        content
    };
    let mut archive = zip::ZipArchive::new(Cursor::new(inner_bytes))
        .map_err(|e| format!("MONITOR_ZIP_INVALID:{e}"))?;
    let meta_bytes = read_entry(&mut archive, "monitor_bundle_manifest.json", 32_768)?;
    let meta: BundleManifest = serde_json::from_slice(&meta_bytes)
        .map_err(|e| format!("INVALID_MONITOR_MANIFEST:{e}"))?;
    if meta.schema_version != "monitor-networks-bundle.v1" || meta.monitor_key != "tiktok"
        || meta.run_number != run_number || meta.dry_run || !meta.completed
        || meta.card_count > 20_000 {
        return Err("MONITOR_MANIFEST_INCONSISTENT".into());
    }
    let jsonl_bytes = read_entry(&mut archive, "networks_cards.jsonl", INNER_LIMIT)?;
    let sha = hex::encode(Sha256::digest(&jsonl_bytes));
    if sha != meta.sha256 { return Err("TIKTOK_CARDS_CHECKSUM_MISMATCH".into()); }
    let jsonl = String::from_utf8(jsonl_bytes).map_err(|e| format!("INVALID_UTF8:{e}"))?;
    if jsonl.lines().filter(|s| !s.trim().is_empty()).count() != meta.card_count {
        return Err("TIKTOK_CARD_COUNT_MISMATCH".into());
    }
    Ok(jsonl)
}

pub fn fetch(
    base_url: String, anon_key: String, access_token: String,
    known_runs: Vec<i64>,
) -> Result<TikTokSyncResponse, String> {
    let parsed = reqwest::Url::parse(base_url.trim()).map_err(|e| format!("INVALID_SUPABASE_URL:{e}"))?;
    if parsed.scheme() != "https" || !parsed.host_str().unwrap_or("").ends_with(".supabase.co") {
        return Err("INVALID_SUPABASE_HOST".into());
    }
    if anon_key.trim().is_empty() || access_token.trim().is_empty() {
        return Err("SUPABASE_SESSION_REQUIRED".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(100))
        .user_agent("Monitor-Networks-Sync/1.0")
        .build().map_err(|e| e.to_string())?;
    let base = base_url.trim().trim_end_matches('/');
    let list: Listed = json_post(&client, base, &anon_key, &access_token,
        serde_json::json!({"action":"list","monitor_key":"tiktok","app_version":env!("CARGO_PKG_VERSION")}))?;
    let checked_artifacts = list.artifacts.len();
    let mut discovered = list.artifacts.into_iter()
        .filter(|a| a.run_number > 0 && a.name == format!("dashboard-bundle-tiktok-{}", a.run_number))
        .collect::<Vec<_>>();
    discovered.sort_by_key(|a| a.run_number);
    discovered.dedup_by_key(|a| a.run_number);
    let known = known_runs.into_iter().collect::<HashSet<_>>();
    let already_present = discovered.iter().filter(|a| known.contains(&a.run_number)).count();
    let mut bundles = Vec::new();
    let mut errors = Vec::new();
    for artifact in discovered.into_iter().filter(|a| !known.contains(&a.run_number)).take(MAX_DOWNLOADS) {
        let download: Download = match json_post(&client, base, &anon_key, &access_token,
            serde_json::json!({"action":"download","monitor_key":"tiktok",
                "artifact_id":artifact.id,"app_version":env!("CARGO_PKG_VERSION")}))
        { Ok(v) => v, Err(e) => { errors.push(format!("run {}: {e}",artifact.run_number)); continue; } };
        if download.artifact_id != artifact.id || download.run_number != artifact.run_number {
            errors.push(format!("run {}: WRONG_ARTIFACT_METADATA",artifact.run_number));
            continue;
        }
        let bytes = match base64::engine::general_purpose::STANDARD.decode(download.zip_base64.as_bytes()) {
            Ok(bytes) if bytes.len() <= OUTER_LIMIT => bytes,
            _ => { errors.push(format!("run {}: INVALID_ZIP_BASE64",artifact.run_number)); continue; }
        };
        match parse_bundle(&bytes, artifact.run_number) {
            Ok(cards_jsonl) => bundles.push(TikTokRun { run_number:artifact.run_number,cards_jsonl }),
            Err(e) => errors.push(format!("run {}: {e}",artifact.run_number)),
        }
    }
    Ok(TikTokSyncResponse {
        bundles, latest_remote_run:list.latest_remote_run,
        checked_artifacts, already_present, errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_pair(run: i64) -> Vec<u8> {
        let cards = b"";
        let manifest = serde_json::json!({
            "schema_version":"monitor-networks-bundle.v1", "monitor_key":"tiktok",
            "run_number":run,"dry_run":false,"completed":true,"card_count":0,
            "sha256":hex::encode(Sha256::digest(cards))
        });
        let inner_cursor = Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(inner_cursor);
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("monitor_bundle_manifest.json", opts).unwrap();
        w.write_all(manifest.to_string().as_bytes()).unwrap();
        w.start_file("networks_cards.jsonl", opts).unwrap();
        w.write_all(cards).unwrap();
        let inner = w.finish().unwrap().into_inner();
        let mut outer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        outer.start_file(format!("dashboard-bundle-tiktok-{run}.zip"), opts).unwrap();
        outer.write_all(&inner).unwrap();
        outer.finish().unwrap().into_inner()
    }

    #[test]
    fn reads_nested_artifact_and_checks_run() {
        let z=zip_pair(27);
        assert_eq!(parse_bundle(&z,27).unwrap(),"");
        assert!(parse_bundle(&z,28).is_err());
    }
}
