import {
  EditorTabMenu as SharedEditorTabMenu,
  type EditorTabMenuProps,
  type EditorTabMenuRuntime,
} from "@tabverse/workbench/files/editor-tab-menu";
import { fsApi, type FileMeta } from "../../backend/fs";
import { coreLog } from "../../errlog";

const runtime: EditorTabMenuRuntime = {
  copyText: async (text) => {
    if (!navigator.clipboard) {
      throw new Error("no clipboard in this context");
    }
    await navigator.clipboard.writeText(text);
  },
  reveal: fsApi.reveal,
  reportError: (action, error) => {
    coreLog("warn", `${action} failed: ${error}`);
  },
};

type DesktopEditorTabMenuProps = Omit<
  EditorTabMenuProps<FileMeta>,
  "runtime"
>;

export type { EditorTabMenuAt } from "@tabverse/workbench/files/editor-tab-menu";

export function EditorTabMenu(props: DesktopEditorTabMenuProps) {
  return <SharedEditorTabMenu {...props} runtime={runtime} />;
}
