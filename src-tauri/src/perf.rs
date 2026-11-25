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


// Local-only aggregate from the two bounded log generations. The report never
// includes content, network addresses, account identifiers or SQL parameters.
// Logs contain slow operations (>=150ms), not every invocation, so percentile
// figures describe only the recorded slow samples.
fn summarize_slow_log(input: &str, now: u64) -> String {
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<(String, String), Vec<(u64, bool)>> = BTreeMap::new();
    for line in input.lines() {
        let mut fields = line.split('\t');
        let (Some(ts), Some(operation), Some(monitor), Some(duration), Some(status)) =
            (fields.next(), fields.next(), fields.next(), fields.next(), fields.next())
        else { continue; };
        if fields.next().is_some() { continue; }
        let (Ok(epoch), Some(ms_text)) = (ts.parse::<u64>(), duration.strip_suffix("ms")) else { continue; };
        let Ok(elapsed) = ms_text.parse::<u64>() else { continue; };
        if epoch > now || now - epoch > 24 * 3600 || elapsed < 150 { continue; }
        // These are fixed internal operation and monitor names, not user text.
        if operation.len() > 64 || monitor.len() > 32 ||
           !operation.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') ||
           !monitor.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { continue; }
        groups.entry((operation.to_string(), monitor.to_string()))
            .or_default().push((elapsed, status == "error"));
    }
    if groups.is_empty() {
        return "За последние 24 часа не зарегистрировано операций длительностью 150 мс и более.".to_string();
    }
    let mut rows = groups.into_iter().map(|((operation, monitor), measures)| {
        let failures = measures.iter().filter(|(_, failed)| *failed).count();
        let mut times: Vec<u64> = measures.iter().map(|(ms, _)| *ms).collect();
        times.sort_unstable();
        let index = (times.len() * 95).div_ceil(100).saturating_sub(1);
        let p95 = times[index];
        let worst = *times.last().unwrap_or(&0);
        (operation, monitor, times.len(), failures, p95, worst)
    }).collect::<Vec<_>>();
    rows.sort_by(|a, b| b.5.cmp(&a.5).then_with(|| b.4.cmp(&a.4)));
    let samples: usize = rows.iter().map(|row| row.2).sum();
    let mut report = format!(
        "Локальная диагностика за последние 24 часа\n\
         Записано медленных операций: {samples}; порог записи: 150 мс.\n\
         p95 рассчитан только по записанным медленным операциям, не по всем действиям.\n\
         Операция / монитор | случаев | p95, мс | максимум, мс | ошибок\n"
    );
    for (operation, monitor, count, errors, p95, worst) in rows.into_iter().take(30) {
        report.push_str(&format!("{operation} / {monitor} | {count} | {p95} | {worst} | {errors}\n"));
    }
    report
}

pub fn recent_summary(db_path: &Path) -> String {
    let log_path = db_path.with_file_name("monitor-performance.log");
    let now = SystemTime::now().duration_since(UNIX_EPOCH)
        .unwrap_or_default().as_secs();
    let mut combined = String::new();
    let rotated_path = log_path.with_extension("log.old");
    for file in [&log_path, &rotated_path] {
        if let Ok(content) = fs::read_to_string(file) {
            combined.push_str(&content);
            combined.push('\n');
        }
    }
    summarize_slow_log(&combined, now)
}

#[cfg(test)]
mod summary_tests {
    use super::summarize_slow_log;

    #[test]
    fn summarizes_only_last_day_and_never_reports_raw_content() {
        let input = "99992\tdashboard\tsocial_economic\t180ms\tok\n\
                     99994\tdashboard\tsocial_economic\t600ms\terror\n\
                     11000\tdashboard\tsocial_economic\t900ms\tok\n\
                     99993\tbad operation\tsecret\t2000ms\tok\n";
        let output = summarize_slow_log(input, 100000);
        assert!(output.contains("dashboard / social_economic | 2 | 600 | 600 | 1"));
        assert!(!output.contains("2000"));
        assert!(!output.contains("900"));
        assert!(!output.contains("secret"));
    }

    #[test]
    fn empty_report_has_honest_threshold() {
        assert!(summarize_slow_log("", 100000).contains("150 мс"));
    }
}
