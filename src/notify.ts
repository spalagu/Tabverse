/**
 * "That long command finished" notifications.
 *
 * The point is the case where you started something slow and walked away, so
 * the notification has to reach the OS, not just the window you are not
 * looking at.
 */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function notifyCommandFinished(
  tabTitle: string,
  command: string,
  exitCode: number | undefined,
  ms: number
) {
  const ok = exitCode === 0 || exitCode === undefined;
  const title = ok ? `Finished in ${formatDuration(ms)}` : `Failed (exit ${exitCode})`;
  const body = `${tabTitle}: ${command}`.slice(0, 180);

  if (isTauri) {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("notify", { title, body }))
      .catch(() => {});
    return;
  }
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  } else if (Notification.permission !== "denied") {
    void Notification.requestPermission().then((p) => {
      if (p === "granted") new Notification(title, { body });
    });
  }
}
