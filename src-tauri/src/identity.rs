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
    conn.query_row("SELECT id FROM documents WHERE document_uid=?1 UNION ALL SELECT document_id FROM document_uid_aliases WHERE alias_uid=?1 LIMIT 1",params![uid],|r|r.get(0))
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
