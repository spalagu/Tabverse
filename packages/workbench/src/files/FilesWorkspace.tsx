import { Fragment, type ReactNode } from "react";
import {
  FilesPanelHeader,
  FilesTreeToolbar,
  type FilesPanelHeaderProps,
  type FilesPanelMode,
  type FilesTreeMode,
  type FilesTreeToolbarProps,
} from "./FilesSidebarControls";

export interface FilesWorkspaceSidebarProps {
  panelMode: FilesPanelMode;
  treeMode: FilesTreeMode;
  header: Omit<FilesPanelHeaderProps, "panelMode">;
  toolbar: Omit<FilesTreeToolbarProps, "treeMode">;
  searchPanel: ReactNode;
  changesPanel: ReactNode;
  treeView: ReactNode;
  columnsView: ReactNode;
}

export interface FilesWorkspaceProps {
  overlays?: readonly ReactNode[];
  sidebar: FilesWorkspaceSidebarProps;
  main: ReactNode;
}

/** Shared Files shell and sidebar mode routing for desktop and web surfaces. */
export function FilesWorkspace({
  overlays = [],
  sidebar,
  main,
}: FilesWorkspaceProps) {
  const sidebarBody =
    sidebar.panelMode === "search" ? (
      sidebar.searchPanel
    ) : sidebar.panelMode === "changes" ? (
      sidebar.changesPanel
    ) : (
      <>
        <FilesTreeToolbar {...sidebar.toolbar} treeMode={sidebar.treeMode} />
        {sidebar.treeMode === "miller"
          ? sidebar.columnsView
          : sidebar.treeView}
      </>
    );

  return (
    <div className="files-view">
      {overlays.map((overlay, index) => (
        <Fragment key={index}>{overlay}</Fragment>
      ))}
      <div className="files-sidebar">
        <FilesPanelHeader {...sidebar.header} panelMode={sidebar.panelMode} />
        {sidebarBody}
      </div>
      {main}
    </div>
  );
}
