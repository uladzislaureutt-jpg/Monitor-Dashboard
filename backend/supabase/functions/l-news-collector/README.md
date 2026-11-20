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

`l-news-collector` implements status, manifest and download for
active users with L-Monitor access. Admins additionally have start, settings,
quota and retry_failed. Settings accept enabled and lookback_hours.

The public gateway validates the user's Supabase session, active profile and
monitor access itself. The worker validates a private Vault token and accepts
only its worker action. Tables/RPCs are service-role only. Network transport
tables/functions in schema net have anonymous/public access revoked.
The shared seen-URL index is built on the server from GitHub artifacts and collector records. Desktop clients reconcile imported publications locally.
No keys or credential-bearing URLs are stored in cards or usage logs.
Bounded worker leases, provider reservations and idempotent job keys persist
across function restarts.

Migrations here use the deployed database's exact migration versions and SQL.
`../../l_news_sources.json` contains the reviewable target catalog;
`../../l_news_sources_seed.sql` seeds it without resetting live coverage.

## Desktop integration status

The importer, publication aliases, independent feed sync and admin panel
were recovered from the prior checkout and saved on this branch. API bundles
use a UUID and their own run-number namespace. The importer keeps existing
publication identity, operator decisions and full text in both arrival orders.
The desktop checks for already collected cards every five minutes while
L-Monitor is open. This polling does not initiate paid searches.

Before release, verify an authenticated manifest/download against a real
pilot bundle, confirm that it appears in the updated desktop application,
and check both admin and operator access. Coordinate the release version
with the other open Monitor changes, then build and validate the Windows
installer.

The existing M-Trouble GitHub scraper has not been modified.
