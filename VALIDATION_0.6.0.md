# Monitor 0.6.0 — validation

Проверено локально:

- SQLite migrations 0001 → 0005 применяются последовательно без ошибок;
- schema 5 добавляет полный текст и provenance извлечения в `documents`, confidence/method/surface form в `document_entities`;
- Dashboard Contract 0.1 остаётся допустимым: `entities`/`full_texts` в manifest optional;
- Contract 0.2 sidecars валидируются по monitor/document IDs перед импортом;
- персоналии Dashboard теперь считаются из `entities` + `document_entities`, локальный regex-парсер удалён;
- backend API подготовлен: `get_editorial_source(documentUid)` возвращает полный текст и структурированные сущности для будущего Report Workspace;
- TypeScript изменённых файлов проходит standalone syntactic transpilation;
- полный frontend `tsc` в контейнере не запускался из-за отсутствия установленных React/Tauri dependencies;
- Rust toolchain в контейнере отсутствует, поэтому окончательная Rust/Windows compile-проверка остаётся за GitHub Actions.
