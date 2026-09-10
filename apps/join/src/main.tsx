import ReactDOM from "react-dom/client";
import { applyThemeVars } from "@tabverse/workbench/theme";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
import "@tabverse/workbench/sidebar.css";
import "@tabverse/workbench/new-tab.css";
import "@tabverse/workbench/app-shell.css";
import "@tabverse/workbench/host-panes.css";
import "@tabverse/workbench/terminal/viewer.css";
import "@tabverse/workbench/terminal/workspace.css";
import "@tabverse/workbench/files/path-bar.css";
import "@tabverse/workbench/files/sidebar-controls.css";
import "@tabverse/workbench/files/changes-panel.css";
import "@tabverse/workbench/files/location-bar.css";
import "@tabverse/workbench/files/search-panel.css";
import "@tabverse/workbench/files/replace-preview.css";
import "@tabverse/workbench/files/miller-view.css";
import "@tabverse/workbench/files/file-tree.css";
import "@tabverse/workbench/files/file-preview.css";
import "@tabverse/workbench/files/preview-find.css";
import "@tabverse/workbench/files/markdown-view.css";
import "@tabverse/workbench/files/notebook-view.css";
import "@tabverse/workbench/files/html-view.css";
import "@tabverse/workbench/files/hex-view.css";
import "@tabverse/workbench/files/log-view.css";
import "@tabverse/workbench/files/sqlite-view.css";
import "@tabverse/workbench/files/font-view.css";
import "@tabverse/workbench/files/csv-view.css";
import "@tabverse/workbench/files/inspect-view.css";
import "@tabverse/workbench/files/code-editor.css";
import "@tabverse/workbench/files/editor-tab-menu.css";
import "@tabverse/workbench/files/terminal-panel.css";
import "@tabverse/workbench/files/workspace-pane.css";
import "@tabverse/workbench/files/workspace-layout.css";
import "@tabverse/workbench/files/workspace.css";
import "@tabverse/workbench/state/loading.css";
import "./join.css";

/**
 * The no-install remote-control page.
 *
 * One React source, two artifacts: the multi-file Pages site (wasm fetched
 * by content-hashed URL, service-worker cached) and the single-file offline
 * fallback (everything inlined, works from disk). Connections go through
 * iroh's public relays (browsers cannot send UDP) and stay end-to-end
 * encrypted, so the relay only ever sees ciphertext.
 */

applyThemeVars(document.documentElement, "dark");

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

// Pages build only: the service worker gives the second open its app shell
// and wasm from cache (assets are content-hashed, so cache-first is safe
// forever; the offline single-file artifact needs no cache — it IS the
// cache). Registration failing is never worth surfacing: the page works
// identically without it, just without offline speed.
if (__JOIN_PAGES_BUILD__ && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {});
  });
}
