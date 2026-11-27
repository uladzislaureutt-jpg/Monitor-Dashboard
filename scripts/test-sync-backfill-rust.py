#!/usr/bin/env python3
"""Compile and exercise the real pure-Rust sync backfill helper without Tauri."""
from pathlib import Path
import subprocess
import tempfile

source = Path("src-tauri/src/sync.rs").read_text(encoding="utf-8")
helper_start = source.index("const STORAGE_FALLBACK_ID_BASE")
helper_end = source.index("\nfn artifact_prefix(", helper_start)
test_start = source.index("    #[test]\n    fn run_221_222_missing_after_223")
test_end = source.index("    #[test]\n    fn duplicate_run_prefers_newest_artifact()", test_start)
program = (
    "use std::collections::HashSet;\n"
    + source[helper_start:helper_end] + "\n"
    + "#[cfg(test)]\nmod tests {\n    use super::*;\n"
    + source[test_start:test_end] + "\n}\n"
)
with tempfile.TemporaryDirectory(prefix="sync-backfill-") as tmp:
    test_src = Path(tmp, "sync_backfill.rs")
    compiled = Path(tmp, "sync_backfill_tests")
    test_src.write_text(program, encoding="utf-8")
    subprocess.run(
        ["rustc", "--edition=2021", "--test", str(test_src), "-o", str(compiled)],
        check=True,
    )
    subprocess.run([str(compiled), "--nocapture"], check=True)
