use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};

use crate::{db, importer};

const ARTIFACT_PREFIX: &str = "dashboard-bundle-social-";
const MONITOR_KEY: &str = "social_economic";

#[derive(Debug, Deserialize)]
struct ArtifactList {
    artifacts: Vec<GitHubArtifact>,
}

#[derive(Debug, Deserialize)]
struct GitHubArtifact {
    id: u64,
    name: String,
    expired: bool,
    archive_download_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    checked_artifacts: usize,
    latest_available_run: Option<i64>,
    imported_runs: Vec<i64>,
    skipped_dry_runs: Vec<i64>,
    already_present: usize,
    errors: Vec<String>,
}

fn validate_repository(value: &str) -> Result<&str, String> {
    let trimmed = value.trim().trim_matches('/');
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
        return Err("Репозиторий должен быть указан как owner/repository.".to_string());
    }
    let valid = |part: &str| {
        part.chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    };
    if !valid(parts[0]) || !valid(parts[1]) {
        return Err("Имя репозитория содержит недопустимые символы.".to_string());
    }
    Ok(trimmed)
}

fn artifact_run_number(name: &str) -> Option<i64> {
    name.strip_prefix(ARTIFACT_PREFIX)?.parse::<i64>().ok()
}

pub fn sync_github(db_path: &Path, repository: &str, token: &str) -> Result<SyncResult, String> {
    let repository = validate_repository(repository)?;
    let client = Client::builder()
        .user_agent("Monitor-Dashboard/0.4.1")
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Не удалось создать GitHub client: {e}"))?;

    let mut artifacts: Vec<(i64, GitHubArtifact)> = Vec::new();
    for page in 1..=10 {
        let url = format!(
            "https://api.github.com/repos/{repository}/actions/artifacts?per_page=100&page={page}"
        );
        let mut request = client
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if !token.trim().is_empty() {
            request = request.bearer_auth(token.trim());
        }
        let response = request
            .send()
            .map_err(|e| format!("Не удалось обратиться к GitHub Actions API: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            let hint = if status.as_u16() == 401 || status.as_u16() == 403 || status.as_u16() == 404 {
                " Проверьте owner/repository и fine-grained token с read-only доступом к Actions."
            } else {
                ""
            };
            return Err(format!("GitHub API вернул {status}.{hint} {}", body.chars().take(240).collect::<String>()));
        }
        let page_payload: ArtifactList = response
            .json()
            .map_err(|e| format!("GitHub API вернул неожиданный JSON: {e}"))?;
        let page_len = page_payload.artifacts.len();
        for artifact in page_payload.artifacts {
            if artifact.expired {
                continue;
            }
            if let Some(run_number) = artifact_run_number(&artifact.name) {
                artifacts.push((run_number, artifact));
            }
        }
        if page_len < 100 {
            break;
        }
    }

    artifacts.sort_by_key(|(run, _)| *run);
    artifacts.dedup_by_key(|(run, _)| *run);
    let checked_artifacts = artifacts.len();

    let existing_runs: HashSet<i64> = db::list_runs(db_path)?
        .into_iter()
        .filter(|run| run.monitor_key == MONITOR_KEY)
        .filter_map(|run| run.run_number)
        .collect();
    let known_dry_runs = db::sync_skipped_run_numbers(db_path, MONITOR_KEY)?;

    let mut imported_runs = Vec::new();
    let mut skipped_dry_runs = Vec::new();
    let mut already_present = 0usize;
    let mut errors = Vec::new();

    for (run_number, artifact) in artifacts {
        if existing_runs.contains(&run_number) {
            already_present += 1;
            continue;
        }
        if known_dry_runs.contains(&run_number) {
            skipped_dry_runs.push(run_number);
            continue;
        }

        let mut request = client
            .get(&artifact.archive_download_url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if !token.trim().is_empty() {
            request = request.bearer_auth(token.trim());
        }
        let response = match request.send() {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("run {run_number}: download error: {error}"));
                continue;
            }
        };
        if !response.status().is_success() {
            errors.push(format!("run {run_number}: GitHub download returned {}", response.status()));
            continue;
        }
        let bytes = match response.bytes() {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("run {run_number}: cannot read artifact: {error}"));
                continue;
            }
        };

        let temp_path = std::env::temp_dir().join(format!(
            "monitor-dashboard-artifact-{}-{}.zip",
            artifact.id, run_number
        ));
        if let Err(error) = fs::write(&temp_path, &bytes) {
            errors.push(format!("run {run_number}: cannot write temporary ZIP: {error}"));
            continue;
        }

        let inspection = importer::inspect_bundle(&temp_path);
        let outcome = match inspection {
            Ok(meta) => {
                if meta.monitor_key != MONITOR_KEY {
                    Err(format!("unexpected monitor_key={}", meta.monitor_key))
                } else if meta.run_number.is_some() && meta.run_number != Some(run_number) {
                    Err(format!("artifact name says run {run_number}, bundle says run {:?}", meta.run_number))
                } else if meta.dry_run == Some(true) {
                    db::mark_sync_dry_run(db_path, MONITOR_KEY, run_number, artifact.id)?;
                    skipped_dry_runs.push(run_number);
                    Ok(None)
                } else {
                    importer::import_bundle(db_path, &temp_path).map(Some)
                }
            }
            Err(error) => Err(error),
        };

        let _ = fs::remove_file(&temp_path);
        match outcome {
            Ok(Some(result)) => {
                if result.status == "imported" || result.status == "replaced" {
                    imported_runs.push(run_number);
                } else {
                    already_present += 1;
                }
            }
            Ok(None) => {}
            Err(error) => errors.push(format!("run {run_number}: {error}")),
        }
    }

    let latest_available_run = db::list_runs(db_path)?
        .into_iter()
        .filter(|run| run.monitor_key == MONITOR_KEY && run.dry_run != Some(true))
        .filter_map(|run| run.run_number)
        .max();

    Ok(SyncResult {
        checked_artifacts,
        latest_available_run,
        imported_runs,
        skipped_dry_runs,
        already_present,
        errors,
    })
}
