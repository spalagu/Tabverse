import { useEffect, useState } from "react";
import { confirmAsk } from "./Confirm";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "./state/ErrorState";
import { USERSCRIPTS_SECTION_ID } from "./settingsSections";
import { TrashIcon } from "./icons";
import {
  UserscriptUpdateDialog,
  type UserscriptUpdateProposal,
} from "./UserscriptUpdateDialog";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Mirrors `ScriptInfo` in src-tauri/src/userscripts.rs. */
interface ScriptInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  runAt: string;
  matches: string[];
  includes: string[];
  excludes: string[];
  grants: string[];
  grantedHosts: string[];
  /** The URL an update check is pinned to; null for file/paste installs. */
  installUrl: string | null;
}

/** Mirrors `UpdateCheckResult` in src-tauri/src/userscripts.rs. */
interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  newVersion: string;
  currentSource: string | null;
  newSource: string | null;
}

export function UserScriptsSection() {
  const [scripts, setScripts] = useState<ScriptInfo[] | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | ErrorDescription | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<UserscriptUpdateProposal | null>(null);
  const [applying, setApplying] = useState(false);

  const reload = async () => {
    if (!isTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<ScriptInfo[]>("userscripts_list")
      .then(setScripts)
      .catch(() => setScripts([]));
  };

  useEffect(() => {
    void reload();
  }, []);


  const installUrl = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setBusy(true);
    setNote(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<ScriptInfo>("userscript_install_url", {
        url: trimmed,
      });
      setNote(`Installed “${info.name}” ${info.version}.`);
      setUrl("");
      await reload();
    } catch (e) {
      setNote(describeError(e, STR.errors.actions.installScript));
    } finally {
      setBusy(false);
    }
  };

  const installFile = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      filters: [
        {
          name: STR.settings.userscripts.fileFilterName,
          extensions: ["js", "user.js", "txt"],
        },
      ],
    });
    if (typeof path !== "string") return;
    setBusy(true);
    setNote(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<ScriptInfo>("userscript_install_file", { path });
      setNote(`Installed “${info.name}” ${info.version}.`);
      await reload();
    } catch (e) {
      setNote(describeError(e, STR.errors.actions.installScript));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: ScriptInfo) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("userscript_set_enabled", {
      scriptId: s.id,
      enabled: !s.enabled,
    }).catch((e) => setNote(describeError(e, STR.errors.actions.updateScript)));
    await reload();
  };

  const remove = async (s: ScriptInfo) => {
    if (
      !(await confirmAsk(
        STR.settings.userscripts.removeQuestion({ name: s.name }),
        { confirmLabel: STR.settings.userscripts.remove }
      ))
    )
      return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("userscript_remove", { scriptId: s.id }).catch((e) =>
      setNote(describeError(e, STR.errors.actions.removeScript))
    );
    await reload();
  };

  const revoke = async (s: ScriptInfo, host: string) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("userscript_revoke_grant", { scriptId: s.id, host }).catch(
      (e) => setNote(describeError(e, STR.errors.actions.revokeGrant))
    );
    await reload();
  };

  const checkUpdate = async (s: ScriptInfo) => {
    if (!s.installUrl) return;
    setCheckingId(s.id);
    setNote(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<UpdateCheckResult>("userscript_check_update", {
        scriptId: s.id,
      });
      if (!res.available) {
        setNote(STR.settings.userscripts.upToDate({ name: s.name }));
        return;
      }
      setProposal({
        scriptId: s.id,
        name: s.name,
        currentVersion: res.currentVersion,
        newVersion: res.newVersion,
        currentSource: res.currentSource ?? "",
        newSource: res.newSource ?? "",
        installUrl: s.installUrl,
      });
    } catch (e) {
      setNote(describeError(e, STR.errors.actions.checkScriptUpdate));
    } finally {
      setCheckingId(null);
    }
  };

  const applyUpdate = async (p: UserscriptUpdateProposal): Promise<boolean> => {
    setApplying(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("userscript_apply_update", {
        scriptId: p.scriptId,
        source: p.newSource,
      });
      setNote(
        STR.settings.userscripts.update.applied({
          name: p.name,
          version: p.newVersion,
        })
      );
      setProposal(null);
      await reload();
      return true;
    } catch (e) {
      setNote(describeError(e, STR.errors.actions.updateScript));
      return false;
    } finally {
      setApplying(false);
    }
  };

  // The match surface, summarized: what a person scanning the list needs to
  // know is roughly where a script runs, not the exact glob grammar.
  const matchSummary = (s: ScriptInfo): string => {
    const all = [...s.matches, ...s.includes];
    if (all.length === 0) return STR.settings.userscripts.matchesNothing;
    const head = all.slice(0, 2).join(", ");
    const more = all.length > 2 ? ` +${all.length - 2} more` : "";
    const ex = s.excludes.length ? `, except ${s.excludes.length}` : "";
    return `${head}${more}${ex}`;
  };

  return (
    // The anchor id comes from the settings section list, not a literal, so
    // this section is addressable by `settings:userscripts` on the same
    // terms as the twelve that live inside SettingsView.
    <section id={USERSCRIPTS_SECTION_ID}>
      <h3>{STR.settings.userscripts.heading}</h3>
      <p>{STR.settings.userscripts.blurb}</p>
      {proposal !== null && (
        <UserscriptUpdateDialog
          proposal={proposal}
          busy={applying}
          onApply={applyUpdate}
          onCancel={() => !applying && setProposal(null)}
        />
      )}

      {!isTauri ? (
        <p className="pw-empty">{STR.settings.userscripts.demoNote}</p>
      ) : (
        <>
          <div className="btn-row">
            <input
              className="settings-input"
              spellCheck={false}
              placeholder={STR.settings.userscripts.urlPlaceholder}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void installUrl();
              }}
            />
            <button className="btn" disabled={busy} onClick={() => void installUrl()}>
              {busy
                ? STR.settings.userscripts.working
                : STR.settings.userscripts.installFromUrl}
            </button>
            <button className="btn" disabled={busy} onClick={() => void installFile()}>
              {STR.settings.userscripts.installFromFile}
            </button>
          </div>
          {note &&
            (typeof note === "string" ? (
              <p className="pw-empty">{note}</p>
            ) : (
              <ErrorState inline error={note} />
            ))}

          {scripts === null ? (
            <p className="pw-empty">{STR.settings.userscripts.reading}</p>
          ) : scripts.length === 0 ? (
            <p className="pw-empty">
              {STR.settings.userscripts.noneInstalled}
            </p>
          ) : (
            <table className="pw-table">
              <tbody>
                {scripts.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>{" "}
                      <span className="pw-empty">
                        {STR.settings.userscripts.version({
                          version: s.version,
                        })}
                      </span>
                      <div className="pw-empty">
                        {STR.settings.userscripts.matchLine({
                          summary: matchSummary(s),
                          runAt: s.runAt,
                        })}
                      </div>
                      {s.grantedHosts.length > 0 && (
                        <div className="pw-empty">
                          {STR.settings.userscripts.allowedDomains}{" "}
                          {s.grantedHosts.map((h) => (
                            <span key={h} className="us-grant">
                              {h}
                              <button
                                className="us-grant-x"
                                title={STR.settings.userscripts.revokeHint({
                                  host: h,
                                })}
                                aria-label={STR.settings.userscripts.revokeHint({
                                  host: h,
                                })}
                                onClick={() => void revoke(s, h)}
                              >
                                <TrashIcon size={10} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="btn-row">
                        <button
                          className={`btn${s.enabled ? " active" : ""}`}
                          onClick={() => void toggle(s)}
                        >
                          {s.enabled
                            ? STR.settings.userscripts.on
                            : STR.settings.userscripts.off}
                        </button>
                        <button
                          className="btn"
                          disabled={!s.installUrl || checkingId !== null}
                          title={
                            s.installUrl ?? STR.settings.userscripts.checkNoSource
                          }
                          onClick={() => void checkUpdate(s)}
                        >
                          {checkingId === s.id
                            ? STR.settings.userscripts.checkingUpdate
                            : STR.settings.userscripts.checkForUpdate}
                        </button>
                        <button className="btn" onClick={() => void remove(s)}>
                          {STR.settings.userscripts.remove}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
