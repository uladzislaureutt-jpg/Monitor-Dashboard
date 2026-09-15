# Validation — Desktop Core 0.3

Проверено на реальном artifact `dashboard-bundle-social-61.zip`.

## Contract / SQLite smoke test

`VALIDATION_RUN61.json`:

- GitHub artifact wrapper распознан;
- Dashboard Contract `0.1` прошёл четыре JSON Schema;
- 24 публикации импортированы как 24 `documents` + 24 `monitor_items` + 24 `run_items`;
- 56 строк coverage импортированы как 56 distinct sources и 56 `source_run_metrics`;
- повторный импорт того же bundle дал `already_imported`;
- после повторного импорта число строк не изменилось.

Тот же тест отдельно выполнен на внутреннем direct bundle (`VALIDATION_RUN61_DIRECT.json`), результат также PASS.

Во время smoke-test обнаружена и исправлена важная ошибка проекта source-key: домен нельзя использовать как единственный идентификатор источника, поскольку 11 Telegram-источников run 61 делят домен `t.me`. Stable `source_uid` теперь всегда включает и canonical source name, и domain.

## Frontend

TypeScript/TSX проверен локальным `tsc --noEmit` со stub declarations для внешних React/Tauri modules: синтаксических и внутренних type errors не выявлено.

## Ограничение локальной среды

В текущем рабочем контейнере отсутствует Rust toolchain (`cargo`/`rustc`), поэтому полноценный `cargo check` и сборка Tauri binary здесь не выполнялись. Для этого в пакет включён `.github/workflows/build-windows.yml`, который на `windows-latest` устанавливает Rust stable MSVC и собирает реальный NSIS `.exe`.

## Overlapping-window test

`VALIDATION_OVERLAP.json` моделирует две соседние 36-часовые выборки, в которых присутствуют те же 24 публикации. Результат PASS: `runs=2`, `documents=24`, `monitor_items=24`, но `run_items=48`. То есть повторное наблюдение не размножает публикации в архиве.
