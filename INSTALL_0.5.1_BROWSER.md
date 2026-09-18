# Monitor 0.5.1 — установка поверх 0.5.0 через браузер GitHub

1. Распакуйте `Monitor-0.5.1-update.zip`.
2. Загрузите содержимое в корень репозитория Monitor с заменой одноимённых файлов.
3. Сделайте commit.
4. Запустите `Actions → Build Monitor Dashboard Windows x64 → Run workflow`.
5. Скачайте новый artifact и установите NSIS `.exe` поверх 0.5.0.

Локальную SQLite удалять не нужно. При первом запуске схема автоматически обновится до версии 3 (`preview_image_url`).

## Supabase

Для текущего проекта `monitor-workroom` серверная миграция профилей 0.5.1 уже применена. Повторно выполнять SQL не нужно.

Для нового/другого проекта используйте:
- `backend/supabase/workroom.sql` — полная схема 0.5.1;
- `backend/supabase/upgrade_0_5_1.sql` — обновление существующей схемы 0.5;

## Изображения

Само desktop-обновление умеет показывать `preview_image_url`, но старые bundle этого поля не содержат. Для наполнения блока «Фото из материалов» установите отдельный пакет `SE-monitor-dashboard-exporter-0.2.5-preview-images.zip` в репозиторий SE-monitor. Он меняет только отдельный dashboard-export workflow, а не `daily-social-monitor.yml`.
