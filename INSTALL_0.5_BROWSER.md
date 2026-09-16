# Установка Monitor 0.5 поверх 0.4.2 через браузер GitHub

## 1. Обновление desktop-репозитория

Загрузите содержимое пакета `Monitor-0.5.0-update.zip` в корень репозитория с заменой одноимённых файлов.

Новые важные файлы:

- `src/workroom.ts`
- `backend/supabase/workroom.sql`
- `docs/WORKROOM_SETUP_0.5.md`

Основные заменяемые файлы:

- `src/App.tsx`
- `src/components/WorkroomDrawer.tsx`
- `src/components/PublicationCard.tsx`
- `src/components/Charts.tsx`
- `src/i18n.tsx`
- `src/styles.css`
- `src/types.ts`
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

`.github/workflows/build-windows.yml` остаётся совместимым и не требует изменения.

## 2. Сборка

После commit запустите:

`Actions → Build Monitor Dashboard Windows x64 → Run workflow`

Установите новый NSIS installer поверх текущей версии. Локальная SQLite и импортированные run сохраняются.

## 3. Настройка общей рабочей комнаты

До настройки Supabase всё остальное приложение работает как раньше. Для сетевой комнаты выполните `docs/WORKROOM_SETUP_0.5.md`.

## 4. Важное

В desktop-приложение вводится только Project URL и **Publishable / anon key**. `service_role` key использовать в desktop-приложении нельзя.
