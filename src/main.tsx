import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import { ModerationProvider } from "./moderation";
import { ReportProvider } from "./reportWorkspace";
import { MonitorAccessProvider } from "./access";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider><MonitorAccessProvider><ModerationProvider><ReportProvider><App /></ReportProvider></ModerationProvider></MonitorAccessProvider></I18nProvider>
  </React.StrictMode>,
);
