import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import { ModerationProvider } from "./moderation";
import { ReportProvider } from "./reportWorkspace";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider><ModerationProvider><ReportProvider><App /></ReportProvider></ModerationProvider></I18nProvider>
  </React.StrictMode>,
);
