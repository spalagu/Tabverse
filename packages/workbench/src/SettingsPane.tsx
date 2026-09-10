import { useEffect, useState } from "react";
import type { HostRpc } from "./hostRpc";

/** One registry row as the wire carries it (config.rs SettingRow). */
interface Row {
  key: string;
  /** "toggle" | {"number": {...}} | {"choice": {...}} | {"text": ...} */
  kind: unknown;
  section: string;
  default: unknown;
}

type PaneState =
  | { kind: "loading" }
  | { kind: "rows"; rows: Row[]; values: Record<string, unknown> }
  | { kind: "error"; line: string };

/** Walk a dotted key into the config values object, or undefined. */
function valueAt(values: Record<string, unknown>, key: string): unknown {
  let cursor: unknown = values;
  for (const part of key.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function SettingsPane({
  rpc,
  readOnly,
}: {
  rpc: HostRpc;
  readOnly: boolean;
}) {
  const [state, setState] = useState<PaneState>({ kind: "loading" });
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const readAll = () => {
    Promise.all([rpc("config_schema", null), rpc("config_get", null)])
      .then(([schema, snap]) => {
        const rows = (Array.isArray(schema) ? schema : []) as Row[];
        const values =
          typeof snap === "object" && snap !== null
            ? ((snap as { values?: unknown }).values as Record<string, unknown>) ?? {}
            : {};
        setState({ kind: "rows", rows, values });
      })
      .catch((e) => setState({ kind: "error", line: String(e) }));
  };

  useEffect(readAll, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "loading") {
    return <div className="app-share-content">Reading the host's settings…</div>;
  }
  if (state.kind === "error") {
    return <div className="app-share-content">{state.line}</div>;
  }

  const change = (row: Row, value: unknown) => {
    rpc("config_set", { key: row.key, value })
      .then(() => {
        setSavedKey(row.key);
        // Re-read: the file is the authority and the read-back is the
        // confirmation, the same contract the host's interface holds.
        readAll();
      })
      .catch(() => setSavedKey(null));
  };

  const bySection = new Map<string, Row[]>();
  for (const row of state.rows) {
    const list = bySection.get(row.section) ?? [];
    list.push(row);
    bySection.set(row.section, list);
  }

  return (
    <div className="settings-pane">
      {[...bySection.entries()].map(([section, rows]) => (
        <section key={section} className="settings-pane-section">
          <h3>{section}</h3>
          {rows.map((row) => {
            const current = valueAt(state.values, row.key);
            const kind = row.kind;
            const isToggle = kind === "toggle";
            const choice =
              typeof kind === "object" && kind !== null
                ? (kind as { choice?: { options?: string[] } }).choice
                : undefined;
            const number =
              typeof kind === "object" && kind !== null
                ? (kind as { number?: { min?: number; max?: number } }).number
                : undefined;
            return (
              <label key={row.key} className="settings-pane-row">
                <span className="settings-pane-key" title={row.key}>
                  {row.key}
                </span>
                {isToggle ? (
                  <input
                    type="checkbox"
                    checked={current === true}
                    disabled={readOnly}
                    onChange={(e) => change(row, e.target.checked)}
                  />
                ) : choice !== undefined ? (
                  <select
                    value={String(current ?? "")}
                    disabled={readOnly}
                    onChange={(e) => change(row, e.target.value)}
                  >
                    {(choice.options ?? []).map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={number !== undefined ? "number" : "text"}
                    defaultValue={current === undefined ? "" : String(current)}
                    readOnly={readOnly}
                    min={number?.min}
                    max={number?.max}
                    onBlur={(e) => {
                      const raw = e.target.value;
                      const next =
                        number !== undefined && raw !== "" ? Number(raw) : raw;
                      if (next !== current) change(row, next);
                    }}
                    className={savedKey === row.key ? "saved" : ""}
                  />
                )}
              </label>
            );
          })}
        </section>
      ))}
    </div>
  );
}
