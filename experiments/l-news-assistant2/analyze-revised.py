from pathlib import Path
from urllib.parse import urlsplit,urlunsplit,parse_qsl,urlencode,unquote
from collections import defaultdict,Counter
from datetime import datetime,timezone,timedelta
from email.utils import parsedate_to_datetime
import json,re,hashlib,itertools,gzip

ROOT=Path(__file__).resolve().parent
RAW=json.loads(gzip.decompress((ROOT/'live-results-revised-20261126.json.gz').read_bytes()).decode('utf-8'))
BASE=json.loads((ROOT/'baseline-20261126.json').read_text())
NOWBASE=json.loads((ROOT/'baseline-current-revised-20261126.json').read_text())
DOMAINS=set(BASE['domains'])
OLDHASH={x[0] for x in BASE['items']}
FROM=datetime.fromisoformat('2026-11-24T12:00:00+00:00')
TO=datetime.fromisoformat('2026-11-26T03:30:00+00:00')
SIGNAL=re.compile(r'лукаш|lukash|loukach|lukaschen|łukasz|lukaš|lukaș|lukasenk',re.I)

def canonical(url):
    u=urlsplit(url)
    host=(u.hostname or '').lower().removeprefix('www.')
    if host=='amp.dw.com':host='dw.com'
    path=unquote(u.path).rstrip('/').lower()
    if host=='bbc.com':path=re.sub(r'\.amp$|/amp$','',path)
    query=[(k,v) for k,v in parse_qsl(u.query) if not re.match(r'^(utm_|at_|fbclid|gclid|mc_|ref$|source$)',k,re.I)]
    return urlunsplit(('https',host,path,urlencode(sorted(query)),''))
def oldhash(url):
    u=urlsplit(url)
    raw=(f'{u.scheme}://{u.netloc}'.lower()+u.path.rstrip('/').lower()).rstrip('/')
    return hashlib.md5(raw.encode()).hexdigest()
def registered(host):
    return host in DOMAINS or any(host.endswith('.'+d) for d in DOMAINS)
def date(raw):
    if not raw:return None
    raw=re.sub(r'T(\d):',r'T0\1:',str(raw)).replace('EET','+02:00')
    raw=re.sub(r' 7200$',r'+02:00',raw)
    try:return datetime.fromisoformat(raw.replace('Z','+00:00')).astimezone(timezone.utc)
    except ValueError:
        try:return parsedate_to_datetime(raw).astimezone(timezone.utc)
        except Exception:return None

KNOWN={canonical(x[0]):x[1] for x in NOWBASE['known']}
GITHUB={canonical(x) for x in NOWBASE['known_github']}
CHECKS={canonical(a['url']):a for a in RAW['publisher_checks']}
def primary_date(a):
    c=CHECKS.get(canonical(a['url']),{})
    dates=[date(x) for x in c.get('dates',[]) if len(x)>10]
    dates=[d for d in dates if d is not None]
    return dates[0] if c.get('status')==200 and dates else None
allrows=[];responses=[]
for r in RAW['responses']:
    responses.append(r)
    if r.get('usage_id')==1442:continue # Separate translated-field coverage control.
    for a in r.get('articles',[]):
        if not a.get('url'):continue
        a=a|{'provider':r['provider'],'query_language':r['language'],'query':r['query'],'usage_id':r['usage_id'],'page':r['page']}
        a['canonical']=canonical(a['url']);a['domain']=urlsplit(a['canonical']).hostname
        a['registered']=registered(a['domain']);a['old_known']=oldhash(a['url']) in OLDHASH
        a['current_known']=a['canonical'] in KNOWN or a['canonical'] in GITHUB
        a['known_state']=KNOWN.get(a['canonical'])
        a['name_in_title']=bool(SIGNAL.search(a.get('title','')))
        a['name_signal']=bool(SIGNAL.search(a.get('title','')+' '+a.get('description','')))
        source_date=primary_date(a)
        dt=source_date or date(a.get('published'))
        a['publisher_date_verified']=bool(source_date)
        a['published_utc']=dt.isoformat() if dt else None
        a['window_match']=bool(dt and FROM<=dt<=TO)
        a['freshness']='dated_in_window' if a['window_match'] else 'dated_outside_window' if dt else 'unverified'
        a['review']='candidate' if a['name_in_title'] else 'body_only' if a['name_signal'] else 'no_name_signal'
        a['editorial_exclusion']='aggregator' if a['domain'] in ['ukr.net','ground.news'] else 'stream_announcement' if 'news-skandalnoe-predlozhenye-lukashenko-zelenskomu-strym' in a['url'] else None
        a['eligible']=a['registered'] and a['name_in_title'] and a['window_match'] and not a['current_known'] and not a['editorial_exclusion']
        allrows.append(a)

providers=['newscatcher','currents','thenews','cloro']
sets={p:{a['canonical']:a for a in allrows if a['provider']==p} for p in providers}
def metrics(group):
    unique={}
    for p in group:
        for k,a in sets[p].items():
            if k not in unique:unique[k]=dict(a)
            else:
                old=unique[k]
                for field in ['registered','name_in_title','name_signal','window_match','current_known','eligible']:old[field]=old[field] or a[field]
    aa=list(unique.values())
    return {'unique_urls':len(aa),'registered':sum(a['registered'] for a in aa),'direct_title':sum(a['name_in_title'] for a in aa),'registered_direct':sum(a['registered'] and a['name_in_title'] for a in aa),'new_registered_direct':sum(a['registered'] and a['name_in_title'] and not a['current_known'] for a in aa),'dated_registered_direct':sum(a['registered'] and a['name_in_title'] and a['window_match'] for a in aa),'new_registered_direct_dated':sum(a['registered'] and a['name_in_title'] and a['window_match'] and not a['current_known'] for a in aa),'new_all_direct':sum(a['name_in_title'] and not a['current_known'] for a in aa),'known':sum(a['current_known'] for a in aa),'body_only':sum(not a['name_in_title'] for a in aa),'eligible_new':sum(a['eligible'] for a in aa)}

summary={p:metrics([p]) for p in providers}
combinations={'+'.join(g):metrics(g) for n in [2,3,4] for g in itertools.combinations(providers,n)}
for group in itertools.combinations(providers,2):
    combined=metrics(group)
    for p in group:
        assert all(combined[k]>=summary[p][k] for k in ['unique_urls','registered','registered_direct','dated_registered_direct'])
marginal={p:[a for k,a in sets[p].items() if k not in sets['newscatcher'] and a['name_in_title']] for p in providers if p!='newscatcher'}
output={'window':[FROM.isoformat(),TO.isoformat()],'providers':summary,'combinations':combinations,'articles':allrows,'marginal_vs_newscatcher':marginal}
(ROOT/'analysis-revised-20261126.json').write_text(json.dumps(output,ensure_ascii=False,indent=2))
print(json.dumps({'providers':summary,'combinations':combinations},ensure_ascii=False,indent=2))
for p,aa in marginal.items():
    print('\nMARGINAL',p,len(aa))
    for a in aa:print(json.dumps({k:a[k] for k in ['registered','current_known','title','url','description','published_utc','date_raw','freshness']},ensure_ascii=False))

