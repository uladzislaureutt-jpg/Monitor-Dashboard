# Monitor 0.6.1 — Edge browser full-text corrective

Устанавливать поверх Monitor 0.6.1 с предыдущим full-text/network corrective.

## Что изменено

- цепочка догрузки полного текста: `reqwest -> Windows curl -> Microsoft Edge (headless DOM)`;
- Edge запускает страницу браузерным движком, выполняет JavaScript и передает уже сформированный DOM в существующий экстрактор;
- технические ошибки `reqwest`/`curl` не показываются пользователю, если Edge смог получить текст;
- при успешном браузерном маршруте в SQLite сохраняется `full_text_transport=desktop_windows_edge`;
- максимум 8 выбранных публикаций за операцию сохраняется; Groq не используется;
- индикатор обзора после успешного DOCX продолжает работать по логике предыдущего corrective: гаснет после экспорта и появляется снова после изменений.

## Установка

Заменить файл `src-tauri/src/fulltext.rs`, сделать commit и запустить `Build Monitor Dashboard Windows x64`.

`SE-monitor` и SQLite schema не меняются.
