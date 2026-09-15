# Validation — 0.4.1

## Passed locally

- TS/TSX syntax parsed by TypeScript compiler API: PASS.
- Existing 0001 SQLite schema + new 0002 migration: PASS.
- New schema version after migration: 2.
- `sync_run_status` created with expected columns.
- `daily-social-monitor.yml` and SE-monitor production workflow are not part of this package.

## Requires GitHub Actions / Windows validation

Local environment does not contain Rust toolchain and frontend dependencies were not available from npm registry, therefore the authoritative integration test is the existing Windows GitHub Actions workflow:

1. `npm install`
2. `npm run build`
3. `npm run tauri build -- --bundles nsis`

After installation verify:

- no console window;
- existing SQLite data remain visible;
- chart view switches work;
- Belarus map view opens;
- Workroom opens from the left sidebar;
- Auto Sync can list/download dashboard artifacts from the configured repository.
