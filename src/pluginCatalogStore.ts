import {
  JsonCatalogStore,
  MemoryCatalogStore,
  type AtomicCatalogStorage,
  type CatalogStore,
} from "@tabverse/plugin-kernel";

const CATALOG_SCOPE = "plugin-catalog";
const LOCAL_STORAGE_KEY = `tabverse.state.${CATALOG_SCOPE}`;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * PluginCatalog uses the same crash-safe state carrier as session data.
 * The native state_save command is an atomic replace; the browser fallback
 * is intentionally limited to the local demo profile.
 */
export function createDesktopPluginCatalogStore(): CatalogStore {
  if (!isTauriRuntime() && typeof localStorage === "undefined") {
    return new MemoryCatalogStore();
  }
  let nativeCache: string | undefined;
  const storage: AtomicCatalogStorage = {
    async read() {
      if (!isTauriRuntime()) {
        return localStorage.getItem(LOCAL_STORAGE_KEY);
      }
      if (nativeCache !== undefined) return nativeCache;
      const { invoke } = await import("@tauri-apps/api/core");
      return (await invoke<string | null>("state_load", { scope: CATALOG_SCOPE })) ?? null;
    },
    async writeAtomic(contents) {
      if (!isTauriRuntime()) {
        localStorage.setItem(LOCAL_STORAGE_KEY, contents);
        return;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("state_save", { scope: CATALOG_SCOPE, json: contents });
      nativeCache = contents;
    },
  };
  return new JsonCatalogStore(storage);
}
