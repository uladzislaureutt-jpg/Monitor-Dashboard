# Как развернуть Desktop Core 0.3

## Рекомендуемый вариант: отдельный репозиторий

Не устанавливать этот пакет в `SE-monitor`: desktop — самостоятельное приложение и не должен менять production-monitor.

1. Создать новый GitHub repository, например `Monitor-Dashboard`.
2. Распаковать `monitor-dashboard-0.3-desktop-core.zip` в корень нового repository.
3. Commit / push всех файлов.
4. Открыть `Actions` → `Build Monitor Dashboard Windows x64` → `Run workflow`.
5. После успешной сборки скачать artifact `monitor-dashboard-windows-x64`.
6. Внутри будет NSIS `.exe` installer.

## Локальная сборка на Windows

Tauri 2 требует Microsoft C++ Build Tools с workload `Desktop development with C++`, Rust stable MSVC и Node.js. На современных Windows 10/11 WebView2 уже установлен.

```powershell
npm install
npm run tauri dev
```

Для installer:

```powershell
npm run tauri build -- --bundles nsis
```

## Первый функциональный тест

После запуска приложения:

1. нажать `+ Импортировать bundle`;
2. выбрать скачанный GitHub artifact вида `dashboard-bundle-social-61.zip`;
3. в таблице должен появиться run;
4. повторно выбрать тот же ZIP;
5. приложение должно сообщить, что run уже импортирован, а счётчики `runs` и `documents` не должны увеличиться.

Начиная с exporter 0.2.3 режим должен отображаться как `dry-run` или `production`. Старый run 61 корректно покажет `не определён`, поскольку его manifest был сформирован до этой коррекции.
