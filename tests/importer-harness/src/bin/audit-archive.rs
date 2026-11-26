//! Replay saved collector contracts and inspect country visibility without API calls.
use monitor_importer_checks::{db,importer};
use serde_json::json;
fn main(){
 let mut args=std::env::args().skip(1);let output=args.next().expect("output.sqlite [bundle.json ...]");let path=std::path::Path::new(&output);
 db::initialize_database(path).unwrap();
 for input in args {let bundle=serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();importer::import_collector_bundle(path,bundle).unwrap();}
 let facets=db::archive_facets(path,"lukashenko").unwrap();let sources=db::list_sources(path,"lukashenko",None).unwrap();
 let cn=db::list_publications(path,"lukashenko","",None,"","Китай","",&[],"newest",200,0).unwrap();
 let conn=db::open_database(path).unwrap();let mut stmt=conn.prepare("SELECT s.canonical_name,d.title,s.configured_region,e.event_region FROM documents d JOIN sources s ON s.id=d.source_id JOIN monitor_items mi ON mi.document_id=d.id LEFT JOIN event_items ei ON ei.monitor_item_id=mi.id AND ei.relation='primary' LEFT JOIN events e ON e.id=ei.event_id WHERE s.configured_region='Китай' ORDER BY s.canonical_name").unwrap();
 let cards=stmt.query_map([],|r|Ok(json!({"source":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"source_country":r.get::<_,Option<String>>(2)?,"story_country":r.get::<_,Option<String>>(3)?}))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
 println!("{}",serde_json::to_string_pretty(&json!({"stored_chinese_cards":cards,"archive_china":cn.total,"china_in_filter":facets.regions.contains(&"Китай".to_string()),"sources_china":sources.iter().filter(|s|s.region.as_deref()==Some("Китай")).map(|s|s.name.as_str()).collect::<Vec<_>>(),"sources_total":sources.len()})).unwrap());
}
