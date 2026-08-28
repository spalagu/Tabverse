import { useStore } from "./state/store";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function toggleMute(tabId: string): void {
  const st = useStore.getState();
  const next = !st.mutedTabs[tabId];
  st.setTabMuted(tabId, next);
  if (isTauri) {
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("browser_set_muted", { tabId, muted: next }).catch(() => {})
    );
  }
}

export function reapplyMute(tabId: string): void {
  const st = useStore.getState();
  if (!st.mutedTabs[tabId]) return;
  if (isTauri) {
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("browser_set_muted", { tabId, muted: true }).catch(() => {})
    );
  }
}
