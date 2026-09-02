import { useEffect, useState } from "react";
import type { Tab } from "../../state/store";
import { fsApi, type FileMeta } from "../../backend/fs";
import { describeError, type ErrorDescription } from "../../strings/errors";
import { STR } from "../../strings";
import { ErrorState } from "../state/ErrorState";
import { LoadingState } from "../state/LoadingState";
import { Preview } from "./Preview";

export function FilePeek({ tab }: { readonly tab: Tab }) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [error, setError] = useState<ErrorDescription | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setError(null);
    const path = tab.openPath;
    if (path === undefined) return;
    fsApi.read(path).then(
      (value) => {
        if (!cancelled) setMeta(value);
      },
      (reason) => {
        if (!cancelled) setError(describeError(reason, STR.errors.actions.readFile));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tab.openPath]);

  if (error !== null) {
    return (
      <div className="file-peek">
        <div className="file-peek-center">
          <ErrorState inline error={error} />
        </div>
      </div>
    );
  }
  if (meta === null) {
    const path = tab.openPath ?? "";
    const name = path.split("/").filter(Boolean).pop() ?? path;
    return (
      <div className="file-peek">
        <div className="file-peek-center">
          <LoadingState label={STR.files.viewers.loading({ name })} />
        </div>
      </div>
    );
  }
  return (
    <div className="file-peek">
      <Preview meta={meta} />
    </div>
  );
}
