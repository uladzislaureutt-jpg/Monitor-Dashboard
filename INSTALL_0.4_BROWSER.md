# Установка 0.4 через браузер GitHub

Пакет update специально не содержит `.github`, поэтому существующий рабочий workflow сборки Windows не затрагивается.

1. Распакуйте `Monitor-Dashboard-0.4.0-update.zip`.
2. В корне репозитория GitHub выберите **Add file → Upload files**.
3. Перетащите содержимое пакета с сохранением структуры `src/` и `src-tauri/` и подтвердите замену одноимённых файлов.
4. Commit changes.
5. Откройте **Actions → Build Monitor Dashboard Windows x64 → Run workflow**.

Существующую локальную SQLite удалять не требуется.
