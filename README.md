# Monitor Dashboard — Desktop Core 0.3

Первый реальный desktop-core для Windows x64.

## Что уже работает в 0.3

- Tauri 2 + React + TypeScript;
- локальная SQLite с миграциями;
- native file picker для ZIP;
- импорт `dashboard_bundle.zip`;
- импорт ZIP-обёртки, скачанной как GitHub Actions artifact (`dashboard-bundle-social-N.zip`);
- JSON Schema validation четырёх файлов Dashboard Contract;
- идемпотентный повторный импорт;
- разделение `documents` / `monitor_items` / `runs` / `run_items` для перекрывающихся 36-часовых окон;
- отдельные source geography и event geography;
- каталог всех источников coverage;
- список импортированных runs;
- workflow для сборки Windows NSIS installer.

## Что сознательно НЕ входит в 0.3

Dashboard, архив публикаций, аналитические графики, карта Беларуси и полнотекстовый поиск — это слой 0.4 поверх уже созданной БД. GitHub sync и запуск monitor workflow из desktop также пока не включены.

## Быстрый запуск на Windows

Требуются Node.js, Rust stable MSVC и Microsoft C++ Build Tools. WebView2 уже присутствует в современных Windows 10/11.

```powershell
npm install
npm run tauri dev
```

Сборка installer:

```powershell
npm run tauri build -- --bundles nsis
```

Installer появится в:

```text
src-tauri\target\release\bundle\nsis\
```

## Сборка через GitHub Actions

Можно создать отдельный репозиторий, положить туда этот проект и вручную запустить workflow:

`Build Monitor Dashboard Windows x64`

Он создаст artifact `monitor-dashboard-windows-x64` с `.exe` installer.

## Импорт

Нажать `+ Импортировать bundle` и выбрать один из вариантов:

1. прямой `dashboard_bundle_social_61.zip`;
2. скачанный GitHub artifact `dashboard-bundle-social-61.zip`, внутри которого лежит прямой bundle.

Приложение само различает эти два формата.

## Локальная БД

SQLite создаётся в системном `app_data_dir` Tauri под именем:

`monitor-dashboard.sqlite3`

Путь отображается в интерфейсе. Monitor Dashboard не пишет ничего в репозитории мониторинга.

## Contract compatibility

0.3 принимает major-версию `0.x`, проверяя обязательную структуру JSON Schema. Неизвестные дополнительные поля не ломают импорт. Major `1.x` и выше отклоняется до явной миграции desktop-core.
