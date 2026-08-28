import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { STR } from "../strings";

export function AuthDialog() {
  const req = useStore((s) => s.authRequest);
  const setReq = useStore((s) => s.setAuthRequest);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [save, setSave] = useState(false);
  const seenId = useRef<number | null>(null);

  useEffect(() => {
    if (req && req.challengeId !== seenId.current) {
      seenId.current = req.challengeId;
      // A stored credential that just failed prefills the username — the
      // password is what needs retyping.
      setUser(req.failedUsername ?? "");
      setPass("");
      setSave(false);
    }
  }, [req]);

  if (!req) return null;

  const answer = async (ok: boolean) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_auth_answer", {
      challengeId: req.challengeId,
      username: ok ? user : null,
      password: ok ? pass : null,
      save: ok && save,
    }).catch(() => {});
    setReq(null);
  };

  return (
    <div className="overlay">
      <div className="cmdbar auth-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="auth-title">
          {STR.dialogs.auth.signInLead} <strong>{req.host}</strong>
        </div>
        {req.realm && <div className="auth-realm">{req.realm}</div>}
        {req.failedUsername != null && (
          <div className="auth-failed">{STR.dialogs.auth.savedPasswordRejected}</div>
        )}
        <input
          className="cmdbar-input"
          autoFocus
          placeholder={STR.dialogs.auth.username}
          value={user}
          spellCheck={false}
          onChange={(e) => setUser(e.target.value)}
          onKeyDown={(e) => {
            // Enter drills into the password field instead of submitting
            // half a credential (round ten).
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.form
                ?.querySelector<HTMLInputElement>('input[type="password"]')
                ?.focus();
            } else if (e.key === "Escape") void answer(false);
            e.stopPropagation();
          }}
        />
        <input
          className="cmdbar-input"
          type="password"
          placeholder={STR.dialogs.auth.password}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void answer(true);
            else if (e.key === "Escape") void answer(false);
            e.stopPropagation();
          }}
        />
        <label className="auth-save">
          <input
            type="checkbox"
            checked={save}
            onChange={(e) => setSave(e.target.checked)}
          />
          {STR.dialogs.auth.rememberInKeychain}
        </label>
        <div className="auth-actions">
          <button onClick={() => void answer(false)}>{STR.common.cancel}</button>
          <button className="primary" onClick={() => void answer(true)}>
            {STR.dialogs.auth.signIn}
          </button>
        </div>
      </div>
    </div>
  );
}
