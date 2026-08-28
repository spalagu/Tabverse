import {
  FilesWorkspacePane as SharedFilesWorkspacePane,
  type FilesWorkspacePaneProps,
  type FilesWorkspaceRenderers,
} from "@tabverse/workbench/files/workspace-pane";
import type { FileMeta } from "../../backend/fs";
import { CodeEditor } from "./CodeEditor";
import { CsvView } from "./CsvView";
import { EditorTabMenu } from "./EditorTabMenu";
import { HtmlView } from "./HtmlView";
import { InspectView } from "./InspectView";
import { LogView } from "./LogView";
import { MarkdownView } from "./MarkdownView";
import { NotebookView } from "./NotebookView";
import { Preview } from "./Preview";
import { PreviewFind } from "./PreviewFind";

const renderers = {
  CodeEditor,
  CsvView,
  EditorTabMenu,
  HtmlView,
  InspectView,
  LogView,
  MarkdownView,
  NotebookView,
  Preview,
  PreviewFind,
} satisfies FilesWorkspaceRenderers<FileMeta>;

export type DesktopFilesWorkspacePaneProps = Omit<
  FilesWorkspacePaneProps<FileMeta>,
  "renderers"
>;

export function FilesWorkspacePane(props: DesktopFilesWorkspacePaneProps) {
  return <SharedFilesWorkspacePane {...props} renderers={renderers} />;
}

export { describeFilesWorkspacePane } from "@tabverse/workbench/files/workspace-pane";
