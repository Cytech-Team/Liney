import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./liney-raw-message.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);


// PWA caches only the static interface. The LINE engine and LINE data are
// always local to the user's device; no network/LINE RPC is cached by SW.
if (import.meta.env.PROD && typeof window !== "undefined" && window.location.pathname === "/app" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/liney-app-sw.js", { scope: "/app" }).catch(() => undefined);
  });
}
