#!/usr/bin/env python3
from __future__ import annotations
import json, re, sqlite3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def apply_schema(conn):
    for name in ['0001_init.sql','0002_sync.sql','0003_preview_images.sql','0004_moderation.sql']:
        conn.executescript((ROOT/'src-tauri/migrations'/name).read_text(encoding='utf-8'))

def seed(conn):
    conn.execute("insert into monitors(id,monitor_key,display_name) values (1,'social_economic','SEP-Monitor')")
    conn.executemany("insert into sources(id,source_uid,canonical_name) values (?,?,?)",[(1,'s1','Source A'),(2,'s2','Source B')])
    docs=[
      (1,'doc-a',1,'https://a/1','https://a/1','2026-09-18T08:00:00','Материал A'),
      (2,'doc-b',1,'https://a/2','https://a/2','2026-09-18T09:00:00','Материал B'),
      (3,'doc-c',2,'https://b/3','https://b/3','2026-09-18T10:00:00','Материал C'),
    ]
    conn.executemany("insert into documents(id,document_uid,source_id,url,normalized_url,published_at,title) values (?,?,?,?,?,?,?)",docs)
    items=[
      (1,'mi-a',1,1,'ЖКХ',1),(2,'mi-b',1,2,'Транспорт',0),(3,'mi-c',1,3,'Цены',1)
    ]
    conn.executemany("insert into monitor_items(id,monitor_item_uid,monitor_id,document_id,category,official_response,raw_json) values (?,?,?,?,?,?, '{}')",items)

def analytics_count(conn):
    return conn.execute("""
      select count(distinct mi.id)
      from monitor_items mi join monitors m on m.id=mi.monitor_id join documents d on d.id=mi.document_id
      where m.monitor_key='social_economic'
        and not exists(select 1 from moderation_flags mf where mf.monitor_key=m.monitor_key and mf.document_uid=d.document_uid)
        and not exists(select 1 from moderation_exclusions mx where mx.monitor_key=m.monitor_key and mx.document_uid=d.document_uid)
    """).fetchone()[0]

def archive_uids(conn):
    return [r[0] for r in conn.execute("""
      select d.document_uid from monitor_items mi join monitors m on m.id=mi.monitor_id join documents d on d.id=mi.document_id
      where m.monitor_key='social_economic'
        and not exists(select 1 from moderation_exclusions mx where mx.monitor_key=m.monitor_key and mx.document_uid=d.document_uid)
      order by d.document_uid
    """)]

def i18n_parity():
    text=(ROOT/'src/i18n.tsx').read_text(encoding='utf-8')
    ru=text.split('const RU = {',1)[1].split('} as const;',1)[0]
    be=text.split('const BE: Record<TranslationKey, string> = {',1)[1].split('};\n\ntype I18nValue',1)[0]
    key_re=re.compile(r'^\s*"([^"]+)"\s*:',re.M)
    r=set(key_re.findall(ru)); b=set(key_re.findall(be))
    assert r==b, {'missing_be':sorted(r-b),'missing_ru':sorted(b-r)}
    for key in ['publication.reaction','publication.reactionHelp','moderation.flaggedBy','moderation.exclude','moderation.keep']:
        assert key in r, key
    return len(r)

def main():
    conn=sqlite3.connect(':memory:'); apply_schema(conn); seed(conn)
    assert analytics_count(conn)==3
    assert archive_uids(conn)==['doc-a','doc-b','doc-c']
    # A red flag keeps the publication visible for review but removes it from analytics.
    conn.execute("insert into moderation_flags(monitor_key,document_uid,user_id,user_name,flagged_at) values ('social_economic','doc-b','u2','Ирина','2026-09-18T11:00:00')")
    assert analytics_count(conn)==2
    assert archive_uids(conn)==['doc-a','doc-b','doc-c']
    # An administrator exclusion is a durable tombstone: hidden from archive and analytics.
    conn.execute("insert into moderation_exclusions(monitor_key,document_uid,excluded_by_name,excluded_at) values ('social_economic','doc-c','Vladislav','2026-09-18T11:10:00')")
    assert analytics_count(conn)==1
    assert archive_uids(conn)==['doc-a','doc-b']
    # Clearing a false flag restores the publication to analytics.
    conn.execute("delete from moderation_flags where document_uid='doc-b'")
    assert analytics_count(conn)==2
    # Static integration checks.
    rust=(ROOT/'src-tauri/src/db.rs').read_text(encoding='utf-8')
    card=(ROOT/'src/components/PublicationCard.tsx').read_text(encoding='utf-8')
    moderation=(ROOT/'src/moderation.tsx').read_text(encoding='utf-8')
    backend=(ROOT/'backend/supabase/upgrade_0_5_3.sql').read_text(encoding='utf-8')
    for token in ['moderation_flags','moderation_exclusions','replace_moderation_snapshot','document_uid']:
        assert token in rust, token
    for token in ['reaction-badge','flagged-badge','moderation.exclude','moderation.flaggedBy']:
        assert token in card, token
    for token in ['listPublicationModeration','replaceModerationSnapshot','monitor:moderation-changed']:
        assert token in moderation, token
    for token in ['publication_flags','publication_exclusions','row level security','publication_flags_delete_self_or_admin']:
        assert token.lower() in backend.lower(), token
    keys=i18n_parity()
    result={'status':'PASS','sqlite_schema_version':4,'flagged_excluded_from_analytics':True,'flagged_remains_in_archive':True,'admin_exclusion_hidden_from_archive':True,'clear_flag_restores_analytics':True,'reaction_marker':True,'i18n_keys_each':keys}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    (ROOT/'VALIDATION_0.5.3.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__': main()
