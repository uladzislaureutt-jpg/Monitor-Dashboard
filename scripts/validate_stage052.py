#!/usr/bin/env python3
from __future__ import annotations
import json, math, re, zipfile, io
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def load_bundle(path:Path):
    raw=path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(raw)) as outer:
        names=outer.namelist()
        if 'manifest.json' in names:
            inner=raw
        else:
            nested=[n for n in names if n.lower().endswith('.zip') and 'dashboard' in n.lower()]
            assert len(nested)==1, nested
            inner=outer.read(nested[0])
    with zipfile.ZipFile(io.BytesIO(inner)) as z:
        manifest=json.loads(z.read('manifest.json'))
        pubs=[json.loads(x) for x in z.read(manifest['files']['publications']).decode().splitlines() if x.strip()]
        sources=[json.loads(x) for x in z.read(manifest['files']['source_metrics']).decode().splitlines() if x.strip()]
    return manifest,pubs,sources

def diversity(pubs):
    counts={}
    for p in pubs:
        name=p['source']['name']
        counts[name]=counts.get(name,0)+1
    ordered=sorted(counts.items(), key=lambda x:(-x[1],x[0]))
    total=sum(v for _,v in ordered)
    shares=[v/total for _,v in ordered] if total else []
    hhi=sum(v*v for v in shares)
    return {
        'active_sources':len(ordered),
        'top_source':ordered[0][0] if ordered else None,
        'top_source_share':shares[0]*100 if shares else 0,
        'top_five_share':sum(shares[:5])*100,
        'diversity_index':(1-hhi)*100 if shares else 0,
        'effective_sources':1/hhi if hhi else 0,
    }

def classify_health(s):
    access=s.get('access_status') or ''
    admission=s.get('admission_status') or ''
    blind=s.get('blind_zone_status') or ''
    error=(s.get('error') or '').strip()
    endpoint_total=s.get('endpoint_total') or 0
    endpoint_ok=s.get('endpoint_ok') or 0
    endpoint_failed=s.get('endpoint_failed') or 0
    endpoints_bad=endpoint_failed>0 and endpoint_ok==0 and endpoint_total>0
    if error or endpoints_bad or (access and access not in {'healthy_active','protected_recovery'}): return 'attention'
    if admission in {'soft_admission_limited','source_clipped'} or blind=='source_clipped': return 'limited'
    if access=='protected_recovery': return 'recovery'
    return 'stable'

BLOCKED=['новости','навины','навіны','вести','весці','газета','радио','радыё','телеканал','канал','редакция','рэдакцыя','министерство','міністэрства','комитет','камітэт','совет','савет','администрация','адміністрацыя','управление','упраўленне','предприятие','прадпрыемства','центр','цэнтр','больница','бальніца','поликлиника','паліклініка','школа','гимназия','гімназія','университет','універсітэт','суд','прокуратура','белстат','банк','почта','пошта','белпочта','белпошта','водоканал','водаканал','жкх','облисполком','аблвыканкам','горисполком','гарвыканкам','райисполком','райвыканкам','белая русь','красный крест','чырвоны крыж']
NAMES={'александр','аляксандр','алексей','аляксей','андрей','андрэй','владимир','уладзімір','владислав','уладзіслаў','виктор','віктар','иван','іван','михаил','міхаіл','николай','мікалай','олег','алег','павел','сергей','сяргей','юрий','юрый','анна','ганна','елена','алена','ирина','ірына','ольга','волга','светлана','святлана','татьяна','таццяна','юлия','юлія','мария','марыя','наталья','наталля'}
def norm(v): return ' '.join(re.sub(r'[^0-9a-zа-яёіў]+',' ',v.lower(),flags=re.I).split())
def plausible(v, dynamic=()):
    k=norm(v)
    if k in set(map(norm,dynamic)): return False
    if any(x in k for x in BLOCKED): return False
    words=k.split()
    if not 2<=len(words)<=3 or any(len(w)<3 for w in words): return False
    return any(w in NAMES for w in words) or any(w.endswith(('ович','евич','ич','овна','евна','аўна','еўна')) for w in words)

def i18n_parity():
    text=(ROOT/'src/i18n.tsx').read_text(encoding='utf-8')
    ru=text.split('const RU = {',1)[1].split('} as const;',1)[0]
    be=text.split('const BE: Record<TranslationKey, string> = {',1)[1].split('};\n\ntype I18nValue',1)[0]
    key_re=re.compile(r'^\s*"([^"]+)"\s*:',re.M)
    r=set(key_re.findall(ru)); b=set(key_re.findall(be))
    assert r==b, {'missing_be':sorted(r-b),'missing_ru':sorted(b-r)}
    return len(r)

def main():
    import argparse
    ap=argparse.ArgumentParser(); ap.add_argument('bundle',type=Path); ap.add_argument('--output',type=Path); args=ap.parse_args()
    manifest,pubs,sources=load_bundle(args.bundle)
    d=diversity(pubs)
    health={'stable':0,'recovery':0,'limited':0,'attention':0}
    for src in sources: health[classify_health(src)]+=1
    assert sum(health.values())==len(sources)
    assert plausible('Новости Могилева') is False
    assert plausible('Александр Лукашенко') is True
    assert plausible('Белая Русь') is False
    assert plausible('Николай Карпенков') is True
    keys=i18n_parity()
    rust=(ROOT/'src-tauri/src/db.rs').read_text(encoding='utf-8')
    for token in ['source_diversity_summary','coverage_health_summary','person_blocked_terms','entity_blocklist','новости']:
        assert token in rust, token
    result={'status':'PASS','run_number':manifest['run'].get('run_number'),'publications':len(pubs),'coverage_sources':len(sources),'diversity':{k:(round(v,2) if isinstance(v,float) else v) for k,v in d.items()},'health':health,'person_corrective':{'Новости Могилева':False,'Александр Лукашенко':True,'Белая Русь':False,'Николай Карпенков':True},'i18n_keys_each':keys}
    text=json.dumps(result,ensure_ascii=False,indent=2); print(text)
    if args.output: args.output.write_text(text+'\n',encoding='utf-8')
if __name__=='__main__': main()
