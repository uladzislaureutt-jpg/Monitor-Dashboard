# Monitor 0.5.2 — установка поверх 0.5.1 через браузер GitHub

1. Распакуйте `Monitor-0.5.2-update.zip`.
2. Загрузите содержимое в корень репозитория `Monitor-Dashboard` с заменой одноимённых файлов.
3. Сделайте commit.
4. Запустите `Actions → Build Monitor Dashboard Windows x64 → Run workflow`.
5. Скачайте новый artifact и установите NSIS `.exe` поверх 0.5.1.

SQLite удалять не нужно: схема остаётся версии 3.

Пакет не содержит `.github`, поэтому существующий workflow сборки не заменяется.
