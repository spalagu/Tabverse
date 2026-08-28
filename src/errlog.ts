/**
 * Forward webview errors to the Rust core's stderr so desktop-side issues are
 * visible in `tauri dev` logs (the webview console is hard to reach there).
 */
export function coreLog(level: string, msg: string) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("js_log", { level, msg }))
    .catch(() => {});
}

export function installErrorReporting() {
  if (!("__TAURI_INTERNALS__" in window)) return;

  const send = (level: string, msg: string) => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("js_log", { level, msg }))
      .catch(() => {});
  };

  window.addEventListener("error", (e) => {
    send("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    send("unhandledrejection", String(e.reason?.stack ?? e.reason));
  });
  send("info", "webview booted");
}
