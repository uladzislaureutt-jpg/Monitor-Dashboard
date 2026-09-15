# Validation — Monitor Dashboard 0.4.0

## Проверено локально

- структура проекта и относительные imports;
- TypeScript/TSX синтаксис и внутренняя типовая согласованность через локальные declaration stubs (реестр npm в среде проверки недоступен);
- SQLite-запросы Dashboard / Archive / Sources на реальном Dashboard bundle run 61;
- all-time: 24 уникальные публикации;
- 30-day dated slice: 23 публикации (одна запись run 61 без `published_at` закономерно остаётся только во «Всё время»);
- 56 источников coverage;
- 6 определённых регионов событий в 30-day slice;
- 7 категорий;
- тестовый запрос `вод`: 14 совпадений по полям поиска;
- сохранён Windows release attribute `windows_subsystem = "windows"`, устраняющий консольное окно.

Результат fixture: `VALIDATION_0.4_RUN61.json`.

## Что должно проверить GitHub Actions

В локальном контейнере нет Rust toolchain, а npm registry недоступен, поэтому окончательная проверка выполняется существующим Windows workflow:

1. `npm install`;
2. `npm run build`;
3. `npm run tauri build -- --bundles nsis`.

После успешного workflow 0.4 можно считать Windows-build validated.
