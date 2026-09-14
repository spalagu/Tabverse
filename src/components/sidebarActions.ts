import { coreLog } from "../errlog";
import { useStore } from "../state/store";

/** Send reset to the specified native page, never the formerly active page. */
export async function resetPinnedTab(id: string): Promise<void> {
  const state = useStore.getState();
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || tab.type !== "browser" || tab.dormant || !tab.groupId || !tab.pinnedUrl) return;
  state.activateTab(id);
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("browser_navigate", { tabId: id, action: "go", url: tab.pinnedUrl });
    } catch (error) { coreLog("error", `Could not reset pinned tab ${id}: ${String(error)}`); }
  } else useStore.getState().setTabUrl(id, tab.pinnedUrl);
}
