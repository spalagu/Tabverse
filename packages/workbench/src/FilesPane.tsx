import { useEffect, useState } from "react";
import type { HostRpc } from "./hostRpc";

/** One fs_list entry, the fields this pane reads. */
interface ListEntry {
  name: string;
  is_dir: boolean;
}

/** The folder view for a files tab with no file open: the host's listing
 * for the tab's directory, one row per entry — the joiner's honest answer
 * to "what is this tab showing" when the answer is a folder, not a file.
 * (A host's restored files tab IS a folder view: the session keeps the
 * directory, never an open document.) */
function FolderList({ dir, rpc }: { dir: string; rpc: HostRpc }) {
  const [entries, setEntries] = useState<ListEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    rpc("fs_list", { dir })
      .then((raw) => {
        if (!alive) return;
        // FsBackend::list_dir serializes a Listing object
        // ({ dir, parent, entries, ... }), not the entries array itself.
        // Accepting the raw object as an array made every non-empty host
        // folder paint as "Empty folder" on the join page.
        const listing =
          typeof raw === "object" &&
          raw !== null &&
          Array.isArray((raw as { entries?: unknown }).entries)
            ? (raw as { entries: unknown[] }).entries
            : [];
        setEntries(
          listing.map((e) => {
            const l = e as ListEntry & { isDir?: boolean };
            return { name: l.name, is_dir: l.is_dir ?? l.isDir === true };
          }),
        );
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
    // The listing reads by directory identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);
  if (err !== null) return <div className="app-share-content">{err}</div>;
  if (entries === null)
    return <div className="app-share-content">Reading {dir}…</div>;
  return (
    <div className="files-pane">
      <div className="files-pane-head">
        <span className="files-pane-name" title={dir}>
          {dir}
        </span>
      </div>
      <div className="files-pane-list">
        {entries.length === 0 ? (
          <div className="app-share-content">Empty folder.</div>
        ) : (
          entries.map((e) => (
            <div key={e.name} className="files-pane-entry" data-dir={e.is_dir}>
              {e.is_dir ? "▸ " : ""}
              {e.name}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
/** The fs_read answer's shape, the fields this pane reads. */
interface ReadMeta {
  name: string;
  size: number;
  text: string | null;
  truncated: boolean;
  read_only_reason: string | null;
}

type PaneState =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "file"; meta: ReadMeta }
  | { kind: "error"; line: string };

export function FilesPane({
  path,
  dir,
  rpc,
  readOnly,
}: {
  /** The file the host's files tab fronts, or null when none does. */
  path: string | null;
  /** The tab's directory: what the folder view lists when no file
 * fronts (the host's own restored state is exactly this). */
  dir: string | null;
  rpc: HostRpc;
  /** View level: the editor is inert and Save is absent. */
  readOnly: boolean;
}) {
  const [state, setState] = useState<PaneState>({ kind: "idle" });
  // The working copy; reset whenever a new file's read lands.
  const [text, setText] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  useEffect(() => {
    if (path === null) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading", path });
    setSaveState("idle");
    rpc("fs_read", { path })
      .then((raw) => {
        if (cancelled) return;
        const meta = raw as ReadMeta;
        setState({ kind: "file", meta });
        setText(meta.text ?? "");
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ kind: "error", line: String(e) });
      });
    return () => {
      cancelled = true;
    };
    // The pane reads by path: a new file is a new read, an rpc identity
    // change mid-path would only duplicate the same call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  if (path === null) {
    if (dir !== null && dir !== "") return <FolderList dir={dir} rpc={rpc} />;
    return (
      <div className="app-share-content">The host has no file open in this tab.</div>
    );
  }
  if (state.kind === "idle" || state.kind === "loading") {
    return <div className="app-share-content">Reading {path}…</div>;
  }
  if (state.kind === "error") {
    return <div className="app-share-content">{state.line}</div>;
  }
  const { meta } = state;
  const dirty = text !== (meta.text ?? "");

  const save = () => {
    setSaveState("saving");
    rpc("fs_write", { path, content: text })
      .then(() => setSaveState("saved"))
      .catch(() => setSaveState("failed"));
  };

  return (
    <div className="files-pane">
      <div className="files-pane-head">
        <span className="files-pane-name" title={path}>
          {meta.name}
        </span>
        {meta.truncated && (
          <span className="files-pane-flag" title="Only part of this file was read">
            truncated
          </span>
        )}
        {!readOnly && !meta.truncated && meta.read_only_reason === null && dirty && (
          <button
            type="button"
            className="files-pane-save"
            onClick={save}
            disabled={saveState === "saving"}
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved"
                : saveState === "failed"
                  ? "Retry save"
                  : "Save"}
          </button>
        )}
      </div>
      {meta.read_only_reason !== null ? (
        <div className="app-share-content">{meta.read_only_reason}</div>
      ) : meta.text === null ? (
        <div className="app-share-content">
          {meta.name} is not a text file ({meta.size} bytes) — the join view
          shows text only.
        </div>
      ) : (
        <textarea
          className="files-pane-text"
          value={text}
          readOnly={readOnly || meta.truncated}
          onChange={(e) => {
            setText(e.target.value);
            setSaveState("idle");
          }}
          spellCheck={false}
        />
      )}
    </div>
  );
}
