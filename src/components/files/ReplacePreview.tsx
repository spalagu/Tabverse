import {
  ReplacePreviewPane as WorkbenchReplacePreviewPane,
  type ReplacePreviewEditorProps,
} from "@tabverse/workbench/files/replace-preview";
import type { ComponentType } from "react";
import type {
  ReplacePreview,
  ReplaceStamp,
  SkipSite,
} from "@tabverse/workbench/files/search-panel";
import { CodeEditor, disposeEditorState } from "./CodeEditor";

export {
  applySites,
  previewScope,
  siteKey,
} from "@tabverse/workbench/files/replace-preview";

export interface ReplacePreviewPaneProps {
  preview: ReplacePreview;
  query: string;
  replacement: string;
  busy: boolean;
  onConfirm: (skip: SkipSite[], stamps: ReplaceStamp[]) => void;
  onCancel: () => void;
}

const ReplacePreviewEditor = CodeEditor as ComponentType<ReplacePreviewEditorProps>;

/** Desktop editor adapter for the shared replace-preview workflow. */
export function ReplacePreviewPane(props: ReplacePreviewPaneProps) {
  return (
    <WorkbenchReplacePreviewPane
      {...props}
      CodeEditorComponent={ReplacePreviewEditor}
      disposeEditorState={disposeEditorState}
    />
  );
}
