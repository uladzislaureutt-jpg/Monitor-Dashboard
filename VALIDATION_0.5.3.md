# Validation — Monitor 0.5.3

- SQLite migrations 0001→0004: PASS.
- Red-flagged publication remains visible in archive: PASS.
- Red-flagged publication is excluded from analytical counts/diagrams: PASS.
- Admin exclusion removes publication from archive query and analytics: PASS.
- Clearing a false flag restores analytical counting: PASS.
- Stable cross-machine key is `document_uid`, not local SQLite row id: PASS.
- Publication cards contain RU/BE `reaction recorded` marker and moderation controls: PASS.
- RU/BE dictionary parity: 276 / 276 keys: PASS.
- TypeScript/TSX syntax transpilation: PASS.
- Supabase migration applied to live `monitor-workroom`: PASS.
- Supabase RLS enabled for `publication_flags` and `publication_exclusions`: PASS.
- Supabase Security Advisor: no schema/RLS warning introduced by 0.5.3; account-level leaked-password warning remains independent of this package.
- Final Rust/NSIS compilation must be confirmed by the existing GitHub Actions Windows workflow.
