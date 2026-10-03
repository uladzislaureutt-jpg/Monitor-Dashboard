# Monitor Browser Import — Chrome / Edge

Browser Import lets an operator send the article currently open in Chrome or Edge
directly to the L-Monitor report editor. The extension reads the DOM already visible
to the operator, so it can also work with pages opened after login/subscription.

## Install

1. Build/download Monitor 0.7.15 or later and install it.
2. In the build artifact, extract the `browser-extension` folder.
3. Chrome: open `chrome://extensions`.
   Edge: open `edge://extensions`.
4. Enable Developer mode.
5. Choose **Load unpacked** / **Загрузить распакованное расширение**.
6. Select the extracted `browser-extension` folder.

No store publication is required. The extension contains no remote code.

## Use

1. Start Monitor Desktop.
2. Open the needed publication in Chrome/Edge.
3. Click the **Monitor Browser Import** extension.
4. Click **Передать в Monitor**.
5. Return to **L-Monitor → Редактор обзора**.
6. Click **Получить из браузера**.
7. Review the automatically filled title, source, URL and text, add/correct the
   source country if needed, then click **Добавить в обзор**.

## Privacy and transport

The extension sends the extracted article only to
`http://127.0.0.1:17842/import` on the same computer. The Desktop bridge listens
only on loopback and accepts imports only from a `chrome-extension://` origin.
No cloud service is involved.

## Extraction

The extension prefers `article`, then `main`, then the page body. It removes
common navigation, advertisement, sharing, form and comment elements and joins
paragraphs. This is intentionally local and lightweight; the operator must review
the preview before adding it to the report.
