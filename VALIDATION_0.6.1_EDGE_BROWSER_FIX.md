# Validation — Monitor 0.6.1 Edge browser corrective

Проверено статически:

- Windows-only Edge fallback защищён `cfg(target_os = "windows")`;
- поиск Edge: Program Files (x86), Program Files, LocalAppData;
- отдельный временный browser profile удаляется после каждого запроса;
- Edge получает максимум один URL за выбранный материал, а вся операция ограничена 8 публикациями;
- DOM передается в существующий `extract_article_text`;
- успешный маршрут сохраняется как `desktop_windows_edge`;
- ошибки первых HTTP-транспортов не пробрасываются в UI после успешного Edge fallback;
- версия приложения и SQLite schema не изменяются.

Финальная Windows/Rust-компиляция проверяется GitHub Actions.
