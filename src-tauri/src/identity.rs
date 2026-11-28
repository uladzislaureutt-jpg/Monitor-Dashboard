use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

use regex::Regex;
use reqwest::Url;
use rusqlite::{Connection, OptionalExtension, params};

/// Same URL policy as the API worker: preserve article IDs and path case.
/// AMP/mobile paths are aliases only when a publisher has verified them.
pub fn url_key(value: &str) -> String {
    let Ok(mut url) = Url::parse(value.trim()) else { return value.trim().to_string(); };
    url.set_fragment(None);
    if matches!(url.scheme(), "http" | "https") { let _ = url.set_scheme("https"); }
    if let Some(host) = url.host_str().map(str::to_owned) {
        if let Some(stripped) = host.strip_prefix("www.") { let _ = url.set_host(Some(stripped)); }
        if host == "amp.dw.com" { let _ = url.set_host(Some("dw.com")); }
    }
    if matches!(url.host_str(), Some("bbc.com")) {
        let path = url.path().trim_end_matches(".amp").trim_end_matches("/amp").to_owned();
        url.set_path(&path);
    }
    let path = url.path().to_string();
    if path.len() > 1 { url.set_path(path.trim_end_matches('/')); }
    let mut pairs: Vec<(String,String)> = url.query_pairs()
        .filter(|(key,_)| {
            let key=key.to_lowercase();
            !key.starts_with("utm_") && !matches!(key.as_str(),"fbclid"|"gclid"|"yclid"|"dclid"|"mc_cid"|"mc_eid"|"ref_src"|"cmpid"|"ocid")
        }).map(|(k,v)|(k.into_owned(),v.into_owned())).collect();
    pairs.sort_by(|a,b|a.0.cmp(&b.0));
    url.set_query(None);
    if !pairs.is_empty() { let mut q=url.query_pairs_mut(); for (k,v) in &pairs { q.append_pair(k,v); } }
    url.to_string()
}

/// Match the collector's verified publisher identities for L-Monitor.
pub fn l_monitor_aliases(urls: &[String]) -> Vec<String> {
    static TSN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^/(?:[^/]+/)+[^/]+-([0-9]{6,10})\.html$").unwrap());
    static PRAVDA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^/(?:(?:rus|eng|ukr)/)?(?:news|articles|columns|interview)/[0-9]{4}/[0-9]{2}/[0-9]{2}/([0-9]{6,10})$").unwrap());
    static RBC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^/(?:(?:rus|ukr|eng)/)?(news/[^/]+-[0-9]{10}\.html)(?:/amp)?$").unwrap());
    static FONTANKA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/\d{4}/\d{2}/\d{2}/\d+/comments$").unwrap());
    static TAGESSPIEGEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)-([0-9]{6,12})\.html$").unwrap());
    static CNN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^/20[0-9]{2}/[0-9]{2}/[0-9]{2}/(?:world|politics|europe)/[a-z0-9-]+$").unwrap());
    static DIGI24: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-([0-9]{6,12})$").unwrap());
    static TERAZ: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/([0-9]{5,12})-clanok\.html$").unwrap());
    let mut aliases = Vec::new();
    for value in urls {
        let Ok(mut url) = Url::parse(&url_key(value)) else { continue };
        let path = url.path();
        let edition = match url.host_str() {
            Some("digi24.ro" | "m.digi24.ro") => DIGI24.captures(path).map(|m| format!("edition:digi24.ro:{}", &m[1])),
            Some("teraz.sk") => TERAZ.captures(path).map(|m| format!("edition:teraz.sk:{}", &m[1])),
            Some("cnn.com" | "edition.cnn.com" | "lite.cnn.com") if CNN.is_match(path) => Some(format!("edition:cnn.com:{path}")),
            Some("tagesspiegel.de") if !path.to_lowercase().contains("/liveblog/") => TAGESSPIEGEL.captures(path).map(|m| format!("edition:tagesspiegel.de:{}", &m[1])),
            Some("tsn.ua") => TSN.captures(path).map(|m| format!("edition:tsn.ua:{}", &m[1])),
            Some("pravda.com.ua") => PRAVDA.captures(path).map(|m| format!("edition:pravda.com.ua:{}", &m[1])),
            Some("rbc.ua") => RBC.captures(path).map(|m| format!("edition:https://rbc.ua/{}", &m[1])),
            Some("fontanka.ru") if FONTANKA.is_match(path) => {
                let article = path.trim_end_matches("/comments").to_owned();
                url.set_path(&article);
                Some(url.to_string())
            }
            _ => None,
        };
        aliases.extend(edition);
    }
    aliases
}

