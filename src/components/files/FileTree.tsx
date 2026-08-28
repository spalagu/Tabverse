import {
  FileTree as WorkbenchFileTree,
  type FileTreeProps,
  type FileTreeRuntime,
} from "@tabverse/workbench/files/file-tree";
import { fsApi, gitBadge } from "../../backend/fs";
import { confirmChoose } from "../Confirm";
import { isIMEComposing } from "../../localKeys";
import { formatKeys, HINT_KEYS } from "../../strings/formatKeys";
import { useStore } from "../../state/store";
import type { PaneState } from "./panes";

type InjectedProps =
  | "runtime"
  | "clipboard"
  | "setClipboard"
  | "getDraggingPaths"
  | "setDraggingPaths"
  | "badgeFor"
  | "isComposing"
  | "confirmChoice"
  | "keyHints";

type Props = Omit<FileTreeProps<PaneState>, InjectedProps>;

const runtime: FileTreeRuntime = {
  list: (dir) => fsApi.list(dir),
  transfer: (from, into, cut, overwrite) =>
    fsApi.transfer(from, into, cut, overwrite),
  trash: async (path) => {
    await fsApi.trash(path);
  },
  rename: (from, to) => fsApi.rename(from, to),
  create: (path, directory) => fsApi.create(path, directory),
  clipboardWriteFiles: (paths) => fsApi.clipboardWriteFiles(paths),
  reveal: (path) => fsApi.reveal(path),
};

const keyHints = {
  paste: formatKeys(HINT_KEYS.paste),
  copy: formatKeys(HINT_KEYS.copy),
  cut: formatKeys(HINT_KEYS.cut),
  copyPath: formatKeys(HINT_KEYS.copyPath),
};

export function FileTree(props: Props) {
  const clipboard = useStore((state) => state.fileClipboard);
  const setClipboard = useStore((state) => state.setFileClipboard);
  const resolvedTheme = useStore((state) => state.resolvedTheme);

  return (
    <WorkbenchFileTree<PaneState>
      {...props}
      runtime={runtime}
      clipboard={clipboard}
      setClipboard={setClipboard}
      getDraggingPaths={() => useStore.getState().draggingFilePaths}
      setDraggingPaths={(paths) =>
        useStore.getState().setDraggingFilePaths(paths)
      }
      badgeFor={(status) => gitBadge(status, resolvedTheme)}
      isComposing={isIMEComposing}
      confirmChoice={async (message, options) => {
        const answer = await confirmChoose(message, options);
        return options.some((option) => option.value === answer)
          ? (answer as (typeof options)[number]["value"])
          : null;
      }}
      keyHints={keyHints}
    />
  );
}
