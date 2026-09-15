# Установка 0.4.1 через браузер GitHub

Это обновление ставится поверх уже работающего 0.4.0.

1. Распакуйте `Monitor-Dashboard-0.4.1-update.zip`.
2. Загрузите содержимое в корень репозитория с заменой одноимённых файлов.
3. Новые файлы тоже нужно добавить:
   - `src/components/BreakdownPanel.tsx`
   - `src/components/WorkroomDrawer.tsx`
   - `src-tauri/src/sync.rs`
   - `src-tauri/migrations/0002_sync.sql`
4. Старый `src/components/TeamDrawer.tsx` можно удалить. Если он останется в репозитории, сборке не мешает, но он больше не используется.
5. Commit changes.
6. Actions → `Build Monitor Dashboard Windows x64` → Run workflow.
7. Установите новый NSIS installer поверх 0.4.0. Существующая SQLite сохраняется.

После первого запуска откройте `Данные` и настройте Auto Sync.
