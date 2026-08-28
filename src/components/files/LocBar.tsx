import { LocationBar } from "@tabverse/workbench/files/location-bar";
import { fsApi } from "../../backend/fs";
import { STR } from "../../strings";
import { HINT_KEYS } from "../../strings/formatKeys";
import { recentPaths } from "./recentPaths";

export interface LocBarProps {
  root: string;
  onSubmit: (resolved: string) => void;
  onClose: () => void;
}

const listDirectories = async (dir: string) => (await fsApi.list(dir)).entries;

/** Desktop adapter for the shared location bar. */
export function LocBar(props: LocBarProps) {
  return (
    <LocationBar
      {...props}
      completionHint={STR.files.loc.completionHint({
        keys: HINT_KEYS.rightOrTab,
      })}
      listDirectories={listDirectories}
      loadHistory={recentPaths}
    />
  );
}
