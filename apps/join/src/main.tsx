import ReactDOM from "react-dom/client";
import { applyThemeVars } from "@tabverse/workbench/theme";
import { App } from "./App";
import { waitForHostNetworkWorker } from "./serviceWorker";
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

const root = ReactDOM.createRoot(document.getElementById("root")!);

async function start(): Promise<void> {
  try {
    if (__JOIN_PAGES_BUILD__) await waitForHostNetworkWorker();
    root.render(<App />);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown worker error";
    root.render(
      <main className="join-startup-error" role="alert">
        <h1>Tabverse Join could not start</h1>
        <p>{detail}</p>
        <p>Reload this page. If the problem continues, use a current Chromium browser.</p>
      </main>,
    );
  }
}

void start();
