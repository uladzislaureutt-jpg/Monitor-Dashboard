# Stage 0.3 — Desktop Core

## Принцип

Desktop больше не знает внутренние CSV/HTML/debug форматы monitor pipeline. Единственный вход — Dashboard Data Contract.

```text
GitHub Actions artifact
  -> ZIP adapter (outer artifact или direct bundle)
  -> JSON Schema validator
  -> transactional importer
  -> SQLite
  -> query commands
  -> React UI
```

## Идемпотентность

Ключ run: `(monitor_id, external_run_key)`. Для GitHub-run используется `github_run_id`. Хэш считается от внутреннего dashboard bundle, а не от внешней ZIP-обёртки GitHub.

- тот же run + тот же hash -> `already_imported`, данные не дублируются;
- тот же run + другой hash -> `replaced`, run observation и source metrics перестраиваются транзакционно;
- публикация определяется `document_id`, дополнительно защищена unique `normalized_url`;
- classification определяется `monitor_item_id` и может существовать отдельно для каждого monitor.

## Перекрывающиеся окна

Одна статья, попавшая в run N и run N+1, хранится один раз в `documents`. Наблюдения двух запусков находятся в `run_items`.

## География

`source.configured_region/locality` -> `sources`.

`event.region/locality` -> `events`.

Карта 0.4 будет строиться только по `events.event_region/event_locality`.

## Safety

Importer не распаковывает ZIP на диск, поэтому пути внутри архива не могут записать файл вне временного каталога. Есть лимиты размера ZIP, entry и JSONL-line. Любая ошибка validation/SQLite откатывает всю транзакцию.
