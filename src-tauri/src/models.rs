use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub dashboard_contract_version: String,
    pub monitor: MonitorDescriptor,
    pub run: RunDescriptor,
    pub files: BundleFiles,
    #[allow(dead_code)]
    pub capabilities: Value,
}

#[derive(Debug, Deserialize)]
pub struct MonitorDescriptor {
    pub key: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
pub struct RunDescriptor {
    pub run_number: Option<i64>,
    pub github_run_id: Option<String>,
    pub github_sha: Option<String>,
    pub started_at: Option<String>,
    pub lookback_hours: Option<i64>,
    pub dry_run: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct BundleFiles {
    pub publications: String,
    pub source_metrics: String,
    pub run_metrics: String,
    pub entities: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PublicationRecord {
    pub schema_version: String,
    pub monitor_key: String,
    pub document_id: String,
    pub monitor_item_id: String,
    pub source: PublicationSource,
    pub publication: PublicationData,
    pub classification: ClassificationData,
    pub event: EventData,
    pub provenance: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PublicationSource {
    pub name: String,
    #[serde(rename = "type")]
    pub source_type: Option<String>,
    pub priority: Option<String>,
    pub language: Option<String>,
    pub configured_region: Option<String>,
    pub configured_locality: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PublicationData {
    pub published_at: Option<String>,
    pub title: String,
    #[serde(default)]
    pub title_generated: bool,
    pub excerpt: Option<String>,
    pub url: String,
    pub normalized_url: String,
    pub text_length: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ClassificationData {
    pub category: Option<String>,
    pub subcategory: Option<String>,
    pub signal_type: Option<String>,
    pub official_response: Option<bool>,
    pub score: Option<f64>,
    pub matched_terms: Option<Value>,
    pub category_bonus_only: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EventData {
    pub region: Option<String>,
    pub locality: Option<String>,
    pub geo_status: Option<String>,
    pub geo_confidence: Option<f64>,
    pub object: Option<String>,
    pub problem: Option<String>,
    pub signature: Option<String>,
    pub echo: Option<Value>,
    pub echo_anchor: Option<Value>,
    pub echo_sources: Option<Value>,
    pub also_covered_by: Option<Value>,
    pub also_covered_urls: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub status: String,
    pub run_id: i64,
    pub monitor_key: String,
    pub run_number: Option<i64>,
    pub dry_run: Option<bool>,
    pub contract_version: String,
    pub publications: i64,
    pub sources_in_result: i64,
    pub sources_in_coverage: i64,
    pub bundle_sha256: String,
    pub input_kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: i64,
    pub monitor_key: String,
    pub monitor_name: String,
    pub run_number: Option<i64>,
    pub external_run_id: Option<String>,
    pub started_at: Option<String>,
    pub lookback_hours: Option<i64>,
    pub dry_run: Option<bool>,
    pub contract_version: String,
    pub imported_at: String,
    pub publications: i64,
    pub sources_in_result: i64,
    pub sources_in_coverage: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    pub database_path: String,
    pub database_size_bytes: u64,
    pub schema_version: i64,
    pub monitors: i64,
    pub runs: i64,
    pub documents: i64,
    pub sources: i64,
    pub monitor_items: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountPoint {
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationSummary {
    pub id: i64,
    pub title: String,
    pub url: String,
    pub published_at: Option<String>,
    pub source: String,
    pub category: Option<String>,
    pub subcategory: Option<String>,
    pub region: Option<String>,
    pub locality: Option<String>,
    pub event_object: Option<String>,
    pub event_problem: Option<String>,
    pub excerpt: Option<String>,
    pub score: Option<f64>,
    pub official_response: Option<bool>,
    pub seen_in_runs: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardOverview {
    pub period_days: Option<i64>,
    pub publications: i64,
    pub active_sources: i64,
    pub regions: i64,
    pub categories: i64,
    pub official_responses: i64,
    pub trend: Vec<CountPoint>,
    pub category_breakdown: Vec<CountPoint>,
    pub source_breakdown: Vec<CountPoint>,
    pub region_breakdown: Vec<CountPoint>,
    pub recent: Vec<PublicationSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePage {
    pub total: i64,
    pub items: Vec<PublicationSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveFacets {
    pub categories: Vec<String>,
    pub regions: Vec<String>,
    pub sources: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    pub id: i64,
    pub name: String,
    pub domain: Option<String>,
    pub source_type: Option<String>,
    pub region: Option<String>,
    pub locality: Option<String>,
    pub priority: Option<String>,
    pub publications: i64,
    pub total_results: i64,
    pub last_seen_at: Option<String>,
    pub access_status: Option<String>,
    pub admission_status: Option<String>,
}
