import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { STR } from "../strings";

const PERMISSION_KINDS = [
  "camera",
  "microphone",
  "camera and microphone",
  "notifications",
];

export function PageDialog() {
  const dialog = useStore((s) => s.pageDialog);
  const setDialog = useStore((s) => s.setPageDialog);
  const unload = useStore((s) => s.unloadConfirm);
  const setUnload = useStore((s) => s.setUnloadConfirm);
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(false);
  const seenId = useRef<number | null>(null);

  useEffect(() => {
    if (dialog && dialog.dialogId !== seenId.current) {
      seenId.current = dialog.dialogId;
      setText(dialog.defaultText ?? "");
      setRemember(false);
    }
  }, [dialog]);

  if (!dialog && unload) {
    const leave = (go: boolean) => {
      setUnload(null);
      if (go) useStore.getState().closeTab(unload.tabId);
    };
    return (
      <div className="overlay">
        <div className="cmdbar auth-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <div className="auth-title">
            {STR.dialogs.page.leaveQuestion({
              title: unload.title || STR.browser.thisPage,
            })}
          </div>
          <div className="page-dialog-message">
            {STR.dialogs.page.unsavedWarning}
          </div>
          <div className="auth-actions">
            <button onClick={() => leave(false)}>{STR.dialogs.page.stay}</button>
            <button className="primary" autoFocus onClick={() => leave(true)}>
              {STR.dialogs.page.closeTab}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!dialog) return null;
  const isPermission = PERMISSION_KINDS.includes(dialog.kind);
  const isPrompt = dialog.kind === "prompt";
  const isAlert = dialog.kind === "alert";

  const answer = async (ok: boolean) => {
    const d = dialog;
    setDialog(null);
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_dialog_answer", {
      dialogId: d.dialogId,
      ok,
      text: isPrompt && ok ? text : null,
      remember: isPermission && remember,
      kind: d.kind,
    }).catch(() => {});
  };

  return (
    <div className="overlay">
      <div
        className="cmdbar auth-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="auth-title">
          {isPermission ? (
            dialog.kind === "notifications" ? (
              <>
                <strong>{dialog.origin || STR.dialogs.page.thisPage}</strong>
                {STR.dialogs.page.wantsNotifications}
              </>
            ) : (
              <>
                <strong>{dialog.origin || STR.dialogs.page.thisPage}</strong>
                {STR.dialogs.page.wantsDevice({ device: dialog.kind })}
              </>
            )
          ) : (
            <>
              {dialog.origin || STR.dialogs.page.thisPage}
              {STR.dialogs.page.says}
            </>
          )}
        </div>
        {!isPermission && <div className="page-dialog-message">{dialog.message}</div>}
        {isPrompt && (
          <input
            className="cmdbar-input"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void answer(true);
              else if (e.key === "Escape") void answer(false);
              e.stopPropagation();
            }}
          />
        )}
        {isPermission && (
          <label className="auth-save">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {STR.dialogs.page.rememberChoice({
              site: dialog.origin || STR.browser.thisSite,
            })}
          </label>
        )}
        <div className="auth-actions">
          {!isAlert && (
            <button onClick={() => void answer(false)}>
              {isPermission ? STR.dialogs.page.dontAllow : STR.common.cancel}
            </button>
          )}
          <button
            className="primary"
            autoFocus={!isPrompt}
            onClick={() => void answer(true)}
          >
            {isPermission
              ? STR.dialogs.page.allow
              : isAlert
                ? STR.common.close
                : STR.common.proceed}
          </button>
        </div>
      </div>
    </div>
  );
}