pub fn reconcile_l_monitor_identity(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn.prepare(r#"
        SELECT mi.id, d.id, d.document_uid, d.url, d.normalized_url,
               MIN(json_extract(r.manifest_json, '$.run.collector') IS 'api_assistant'),
               MAX(json_extract(r.manifest_json, '$.run.collector') IS 'api_assistant'),
               mi.monitor_id,
               NOT EXISTS (SELECT 1 FROM monitor_items other WHERE other.document_id=d.id AND other.monitor_id<>mi.monitor_id)
        FROM monitor_items mi JOIN documents d ON d.id=mi.document_id
        JOIN monitors m ON m.id=mi.monitor_id
        JOIN run_items ri ON ri.monitor_item_id=mi.id JOIN runs r ON r.id=ri.run_id
        WHERE m.monitor_key='lukashenko'
          AND COALESCE(r.dry_run, 0) = 0
          AND (json_extract(r.manifest_json, '$.run.collector') = 'api_assistant'
               OR json_extract(r.manifest_json, '$.run.collector') IS NULL)
        GROUP BY mi.id ORDER BY mi.id
    "#).map_err(|error| error.to_string())?;
    let rows = stmt.query_map([], |row| Ok((
        row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?,
        row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, bool>(5)?,
        row.get::<_, bool>(6)?, row.get::<_, i64>(7)?, row.get::<_, bool>(8)?,
    ))).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

    let mut keys = BTreeMap::<String, Vec<usize>>::new();
    let mut alias_stmt = conn.prepare("SELECT url_key FROM document_url_aliases WHERE document_id=?1")
        .map_err(|error| error.to_string())?;
    for (index, (_, document, _, url, normalized, _, _, _, _)) in rows.iter().enumerate() {
        let mut urls = alias_stmt.query_map([document], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
        urls.extend([url.clone(), normalized.clone()]);
        urls.extend(l_monitor_aliases(&urls));
        urls.iter().map(|url| url_key(url)).for_each(|key| {
            let members = keys.entry(key).or_default();
            if members.last() != Some(&index) { members.push(index); }
        });
    }

    let mut merged_into = HashMap::new();
    for (key, indexes) in keys {
        let mut members: Vec<_> = indexes.iter().map(|index| {
            let mut root = *index;
            while let Some(parent) = merged_into.get(&root) { root = *parent; }
            root
        }).collect();
        members.sort_unstable();
        members.dedup();
        let eligible = members.iter().all(|index| rows[*index].8);
        let both_feeds = indexes.iter().any(|index| !rows[*index].5) && indexes.iter().any(|index| rows[*index].6);
        let winner = members[0];
        let verified_article = key.starts_with("edition:tagesspiegel.de:") || key.starts_with("edition:cnn.com:") || key.starts_with("edition:digi24.ro:") || key.starts_with("edition:teraz.sk:");
        if eligible && (both_feeds || verified_article) {
            for &index in &members[1..] {
                let (old_item, old_document, old_uid, old_url, ..) = &rows[index];
                merge_document(conn, rows[winner].0, rows[winner].1, *old_item, *old_document, old_uid, old_url)?;
                merged_into.insert(index, winner);
            }
        }
        conn.execute("INSERT OR IGNORE INTO document_url_aliases(url_key,document_id) VALUES (?1,?2)", params![key, rows[winner].1])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn seed_aliases(conn: &Connection) -> Result<(),String> {
    let rows={
        let mut stmt=conn.prepare("SELECT id,document_uid,url,normalized_url FROM documents ORDER BY id")
            .map_err(|e| e.to_string())?;
        stmt.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))
            .map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?
    };
    for (id,uid,url,normalized) in rows {
        register(conn,id,&uid,&[url,normalized])?;
    }
    Ok(())
}

pub fn find_document(conn:&Connection,uid:&str,urls:&[String])->Result<Option<i64>,String>{
    for url in urls {
        let key=url_key(url);
        let found=conn.query_row("SELECT document_id FROM document_url_aliases WHERE url_key=?1",params![key],|r|r.get(0))
            .optional().map_err(|e|e.to_string())?;
        if found.is_some(){return Ok(found);}
    }
    conn.query_row("SELECT document_id FROM document_uid_aliases WHERE alias_uid=?1 UNION ALL SELECT id FROM documents WHERE document_uid=?1 LIMIT 1",params![uid],|r|r.get(0))
        .optional().map_err(|e|e.to_string())
}

pub fn register(conn:&Connection,id:i64,uid:&str,urls:&[String])->Result<(),String>{
    conn.execute("INSERT INTO document_uid_aliases(alias_uid,document_id) VALUES(?1,?2) ON CONFLICT(alias_uid) DO NOTHING",params![uid,id]).map_err(|e|e.to_string())?;
    for url in urls {
        let key=url_key(url);
        conn.execute("INSERT INTO document_url_aliases(url_key,document_id) VALUES(?1,?2) ON CONFLICT(url_key) DO NOTHING",params![key,id]).map_err(|e|e.to_string())?;
    }
    // A flag/exclusion can arrive before the publication that introduces its alias.
    let stable:String=conn.query_row("SELECT document_uid FROM documents WHERE id=?1",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if stable!=uid {
        conn.execute("INSERT OR IGNORE INTO moderation_flags(monitor_key,document_uid,user_id,user_name,flagged_at) SELECT monitor_key,?1,user_id,user_name,flagged_at FROM moderation_flags WHERE document_uid=?2",params![stable,uid]).map_err(|e|e.to_string())?;
        conn.execute("INSERT OR IGNORE INTO moderation_exclusions(monitor_key,document_uid,excluded_by_name,excluded_at) SELECT monitor_key,?1,excluded_by_name,excluded_at FROM moderation_exclusions WHERE document_uid=?2",params![stable,uid]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

pub fn stable_uid(conn:&Connection,uid:&str)->Result<String,String>{
    let value:Option<String>=conn.query_row("SELECT d.document_uid FROM document_uid_aliases a JOIN documents d ON d.id=a.document_id WHERE a.alias_uid=?1",params![uid],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    Ok(value.unwrap_or_else(||uid.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn url_identity_keeps_article_parameters(){
        assert_eq!(url_key("http://www.example.com/News/A/?utm_source=x&id=7#part"),"https://example.com/News/A?id=7");
        assert_ne!(url_key("https://example.com/a?id=7"),url_key("https://example.com/a?id=8"));
        assert_ne!(url_key("https://example.com/A"),url_key("https://example.com/a"));
    }
}

/// Reconcile publisher-confirmed duplicates in a revised API package.
pub fn merge_collector_duplicates(
    conn: &Connection,
    monitor_id: i64,
    item_id: i64,
    document_id: i64,
    urls: &[String],
    duplicate_uids: &[serde_json::Value],
) -> Result<(), String> {
    let keys: Vec<_> = urls.iter().map(|url| url_key(url)).collect();
    for uid in duplicate_uids.iter().filter_map(serde_json::Value::as_str) {
        if !uid.starts_with("lapi_") {
            continue;
        }
        let row: Option<(i64, i64, String, String)> = conn.query_row(
            r#"SELECT COALESCE(mi.id,0),d.id,d.url,d.document_uid FROM documents d
               LEFT JOIN monitor_items mi ON mi.document_id=d.id AND mi.monitor_id=?1
               WHERE d.id<>?2 AND
                 (d.document_uid=?3 OR EXISTS(SELECT 1 FROM document_uid_aliases a WHERE a.alias_uid=?3 AND a.document_id=d.id))
                 AND NOT EXISTS (SELECT 1 FROM monitor_items other WHERE other.document_id=d.id AND other.monitor_id<>?1)"#,
            params![monitor_id, document_id, uid],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(|error| error.to_string())?;
        let Some((old_item, old_document, old_url, old_uid)) = row else { continue; };
        if !keys.contains(&url_key(&old_url)) {
            continue;
        }
        merge_document(conn, item_id, document_id, old_item, old_document, &old_uid, &old_url)?;
        if uid != old_uid {
            register(conn, document_id, uid, &[])?;
        }
    }
    Ok(())
}

fn merge_document(
    conn: &Connection,
    item_id: i64,
    document_id: i64,
    old_item: i64,
    old_document: i64,
    old_uid: &str,
    old_url: &str,
) -> Result<(), String> {
    conn.execute(
        r#"INSERT OR IGNORE INTO run_items
           (run_id,monitor_item_id,was_primary_result,event_echo,event_echo_anchor,event_echo_sources,also_covered_by,also_covered_urls)
           SELECT run_id,?1,was_primary_result,event_echo,event_echo_anchor,event_echo_sources,also_covered_by,also_covered_urls
           FROM run_items WHERE monitor_item_id=?2"#,
        params![item_id, old_item],
    ).map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE document_url_aliases SET document_id=?1 WHERE document_id=?2",
        params![document_id, old_document],
    ).map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE document_uid_aliases SET document_id=?1 WHERE document_id=?2",
        params![document_id, old_document],
    ).map_err(|error| error.to_string())?;
    register(conn, document_id, old_uid, &[old_url.to_string()])?;
    conn.execute(
        r#"UPDATE documents AS target SET
             (full_text,full_text_sha256,full_text_quality,full_text_extraction_strategy,full_text_transport,text_length)
           =(SELECT full_text,full_text_sha256,full_text_quality,full_text_extraction_strategy,full_text_transport,text_length
             FROM documents WHERE id=?2)
           WHERE target.id=?1 AND EXISTS(SELECT 1 FROM documents previous
             WHERE previous.id=?2 AND previous.full_text IS NOT NULL
               AND (target.full_text IS NULL OR
                 (previous.full_text_quality='FULL_TEXT' AND COALESCE(target.full_text_quality,'')<>'FULL_TEXT') OR
                 (COALESCE(previous.full_text_quality,'')=COALESCE(target.full_text_quality,'')
                   AND length(previous.full_text)>length(target.full_text))))"#,
        params![document_id, old_document],
    ).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO event_items(event_id,monitor_item_id,relation)
         SELECT event_id,?1,relation FROM event_items WHERE monitor_item_id=?2",
        params![item_id, old_item],
    ).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO document_entities(document_id,entity_id,mentions)
         SELECT ?1,entity_id,mentions FROM document_entities WHERE document_id=?2",
        params![document_id, old_document],
    ).map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM monitor_items WHERE id=?1", params![old_item])
        .map_err(|error| error.to_string())?;
    Ok(())
}
