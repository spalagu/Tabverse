import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "@tabverse/workbench/sidebar.css";
import "@tabverse/workbench/new-tab.css";
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
import "../../../src/styles.css";
import App from "../../../src/App";
import { installErrorReporting } from "../../../src/errlog";
// The share capability registrations: every tab type's declaration runs
// before the first render, so the sidebar and dialog read a settled registry.
import "../../../src/share/capabilities";
import { markPlatform } from "../../../src/platform";
import { bootstrapTheme } from "../../../src/theme/themeController";

installErrorReporting();
// Before the first paint: the window-control inset it selects decides where
// the sidebar's own controls sit, and a correction after paint is a visible
// jump on every launch.
markPlatform();
// Also before the first paint: resolve the theme from what is synchronously
// knowable (stored preference in the demo, the OS appearance everywhere)
// and project it onto :root, so every stylesheet reads token-fed variables
// from the first frame. initTheme (App boot) hydrates the desktop's saved
// preference and attaches the OS listener.
bootstrapTheme();

// No StrictMode: its dev-only double-mount would spawn every PTY twice.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
