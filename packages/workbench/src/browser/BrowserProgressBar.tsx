import { useEffect, useState, useSyncExternalStore } from "react";
import {
  bandClasses,
  prefersReducedMotion,
  progressFor,
  subscribeProgress,
} from "./progress";

export function BrowserProgressBar({ tabId }: { tabId: string }) {
  const state = useSyncExternalStore(
    (onChange) => subscribeProgress(tabId, onChange),
    () => progressFor(tabId)
  );
  const reducedMotion = useReducedMotion();
  if (state.phase === "idle") return null;
  return (
    <div className="browser-progress">
      <div
        className={bandClasses(state, { reducedMotion }).join(" ")}
        style={{ width: `${state.extent}%` }}
        // Decoration over a state the address bar and the page already
        // report; a screen reader announcing "15 percent" of a number
        // nothing measured would be worse than silence.
        aria-hidden="true"
      />
    </div>
  );
}

/** The user's motion preference, kept current if they change it mid-session. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    // Safari below 14 has no addEventListener on MediaQueryList; this app
    // ships one webview per platform, so the guard is cheap insurance.
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}
