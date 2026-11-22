import { createCollectorHandler } from './handler.ts';
import type { Runtime } from './providers.ts';

const runId = '6c67bb2d-ac69-4209-9af2-8d0b32696b08';
const admin = { id: 'admin', is_admin: true, status: 'active' };
const operator = { id: 'operator', is_admin: false, status: 'active' };
const disabled = { id: 'disabled', is_admin: true, status: 'disabled' };

function fixture(hasMonitorAccess = true, monitorEnabled = true, catalog: Record<string,unknown>[] = [], usage: Record<string,unknown>[] = []) {
  const tables: Record<string, Record<string, unknown>[]> = {
    monitor_profiles: [admin, operator, disabled],
    monitor_access: [{ monitor_key: 'lukashenko', enabled: monitorEnabled }],
    user_monitor_access: [{ monitor_key: 'lukashenko', user_id: 'operator', enabled: hasMonitorAccess }],
    l_news_runs: [{
      id: runId, number: 1, revision: 7, to_at: '2026-11-20T12:07:00Z',
      settings: { lookback_hours: 26 }, status: 'completed', counters: {},
    }],
    l_news_run_items: [{ run_id: runId, item_id: 1, role: 'new' }],
    l_news_items: [{ id: 1, ready_run_id: runId, state: 'ready', card: { document_id: 'article-1' } }],
    l_news_sources: catalog,
    l_news_settings: [{ enabled: true, lookback_hours: 26 }],
    l_news_provider_state: [],
    l_news_usage: usage,
  };
  const db = {
    auth: {
      getUser(token: string) {
        const profile = [admin, operator, disabled].find(({ id }) => token === id);
        return Promise.resolve({ data: { user: profile && { id: profile.id } } });
      },
    },
    from(table: string) {
      let rows = tables[table];
      if (!rows) throw new Error('Unexpected table: ' + table);
      return {
        select() { return this; },
        order() { return this; },
        eq(name: string, value: unknown) { rows = rows.filter(row => row[name] === value); return this; },
        gte() { return this; },
        in(name: string, values: unknown[]) { rows = rows.filter(row => values.includes(row[name])); return this; },
        limit(count: number) { return Promise.resolve({ data: rows.slice(0, count) }); },
        range(from: number, to: number) { return Promise.resolve({ data: rows.slice(from, to + 1) }); },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null }); },
        single() { return this.maybeSingle(); },
        then(resolve: (result: { data: typeof rows }) => void) { resolve({ data: rows }); },
      };
    },
    async rpc(name: string, params?: Record<string, unknown>) {
      if (name === 'l_news_wake') return { data: null };
      if (name === 'l_news_enqueue_scoped_run' && params?.p_trigger === 'manual') {
        equal(params.p_countries, ['KG','EG']);
        return { data: runId };
      }
      throw new Error('Unexpected RPC: ' + name);
    },
  };
  return createCollectorHandler({ db, secret: () => '', perigonKey: '', newscatcherKey: '' });
}

Deno.test('Newscatcher status counts assistant, event and diagnostic charges separately', async () => {
  const now = new Date().toISOString();
  const rows = [
    { endpoint: 'articles', status: 200, credits: 5 },
    { endpoint: 'event_articles', status: 200, credits: '5' },
    { endpoint: 'event_articles', status: 429, credits: 0 },
    { endpoint: 'event_articles', status: 0, credits: null },
    { endpoint: 'event_pilot', status: 200, credits: 20 },
  ].map(row => ({ ...row, provider: 'newscatcher', created_at: now }));
  const response = await fixture(true, true, [], rows)(post('status', 'operator'));
  equal(response.status, 200);
  equal((await response.json()).newscatcher_usage, {
    days: 30, credits: 30, assistant: 5, event: 5, diagnostic: 20, unconfirmed: 1,
  });
});

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function post(action: string, token?: string, fields = {}) {
  return new Request('https://example.com/l-news-collector', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ action, ...fields }),
  });
}

Deno.test('Windows WebView preflight returns empty 204 before checking auth', async () => {
  const response = await fixture()(new Request('https://example.com/l-news-collector', {
    method: 'OPTIONS',
    headers: { origin: 'http://tauri.localhost', 'access-control-request-method': 'POST' },
  }));
  equal(response.status, 204);
  equal(response.headers.get('access-control-allow-origin'), '*');
  equal(await response.text(), '');
});

Deno.test('admin and enabled operator both receive the manifest and bundle', async () => {
  const handle = fixture();
  for (const role of ['admin', 'operator']) {
    const manifest = await handle(post('manifest', role));
    equal(manifest.status, 200);
    equal((await manifest.json()).runs[0].id, runId);
    const download = await handle(post('download', role, { run_id: runId }));
    equal(download.status, 200);
    const bundle = await download.json();
    equal(bundle.manifest.run.collector_run_id, runId);
    equal(bundle.publications, [{ document_id: 'article-1' }]);
    equal(bundle.revision, 7);
  }
});

Deno.test('operator grants are required and client traffic cannot write the shared index', async () => {
  const handle = fixture();
  equal((await handle(post('manifest'))).status, 401);
  equal((await handle(post('manifest', 'invalid-token'))).status, 401);
  equal((await handle(post('manifest', 'disabled'))).status, 403);
  equal((await fixture(false)(post('manifest', 'operator'))).status, 403);
  equal((await fixture(true, false)(post('manifest', 'operator'))).status, 403);
  for (const action of ['start', 'settings', 'quota', 'retry_failed']) {
    equal((await handle(post(action, 'operator'))).status, 403);
  }
  equal((await handle(post('settings', 'admin', { lookback_hours: 0 }))).status, 400);
  equal((await handle(post('register_known', 'admin', { rows: [] }))).status, 400);
});

Deno.test('status and package return catalog rows beyond 1,000 and allow a new country scope', async () => {
  const catalog = Array.from({ length: 1048 }, (_, i) => ({
    domain: `example${String(i).padStart(4,'0')}.com`,
    enabled: true,
    country: i < 1046 ? 'US' : i === 1046 ? 'EG' : 'KG',
    coverage: {},
  }));
  const handle = fixture(true, true, catalog);
  const status = await (await handle(post('status','admin'))).json();
  equal(status.sources.length, 1048);
  equal(status.sources.at(-1).country, 'KG');
  equal(status.country_names.KG, 'Кыргызстан');
  const bundle = await (await handle(post('download','admin',{ run_id: runId }))).json();
  equal(bundle.source_metrics.length, 1048);
  equal(bundle.source_metrics.at(-1).source_region, 'Кыргызстан');
  equal((await handle(post('start','admin',{ countries: ['KG','EG','KG'] }))).status, 200);
  equal((await handle(post('start','admin',{ countries: ['Kyrgyzstan'] }))).status, 400);
});
