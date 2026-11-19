# Independent L-Monitor API pilot

Server deployed and enabled in Supabase. Daily search: **15:07 Europe/Minsk**,
fixed **26-hour** publication window. Cron: `7 12 * * *` UTC. A minute tick
only wakes due queue work and does not start searches on an empty queue.

## Verified control-run results

- 101 provider observations; 64 Russian cards, including 55 publisher full texts
  and 9 shorter previews/metadata cards; 12 rejected unique candidates.
- Ready cards came from 23 catalog sources. Actual thematic index observations
  confirmed 27 sources, not all 750 candidates.
- GitHub index recovered from nested artifact ZIPs: 113 previously delivered
  URLs; 9 overlap with the pilot output. The desktop importer must reconcile
  these aliases so the same publication is counted once.
- Perigon: 2 collection requests; maximum 100 results/page on this account.
  The second diagnostic page increased requestsUsed by exactly one:
  pagination is billable per request. Three diagnostics + two collection
  requests = 5/150. Free /limits checks did not consume requests.
  Current reset reported 19 December 2026, 18:43 UTC. Provider content is
  truncated at about 200 characters; it is never labelled a full body.
- Newscatcher: new /news-api/articles endpoint, platform_free, eight source
  groups/pages, 5 credits/page = 40 credits. Balance checked: 9,960/10,000.
  Maximum page size 100, 100 sources/query, ten pages/query.
- At this workload, 30 daily runs imply approximately 60 Perigon requests and
  1,200 Newscatcher credits. These are projections from one control run.
  Hard caps: 4 Perigon search requests/day, 16 Newscatcher pages/run,
  10 Perigon requests reserved. Remaining quota is distributed over days
  before the provider's actual reset.
- GDELT returned invalid output and HTTP 429 on bounded retries. It was disabled
  for the pilot through gdelt_per_run=0. It can be re-enabled after its access
  path is verified. No other feed depends on its availability.
- Existing WebScraping.AI fallback is capped at four requests/run and 120/month;
  the control run needed none. AI translation logs contain token metadata.
  Dollar costs are not inferred from API credit balances.

## Catalog and publication policy

750 unique candidate domains in all 35 requested countries: 231 inherited
L-Monitor entries and 519 additions. Coverage starts unverified. No thematic
result does not mean that a source is blocked or absent from a provider index.
Source country is curated editorial origin, not hosting geography. Languages
are unrestricted within the allowed catalog.

Multilingual surname search + an additional role query, publication dates
validated against the frozen window, canonical aliases, persistent seen URLs,
bounded pagination. GDELT indexing time is never used as publication time.
A late body mention appears in the translated excerpt. Distinct outlets and
separate language-edition URLs remain distinct unless a publisher establishes
a canonical alias. The pilot does not erase different publications about one event.

Direct publisher HTML/JSON-LD, Readability and AMP recovery precede bounded
existing extraction fallback. Paywall previews and truncated provider snippets
retain explicit quality levels. Translation uses existing Gemini/Cloudflare
keys and validates Russian output and preservation of numbers. Extraction
persists before translation so retries reuse the fetched text.

## Server access and operations

`l-news-collector` implements status, manifest, download and register_known for
active users with L-Monitor access. Admins additionally have start, settings,
quota and retry_failed. Settings accept enabled and lookback_hours.

The public gateway validates the user's Supabase session, active profile and
monitor access itself. The worker validates a private Vault token and accepts
only its worker action. Tables/RPCs are service-role only. Network transport
tables/functions in schema net have anonymous/public access revoked.
No keys or credential-bearing URLs are stored in cards or usage logs.
Bounded worker leases, provider reservations and idempotent job keys persist
across function restarts.

Migrations here use the deployed database's exact migration versions and SQL.
`../../l_news_sources.json` contains the reviewable target catalog;
`../../l_news_sources_seed.sql` seeds it without resetting live coverage.

## Desktop integration status

**The desktop update is not released.** During integration the execution
environment became unavailable. Tested local changes remain in the working
checkout at /workspace/scratch/73a704708ee1/monitor-dashboard; their availability
must be verified when that environment returns. Do not claim that current
Monitor installers receive the new feed.

Prepared integration was tested locally: frontend build, backend Deno checks,
ten collector tests, four Rust/importer checks including both arrival orders.
The desktop files were not pushed before the outage. This branch contains
the deployed backend, catalog, migrations and collector CI checks.

Remaining release steps:
1. Recover the local changes or reconstruct them against current main.
2. Import JSON bundles through the common contract validator with
   collector=api_assistant, collector_run_id UUID and collector_number.
   Keep the GitHub run number namespace independent.
3. Persist URL and document-UID aliases. Preserve existing document identity,
   operator flags/exclusions and fuller body for both arrival orders.
4. Sync the API feed independently of GitHub failures, using manifest revisions.
   Register only already delivered GitHub URLs; never fetched-but-unreported URLs.
5. Keep the latest catalog per collector; do not replace scraper health metrics
   with API-only no-result statuses. Publication statistics must use unique items.
6. Release the prepared admin panel (start/pause/lookback/quotas/usage), and the
   five-minute download poll for L-Monitor operators. Polling does not start
   paid searches. Verify active/admin access and test a real downloaded bundle.
7. Re-run importer/frontend checks, merge, build the Windows installer and
   confirm receipt in the updated application. Coordinate the version number
   with other current Monitor work.

The existing M-Trouble GitHub scraper has not been modified.
