fn main(){
 let mut args=std::env::args().skip(1);let input=args.next().expect("bundle.json");let output=args.next().expect("output.sqlite");
 let bundle=serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();let path=std::path::Path::new(&output);
 monitor_importer_checks::db::initialize_database(path).unwrap();
 let result=monitor_importer_checks::importer::import_collector_bundle(path,bundle).unwrap();println!("{}",serde_json::to_string(&result).unwrap());
 let stats=monitor_importer_checks::db::list_runs(path,"lukashenko").unwrap();println!("{} runs",stats.len());
}
