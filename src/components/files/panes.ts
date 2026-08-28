import type { FileMeta } from "../../backend/fs";
import { newPane as createPane } from "@tabverse/workbench/files/panes";
import type {
  PaneFileAction as SharedPaneFileAction,
  PaneState as SharedPaneState,
} from "@tabverse/workbench/files/panes";

export type PaneState = SharedPaneState<FileMeta>;
export type PaneFileAction = SharedPaneFileAction<FileMeta>;

export type {
  NavStack,
  PaneLayout,
  TreeMode,
} from "@tabverse/workbench/files/panes";

export {
  applyPaneAction,
  closedPane,
  conflictResolvedPane,
  draftedPane,
  modeSetPane,
  navBackPane,
  navForwardPane,
  openInPane,
  paneForPath,
  pushNav,
  savedPane,
  selectionAll,
  selectionCleared,
  selectionExtended,
  selectionLanded,
  selectionToggled,
} from "@tabverse/workbench/files/panes";

export function newPane(root: string): PaneState {
  return createPane<FileMeta>(root);
}
