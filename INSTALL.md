# Monitor Dashboard 0.3.2 — Windows console fix

Это минимальная правка поверх уже установленного Desktop Core 0.3.1.

## Что исправляет

Release-сборка Tauri больше не открывает отдельное чёрное окно Windows Terminal/console рядом с приложением.

## Что заменить

Скопировать в репозиторий с заменой только:

`src-tauri/src/main.rs`

После commit повторно запустить:

Actions → Build Monitor Dashboard Windows x64 → Run workflow

Новый installer установить поверх текущей версии (либо удалить старую и установить новую).

## Что не меняется

- SQLite
- импорт bundle
- frontend
- workflow сборки
- мониторинг SE-monitor
