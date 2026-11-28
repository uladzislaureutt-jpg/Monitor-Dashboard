import { createCollectorHandler } from './handler.ts';
import type { Runtime } from './providers.ts';

const runId = '6c67bb2d-ac69-4209-9af2-8d0b32696b08';
const admin = { id: 'admin', is_admin: true, status: 'active' };
const operator = { id: 'operator', is_admin: false, status: 'active' };
const disabled = { id: 'disabled', is_admin: true, status: 'disabled' };

function fixture(hasMonitorAccess = true, monitorEnabled = true, catalog: Record<string,unknown>[] = [], usage: Record<string,unknown>[] = [], runs?: Record<string,unknown>[]) {
  const tables: Record<string, Record<string, unknown>[]> = {
    monitor_profiles: [admin, operator, disabled],
    monitor_access: [{ monitor_key: 'lukashenko', enabled: monitorEnabled }],
    user_monitor_access: [{ monitor_key: 'lukashenko', user_id: 'operator', enabled: hasMonitorAccess }],
    l_news_runs: runs ?? [{
      id: runId, number: 1, assistant_id: 1, assistant_number: 1, revision: 7, to_at: '2026-11-20T12:07:00Z',
      settings: { lookback_hours: 26 }, status: 'completed', counters: {},
    }],
    l_news_run_items: [1, 2, 3].map(item_id => ({ run_id: runId, item_id, role: 'new' })),
    l_news_items: [
      { id: 1, ready_run_id: runId, state: 'ready', card: { document_id: 'article-1' } },
      { id: 2, ready_run_id: runId, state: 'rejected', document_uid: 'article-2', card: { document_id: 'article-2' } },
      { id: 3, ready_run_id: null, state: 'rejected', document_uid: 'article-3', card: null },
    ],
    l_news_sources: catalog,
    l_news_settings: [{ id:true, enabled: true, lookback_hours: 26, local_time:'15:07' }],
    l_news_jobs: [],
    l_news_assistant2_settings: [{ id:true, enabled: true, lookback_hours: 26, local_time: "03:07" }],
    l_news_newsdata_settings:[{id:true,enabled:true,lookback_hours:26,local_time:'12:17'}],
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
      let patch:Record<string,unknown>|undefined;
      if (!rows) throw new Error('Unexpected table: ' + table);
      return {
        select() { return this; },
        update(value:Record<string,unknown>) {patch=value;return this;},
        order() { return this; },
        eq(name: string, value: unknown) { rows = rows.filter(row => row[name] === value); return this; },
        gte() { return this; },
        in(name: string, values: unknown[]) { rows = rows.filter(row => values.includes(row[name])); return this; },
        limit(count: number) { return Promise.resolve({ data: rows.slice(0, count) }); },
        range(from: number, to: number) { return Promise.resolve({ data: rows.slice(from, to + 1) }); },
        maybeSingle() { return Promise.resolve({ data: rows[0] ?? null }); },
        single() { return this.maybeSingle(); },
        then(resolve: (result: { data: typeof rows }) => void) { if(patch)for(const row of rows)Object.assign(row,patch);resolve({ data: rows }); },
      };
    },
    async rpc(name: string, params?: Record<string, unknown>) {
      if (name === 'l_news_newsdata_usage')return {data:{newsdata:{today_units:0,period_units:0}}};
      if(name==='l_news_enqueue_newsdata_run'&&params?.p_trigger==='manual')return {data:'newsdata-run'};
      if (name === 'l_news_assistant2_usage') return {data:{}};
      if (name === 'l_news_enqueue_assistant2_run' && params?.p_trigger === 'manual') return {data:'assistant2-run'};
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
    equal(bundle.publications, [{ document_id: 'article-1', event: {} }]);
    equal(bundle.run_metrics.withdrawn_document_ids, ['article-2']);
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

Deno.test('five runs per assistant, independent settings, and old bundles default to helper 1', async () => {
 const rows = [1,2,3].flatMap(assistant_id => Array.from({length:8}, (_,i) => ({id:`${assistant_id}-${8-i}`,number:40-i,assistant_id,assistant_number:8-i,counters:{},warnings:[]})));
 const handle = fixture(true,true,[],[],rows);
 for (const id of [1,2,3]) {
  const response=await handle(post('status','operator',{assistant_id:id}));
  equal(response.status,200);const snapshot=await response.json();
  equal(snapshot.runs.length,5);equal(snapshot.runs.every((run:any)=>run.assistant_id===id),true);
  equal(snapshot.settings.local_time,id===3?'12:17':id===2?'03:07':'15:07');
 }
 const manifest=await (await handle(post('manifest','operator'))).json();equal(manifest.runs.length,24);
 equal((await fixture()(post('start','admin',{assistant_id:2,countries:['IT']}))).status,200);
 for(const action of ['start','settings','quota','cancel','retry_failed'])equal((await handle(post(action,'operator',{assistant_id:2}))).status,403);
 equal((await handle(post('status','admin',{assistant_id:4}))).status,400);
 const bundle=await (await fixture()(post('download','admin',{run_id:runId}))).json();
 equal(bundle.manifest.run.assistant_id,1);equal(bundle.manifest.run.collector_number,1);
});

Deno.test('diagnostics include async Cloro receipts and both comparison rounds',async()=>{
 const now=new Date().toISOString();const rows=[
  {provider:'cloro',endpoint:'assistant2_initial_20261126',billable:true,credits:25},
  {provider:'cloro',endpoint:'assistant2_recheck_20261126',billable:false,credits:18},
  ...Array.from({length:19},()=>({provider:'currents',endpoint:'assistant2_initial_20261126',billable:true,credits:0})),
  {provider:'currents',endpoint:'search',billable:true,credits:1},
 ].map(row=>({...row,created_at:now,status:200}));
 const result=await (await fixture(true,true,[],rows)(post('status','admin',{assistant_id:2}))).json();
 equal(result.diagnostic_usage,{days:30,cloro_credits:43,currents_requests:19,thenews_requests:0});
});

Deno.test('a scoped collection exports the whole active catalog with explicit unchecked status',async()=>{
 const catalog=[{domain:'uk.example',name:'UK',country:'GB',enabled:true},{domain:'cn.example',name:'CN',country:'CN',enabled:true}];
 const runs=[{id:runId,number:1,assistant_id:2,assistant_number:1,settings:{countries:['GB'],lookback_hours:26},counters:{}}];
 const handle=fixture(true,true,catalog,[],runs);
 const data=await (await handle(post('download','admin',{run_id:runId}))).json();
 equal(data.source_metrics.length,2);
 const china=data.source_metrics.find((row:any)=>row.domain==='cn.example');
 equal(china.access_status,'api_outside_run_scope');equal(china.admission_status,'not_in_run_scope');equal(china.included,0);
});

Deno.test('status exposes the same localized Cloro countries used by server validation',async()=>{
 const response=await fixture()(post('status','admin',{assistant_id:2}));const result=await response.json();
 equal(result.cloro_search.priority_countries,['US','DE','PL']);
 equal(result.cloro_search.default_countries,['US','DE','PL','FR','IT','UA','GB','ES','TR','LT','LV','EE']);
 equal(result.cloro_search.countries.includes('MM'),false);
 for(const code of ['LT','LV','EE','ES','TR','CZ','SK','HU','RO','BG','RS','KZ','KG','QA'])equal(result.cloro_search.countries.includes(code),true);
});

Deno.test('helper 1 saves its Minsk schedule independently and only for an admin',async()=>{
 const handle=fixture();
 equal((await handle(post('settings','operator',{assistant_id:1,local_time:'07:35'}))).status,403);
 equal((await handle(post('settings','admin',{assistant_id:1,local_time:'07:35'}))).status,200);
 const first=await (await handle(post('status','admin',{assistant_id:1}))).json();
 const second=await (await handle(post('status','admin',{assistant_id:2}))).json();
 equal(first.settings.local_time,'07:35');equal(first.settings.lookback_hours,26);equal(second.settings.local_time,'03:07');
 for(const time of ['00:00','23:59']){
  equal((await handle(post('settings','admin',{assistant_id:1,local_time:time}))).status,200);
  equal((await (await handle(post('status','admin',{assistant_id:1}))).json()).settings.local_time,time);
 }
});
Deno.test('helper 1 rejects invalid schedule times without changing its previous time',async()=>{
 const handle=fixture();
 for(const time of ['', '3:07', '24:00', '12:60', '12:07:00', null, 123, true]){
  const response=await handle(post('settings','admin',{assistant_id:1,local_time:time}));
  equal(response.status,400);equal((await response.json()).error,'invalid_local_time');
 }
 equal((await (await handle(post('status','admin',{assistant_id:1}))).json()).settings.local_time,'15:07');
});

Deno.test('NewsData manual control is independent, operator reads only and quota refresh is free',async()=>{const h=fixture();equal((await h(post('start','admin',{assistant_id:3}))).status,200);equal((await h(post('settings','operator',{assistant_id:3,enabled:false}))).status,403);equal((await h(post('settings','admin',{assistant_id:3,local_time:'12:17',newsdata_per_run:60}))).status,200);equal((await h(post('quota','admin',{assistant_id:3}))).status,200);const s=await(await h(post('status','operator',{assistant_id:3}))).json();equal(s.settings.local_time,'12:17');equal(s.settings.newsdata_per_run,60);});
