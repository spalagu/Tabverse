import { isFreshRun, useStore } from "../state/store";
import { coreLog } from "../errlog";
import { THEME_SCOPE, loadState, loadStateSync } from "../persist";
import { asThemePreference, resolve } from "./resolve";
import { applyThemeVars, isThemeName, type ThemeName } from "./tokens";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** How long the backdrop IPC may stay out before it is worth a log line —
 *  callers receive this warning when switching fails. */
const IPC_GUARD_MS = 150;

/**
 * The invoke function, resolved once during initTheme. Cached because ① must
 * go out in the same synchronous tick as ② — a dynamic import at switch time
 * would push the IPC send into a microtask and open the ①—② seam.
 */
let invokeFn: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null =
  null;

let applied: ThemeName | null = null;

/** Test-only: forget the applied cache and the cached invoke. */
export function resetThemeControllerForTest(): void {
  invokeFn = null;
  applied = null;
  initialized = false;
}

export async function applyResolvedTheme(t: ThemeName): Promise<void> {
  if (applied === t) return;
  applied = t;
  // ① The window backdrop — issued, not awaited.
  const ipc = invokeFn ? invokeFn("set_theme", { theme: t }) : null;
  // ② CSS variables and [data-theme], synchronously in the same tick as ①.
  applyThemeVars(document.documentElement, t);
  if (ipc === null) return;
  const guard = setTimeout(() => {
    coreLog(
      "warn",
      `set_theme(${t}) not returned after ${IPC_GUARD_MS}ms — backdrop may lag the CSS`
    );
  }, IPC_GUARD_MS);
  try {
    await ipc;
  } catch (e) {
    coreLog("error", `set_theme(${t}) failed: ${String(e)}`);
  } finally {
    clearTimeout(guard);
  }
}

export function bootstrapTheme(): void {
  // markFreshRun has not run yet, so the demo's zero-trace rule reads the
  // same URL hook App.tsx boots from; fresh means "no state", i.e. system.
  const fresh =
    import.meta.env.DEV &&
    !isTauri() &&
    new URLSearchParams(window.location.search).has("fresh");
  const pref =
    isTauri() || fresh
      ? "system"
      : asThemePreference(
          loadStateSync<{ preference?: unknown }>(THEME_SCOPE)?.preference
        );
  const systemDark =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true;
  const boot = (window as { __TABVERSE_BOOT_THEME__?: unknown })
    .__TABVERSE_BOOT_THEME__;
  const resolved = isThemeName(boot) ? boot : resolve(pref, systemDark);
  useStore.setState({
    themePreference: pref,
    systemDark,
    resolvedTheme: resolved,
  });
  applyThemeVars(document.documentElement, resolved);
  // The controller-side cache agrees with what is on screen, so initTheme
  // re-applies only when the loaded preference actually changes the answer.
  applied = resolved;
}

let initialized = false;

export async function initTheme(): Promise<void> {
  if (initialized) return;
  initialized = true;
  // Null here is the configuration file not having been read yet — which is
  // exactly what this cold-start path exists to cover, and asThemePreference
  // is the one place that already decides what an absent preference means.
  let pref = asThemePreference(useStore.getState().themePreference);
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    invokeFn = invoke;
    try {
      pref = asThemePreference(await invoke("theme_pref_load"));
    } catch (e) {
      coreLog("error", `theme_pref_load failed: ${String(e)}`);
    }
  } else if (!isFreshRun()) {
    pref = asThemePreference(
      (await loadState<{ preference?: unknown }>(THEME_SCOPE))?.preference
    );
  }
  const store = useStore.getState();
  useStore.setState({
    themePreference: pref,
    resolvedTheme: resolve(pref, store.systemDark),
  });
  await applyResolvedTheme(resolve(pref, store.systemDark));
  // From here every resolvedTheme move — Settings or the OS — funnels
  // through the same applier. Subscribed after the explicit apply above so
  // the first application is not run twice.
  useStore.subscribe((s, prev) => {
    if (s.resolvedTheme !== prev.resolvedTheme) {
      void applyResolvedTheme(s.resolvedTheme);
    }
  });
  if (typeof window.matchMedia === "function") {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    useStore.getState().onSystemTheme(mql.matches);
    mql.addEventListener("change", (e) =>
      useStore.getState().onSystemTheme(e.matches)
    );
  }
}
