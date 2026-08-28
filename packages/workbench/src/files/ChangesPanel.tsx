import { useCallback, useEffect, useState } from "react";
import { STR } from "../strings";
import { describeError, type ErrorDescription } from "../strings/errors";
import { ErrorState } from "../state/ErrorState";

export type FileChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "ignored";

export interface ChangedFile {
  rel: string;
  path: string;
  status: FileChangeStatus;
}

export interface FileChangeList {
  repo: string | null;
  files: ChangedFile[];
}

const MARK: Record<FileChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
  ignored: "·",
};

const GROUP_ORDER: readonly FileChangeStatus[] = [
  "conflicted",
  "deleted",
  "modified",
  "renamed",
  "added",
  "untracked",
  "ignored",
];

export interface ChangesPanelProps {
  root: string;
  refreshToken: number;
  selected: string | null;
  loadChanges: (root: string) => Promise<FileChangeList>;
  onOpen: (path: string) => void;
}

/** Shared changed-files panel backed by an injected version-control port. */
export function ChangesPanel({
  root,
  refreshToken,
  selected,
  loadChanges,
  onOpen,
}: ChangesPanelProps) {
  const [list, setList] = useState<FileChangeList | null>(null);
  const [error, setError] = useState<ErrorDescription | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await loadChanges(root));
      setError(null);
    } catch (cause) {
      setError(describeError(cause, STR.errors.actions.readChanges));
    }
  }, [loadChanges, root]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  if (error) return <ErrorState inline error={error} />;
  if (!list) {
    return <div className="changes-empty">{STR.files.changes.reading}</div>;
  }
  if (!list.repo) {
    return <div className="changes-empty">{STR.files.changes.notRepo}</div>;
  }
  if (list.files.length === 0) {
    return <div className="changes-empty">{STR.files.changes.clean}</div>;
  }

  return (
    <div className="changes-list">
      {GROUP_ORDER.map((status) => {
        const files = list.files.filter((file) => file.status === status);
        if (files.length === 0) return null;
        return (
          <div key={status} className="change-group">
            <div className="change-group-head">
              <span className={`change-mark ${status}`}>{MARK[status]}</span>
              <span className="change-group-title">
                {STR.files.changes.group[status]}
              </span>
              <span className="change-group-count">{files.length}</span>
            </div>
            {files.map((file) => (
              <div
                key={file.path}
                className={`change-row${file.path === selected ? " active" : ""}${
                  file.status === "deleted" ? " gone" : ""
                }`}
                title={`${file.rel} — ${file.status}`}
                onClick={() => file.status !== "deleted" && onOpen(file.path)}
              >
                <span className={`change-mark ${file.status}`}>
                  {MARK[file.status]}
                </span>
                <span className="change-name">{file.rel}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
