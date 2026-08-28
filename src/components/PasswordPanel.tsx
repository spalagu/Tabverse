import { useCallback, useEffect, useMemo, useState } from "react";
import { confirmAsk } from "./Confirm";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { CloseIcon, TrashIcon } from "./icons";
import { ErrorState } from "./state/ErrorState";

interface Row {
  host: string;
  username: string;
}

/** A password that has been asked for, kept only while the window lives. */
type Revealed = Record<string, string>;

export function PasswordPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState<string | ErrorDescription | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [revealed, setRevealed] = useState<Revealed>({});

  const reload = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<Array<[string, string]>>("pw_list");
      setRows(list.map(([host, username]) => ({ host, username })));
    } catch (e) {
      setNote(describeError(e, STR.errors.actions.readLogins));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? rows.filter(
          (r) =>
            r.host.toLowerCase().includes(q) ||
            r.username.toLowerCase().includes(q)
        )
      : rows;
    return [...list].sort(
      (a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username)
    );
  }, [rows, filter]);

  const keyOf = (r: Row) => `${r.host}\u0001${r.username}`;

  const reveal = async (r: Row) => {
    const key = keyOf(r);
    if (revealed[key] !== undefined) {
      // Asked again means "hide it": the row is a toggle, not a one-way door.
      setRevealed(({ [key]: _gone, ...rest }) => rest);
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const secret = await invoke<string>("pw_reveal", {
        host: r.host,
        username: r.username,
      });
      setRevealed((m) => ({ ...m, [key]: secret }));
    } catch (e) {
      setNote(describeError(e, STR.errors.actions.revealPassword));
    }
  };

  const copy = async (r: Row) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const secret =
        revealed[keyOf(r)] ??
        (await invoke<string>("pw_reveal", { host: r.host, username: r.username }));
      await navigator.clipboard?.writeText(secret);
      setNote(STR.panels.passwords.copiedNote({ host: r.host }));
    } catch (e) {
      setNote(describeError(e, STR.errors.actions.copyPassword));
    }
  };

  const remove = async (host: string, username: string) => {
    // One login is still a login: gone from here means gone from the
    // machine, and there is no second copy unless the user exported one.
    if (
      !(await confirmAsk(STR.panels.passwords.forgetQuestion({ host }), {
        confirmLabel: STR.panels.passwords.forgetLabel,
      }))
    )
      return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pw_delete", { host, username }).catch((e) =>
      setNote(describeError(e, STR.errors.actions.deleteLogin))
    );
    setRows((list) => list.filter((r) => !(r.host === host && r.username === username)));
  };

  return (
    <div className="pw-window">
      <header className="pw-window-head">
        <input
          className="pw-filter"
          placeholder={STR.panels.passwords.filterPlaceholder}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        <button
          className="mini-btn"
          title={STR.common.close}
          aria-label={STR.common.close}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        <span className="pw-count">
          {/* The two numbers say different things, so both are shown while
              a filter is on: how many match, out of how many there are. */}
          {filter.trim()
            ? STR.panels.passwords.countOf({
                shown: shown.length,
                total: rows.length,
              })
            : STR.panels.passwords.countSaved({ count: rows.length })}
        </span>
      </header>

      {note &&
        (typeof note === "string" ? (
          <p className="pw-empty">{note}</p>
        ) : (
          <ErrorState inline error={note} />
        ))}

      {!loaded ? (
        <div className="loading-state-inline"><span className="loading-state">{STR.panels.passwords.reading}</span></div>
      ) : rows.length === 0 ? (
        <p className="pw-empty">{STR.panels.passwords.emptyBlurb}</p>
      ) : shown.length === 0 ? (
        <p className="pw-empty">{STR.panels.passwords.noMatch({ query: filter.trim() })}</p>
      ) : (
        <div className="pw-window-list">
          {shown.map((r) => {
            const key = keyOf(r);
            const secret = revealed[key];
            return (
              <div className="pw-row" key={key}>
                <span className="pw-host" title={r.host}>
                  {r.host}
                </span>
                <span className="pw-user" title={r.username}>
                  {r.username || STR.browser.noUsername}
                </span>
                <span className={`pw-secret${secret === undefined ? " masked" : ""}`}>
                  {secret === undefined ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : secret}
                </span>
                <span className="pw-row-actions">
                  <button
                    className="mini-btn"
                    title={
                      secret === undefined
                        ? STR.panels.passwords.showHint
                        : STR.panels.passwords.hideHint
                    }
                    onClick={() => void reveal(r)}
                  >
                    {secret === undefined
                      ? STR.panels.passwords.show
                      : STR.panels.passwords.hide}
                  </button>
                  <button
                    className="mini-btn"
                    title={STR.panels.passwords.copyHint}
                    onClick={() => void copy(r)}
                  >
                    {STR.panels.passwords.copy}
                  </button>
                  <button
                    className="mini-btn"
                    title={STR.panels.passwords.forgetHint}
                    aria-label={STR.panels.passwords.forgetHint}
                    onClick={() => void remove(r.host, r.username)}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
