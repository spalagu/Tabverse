import type { ReactNode } from "react";
import { FilesPathBar, type FilesPathBarProps } from "./FilesPathBar";
import type { PaneLayout } from "./panes";

export interface FilesWorkspaceLayoutProps {
  paneViews: readonly ReactNode[];
  layout: PaneLayout;
  packing: string | null;
  terminalPanel: ReactNode;
  pathBar: FilesPathBarProps;
}

/** Shared assembly for file panes, their persistent terminal, and path bar. */
export function FilesWorkspaceLayout({
  paneViews,
  layout,
  packing,
  terminalPanel,
  pathBar,
}: FilesWorkspaceLayoutProps) {
  const dual = paneViews.length === 2;
  return (
    <>
      <div className="files-mains files-workspace-layout">
        {packing && <div className="files-note">{packing}</div>}
        <div className={`panes-row${dual ? ` dual ${layout}` : ""}`}>
          {paneViews}
        </div>
        {terminalPanel}
      </div>
      <FilesPathBar {...pathBar} />
    </>
  );
}
