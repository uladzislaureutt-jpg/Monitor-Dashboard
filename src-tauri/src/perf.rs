//! Bounded, privacy-safe local performance diagnostics. Logs only operation names,
 //! monitor keys, duration and success; never articles, tokens, URLs or queries.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const SLOW_MS: u128 = 150;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

pub fn measure<T>(db_path: &Path, operation: &str, monitor: &str, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let started = Instant::now();
    let outcome = work();
    let elapsed = started.elapsed().as_millis();
    if elapsed >= SLOW_MS || std::env::var_os("MONITOR_PERF_ALL").is_some() {
        let lock = LOG_LOCK.get_or_init(|| Mutex::new(()));
        if let Ok(_guard) = lock.lock() {
            let path = db_path.with_file_name("monitor-performance.log");
            if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_FILE_BYTES) {
                let _ = fs::rename(&path, path.with_extension("log.old"));
            }
            let epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{epoch}\t{operation}\t{monitor}\t{elapsed}ms\t{}", if outcome.is_ok() {"ok"} else {"error"});
            }
        }
    }
    outcome
}
