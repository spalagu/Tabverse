import { useStore } from "../state/store";
import { STR } from "../strings";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function UserscriptAsk() {
  const ask = useStore((s) => s.userscriptAsk);
  const setAsk = useStore((s) => s.setUserscriptAsk);
  if (!ask) return null;

  const answer = async (decision: "once" | "always" | "deny") => {
    const current = ask;
    setAsk(null);
    if (!isTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    // The core advances its own queue and emits the next ask if any, so
    // this fire-and-forget is enough — no need to poll for the successor.
    await invoke("userscript_xhr_answer", {
      askId: current.askId,
      decision,
    }).catch(() => {});
  };

  return (
    <div className="overlay">
      <div className="cmdbar auth-dialog us-ask" onMouseDown={(e) => e.stopPropagation()}>
        <div className="auth-title">
          {STR.dialogs.userscript.scriptLead}{" "}
          <strong>{ask.scriptName || STR.dialogs.userscript.fallbackName}</strong>
          {STR.dialogs.userscript.wantsToReach}
          <strong>{ask.host}</strong>
        </div>
        <div className="page-dialog-message">
          {STR.dialogs.userscript.blurb}
        </div>
        <div className="auth-actions">
          <button onClick={() => void answer("deny")}>{STR.dialogs.userscript.deny}</button>
          <button onClick={() => void answer("once")}>{STR.dialogs.userscript.allowOnce}</button>
          <button className="primary" autoFocus onClick={() => void answer("always")}>
            {STR.dialogs.userscript.allowAlways}
          </button>
        </div>
      </div>
    </div>
  );
}
