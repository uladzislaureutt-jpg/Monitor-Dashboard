# Monitor 0.7.11 — Wide Motion UI rollback

Baseline before this UI package: `2e2312ddeda9de5d83c7bb286c87eadfe25d72a5` (Monitor 0.7.10).

## Preferred rollback (no reinstall, no database changes)

Open **Данные** and use **Вернуть прежний вид** in the “Широкий интерфейс 16:9” panel.

The switch only changes the UI feature flag:
`monitor-dashboard-wide-motion-ui-v1 = legacy`

It does not change:
- SQLite data;
- imported runs;
- synchronization settings;
- moderation state;
- report drafts;
- Dashboard Contract data.

Use **Включить широкий вид** to restore the 0.7.11 layout.

## Repository rollback

If the entire UI package must be removed from source, restore the UI files to baseline commit
`2e2312ddeda9de5d83c7bb286c87eadfe25d72a5`.
Do not revert database/import/sync fixes that were already present in 0.7.10.

Files intentionally touched by the package:
- src/App.tsx
- src/views/DataView.tsx
- src/views/DashboardView.tsx
- src/components/BreakdownPanel.tsx
- src/components/Charts.tsx
- src/styles.css
- package.json
- package-lock.json
- src-tauri/tauri.conf.json

## Performance design

The dark-shell motion uses CSS transforms/opacity only. No canvas, WebGL, video,
remote animation assets, or additional runtime dependencies are introduced.
`prefers-reduced-motion: reduce` disables motion automatically.
