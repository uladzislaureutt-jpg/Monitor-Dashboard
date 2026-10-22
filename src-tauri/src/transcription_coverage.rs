// Auditable, provider-independent acoustic-silence checks for Whisper gaps.
// FFmpeg silencedetect distinguishes QUIET audio from non-quiet audio;
// it cannot prove speech (music/noise can be non-quiet).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SilenceSpan {
    pub start: f64,
    pub end: f64,
}
fn number_after(line: &str, token: &str) -> Option<f64> {
    let pos = line.find(token)?;
    let txt = line[pos + token.len()..].trim_start();
    let word = txt.split_whitespace().next()?;
    let n = word.parse::<f64>().ok()?;
    if n.is_finite() && n >= 0.0 { Some(n) } else { None }
}
pub fn parse_silence(stderr: &str, duration: f64) -> Vec<SilenceSpan> {
    let mut pending = None;
    let mut result = Vec::new();
    for line in stderr.lines() {
        if let Some(start) = number_after(line, "silence_start:") {
            pending = Some(start);
        } else if let Some(end) = number_after(line, "silence_end:") {
            if let Some(start) = pending.take() {
                if end > start { result.push(SilenceSpan { start, end }); }
            }
        }
    }
    if let Some(start) = pending {
        if duration.is_finite() && duration > start {
            result.push(SilenceSpan { start, end: duration });
        }
    }
    result
}
pub fn silence_share(start: f64, end: f64, silences: &[SilenceSpan]) -> f64 {
    if !start.is_finite() || !end.is_finite() || end <= start { return 0.0; }
    let mut covered = 0.0;
    let mut last = start;
    // FFmpeg normally supplies disjoint chronological intervals. Sort anyway
    // to avoid counting overlapping spans twice.
    let mut ordered = silences.to_vec();
    ordered.sort_by(|a,b| a.start.total_cmp(&b.start));
    for interval in ordered {
        let a = interval.start.max(last).max(start);
        let b = interval.end.min(end);
        if b > a { covered += b-a; last = b; }
    }
    (covered/(end-start)).clamp(0.0,1.0)
}
pub fn coverage_warning(
    start: f64, end: f64, silences: Option<&[SilenceSpan]>,
) -> Option<String> {
    if end-start<=4.0 || end<=start { return None; }
    match silences {
        Some(s) if silence_share(start,end,s)>=0.75 => None,
        Some(s) if silence_share(start,end,s)>=0.3 => Some(format!(
            "Проверьте участок {:.0}–{:.0} с: между фразами есть и тишина, и звуковая активность.",
            start,end
        )),
        Some(_) => Some(format!(
            "Возможный пропуск распознавания: {:.0}–{:.0} с (есть звук; речь не подтверждена).",
            start,end
        )),
        None => Some(format!(
            "Проверьте временной интервал {:.0}–{:.0} с: оценка тишины недоступна.",
            start,end
        )),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_silence_detect_and_open_tail() {
        let log="[silencedetect @ 0x5] silence_start: 232.00\n\
[silencedetect @ 0x5] silence_end: 236.90 | silence_duration: 4.90\n\
[silencedetect @ 0x5] silence_start: 59.0\n";
        let spans=parse_silence(log,60.0);
        assert_eq!(spans.len(),2);
        assert_eq!(spans[0],SilenceSpan{start:232.0,end:236.9});
        assert_eq!(spans[1],SilenceSpan{start:59.0,end:60.0});
    }
    #[test]
    fn a_silent_gap_does_not_trigger_false_speech_loss() {
        let silent=[SilenceSpan{start:232.0,end:236.9}];
        assert_eq!(coverage_warning(232.0,236.0,Some(&silent)),None);
        assert!(coverage_warning(232.0,238.5,Some(&silent)).is_some());
    }
    #[test]
    fn sound_or_unknown_remains_reviewable_not_verified_speech() {
        let none: &[SilenceSpan]=&[];
        assert!(coverage_warning(600.0,609.0,Some(none)).unwrap().contains("речь не подтверждена"));
        assert!(coverage_warning(600.0,609.0,None).unwrap().contains("оценка тишины недоступна"));
        assert!(coverage_warning(600.0,603.0,Some(none)).is_none());
    }
    #[test]
    fn overlapping_spans_cannot_overstate_quiet_duration() {
        let s=[SilenceSpan{start:2.0,end:8.0},SilenceSpan{start:4.0,end:9.0}];
        assert!((silence_share(0.0,10.0,&s)-0.7).abs()<1e-9);
    }
}
