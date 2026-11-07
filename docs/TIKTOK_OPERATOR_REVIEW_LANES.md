# TikTok operator visibility — v2 contract

Three distinct output groups now travel in the same `networks_cards.jsonl`
bundle. These are unique TikTok IDs, not three copies of the discovery pool.

1. `operator_review_lane="main"`: operator published P1/P2/P3/G/S or displayed REVIEW with original verified date; these alone count in the main feed and trends.
2. `operator_review_lane="gemini_veto"`: model-positive proposals blocked by later verification gates; `included_in_current_overview=false`, `report_suppressed=true`. Never automatic KEEP or published. Card preserves model-proposed type and gate reason.
3. `operator_review_lane="triage"`: ranked near-misses, possible false REJECT, firsthand audio, media-pending, weak review and additional candidates; original category retained, no date fabricated. Catch-all `other_reject` is omitted to prevent the entire search pool reappearing.

The application provides a dedicated administrator-only **Сети → Очередь проверки**
page, separate searchable and filterable Gemini/triage blocks. Archive search
includes these metadata, while the dynamics chart counts only `main` cards.

The existing Supabase administrator-only card table stores these as unverified
audit rows using the same `tiktok_upsert_cards` RPC. A later confirmed main
card outranks a review-only copy; deletion tombstones still win everywhere.
TikTok ID, source URL and run number are verified before admission.

Upgrading from 0.8.81 migrates previous GitHub import receipts to v2 and
refreshes the last four completed TikTok runs. Run #33 also receives a
provider-free reconstruction from its archived report/debug CSVs, so previous
Gemini-veto and triage entries become available without a new paid run.

Older `networks.v1` bundles without the new operator lane continue to import
as before. There is no promotion based solely on the model's proposal.
