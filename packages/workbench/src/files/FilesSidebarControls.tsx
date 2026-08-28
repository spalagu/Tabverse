import { useState } from "react";
import { STR } from "../strings";

export type FilesPanelMode = "tree" | "search" | "changes";
export type FilesTreeMode = "tree" | "miller";
export type FilesSortKey = "name" | "kind" | "size" | "modified";
export type FilesPaneLayout = "row" | "column";

export interface FilesSortSpec {
  key: FilesSortKey;
  asc: boolean;
  dirsFirst: boolean;
}

export interface FilesPanelHeaderProps {
  root: string;
  panelMode: FilesPanelMode;
  canGoBack: boolean;
  canGoForward: boolean;
  parentLabel: string;
  onBack: () => void;
  onForward: () => void;
  onParent: () => void;
  onPanelModeChange: (mode: FilesPanelMode) => void;
}

/** Shared navigation and mode controls above the file sidebar. */
export function FilesPanelHeader({
  root,
  panelMode,
  canGoBack,
  canGoForward,
  parentLabel,
  onBack,
  onForward,
  onParent,
  onPanelModeChange,
}: FilesPanelHeaderProps) {
  const modes = [
    ["tree", STR.files.view.modeFiles, STR.files.view.modeFilesHint],
    ["search", STR.files.view.modeFind, STR.files.view.modeFindHint],
    ["changes", STR.files.view.modeChanges, STR.files.view.modeChangesHint],
  ] as const;
  return (
    <div className="panel-head">
      <button
        className="crumb-up"
        disabled={!canGoBack}
        title={STR.files.nav.backHint}
        aria-label={STR.files.nav.backHint}
        onClick={onBack}
      >
        ‹
      </button>
      <button
        className="crumb-up"
        disabled={!canGoForward}
        title={STR.files.nav.forwardHint}
        aria-label={STR.files.nav.forwardHint}
        onClick={onForward}
      >
        ›
      </button>
      <button
        className="crumb-up"
        title={STR.files.view.parentDirHint}
        aria-label={STR.files.view.parentDirHint}
        disabled={root === "/"}
        onClick={onParent}
      >
        {parentLabel}
      </button>
      <span className="panel-root">
        {root.split("/").filter(Boolean).pop() || "/"}
      </span>
      <span className="panel-modes">
        {modes.map(([mode, label, title]) => (
          <button
            key={mode}
            className={`mini-btn${panelMode === mode ? " on" : ""}`}
            title={title}
            aria-pressed={panelMode === mode}
            onClick={() => onPanelModeChange(mode)}
          >
            {label}
          </button>
        ))}
      </span>
    </div>
  );
}

export interface FilesTreeToolbarProps {
  sort: FilesSortSpec;
  treeMode: FilesTreeMode;
  dual: boolean;
  layout: FilesPaneLayout;
  ascendingLabel: string;
  descendingLabel: string;
  onSortChange: (sort: FilesSortSpec) => void;
  onTreeModeChange: (mode: FilesTreeMode) => void;
  onDualChange: (dual: boolean) => void;
  onLayoutChange: (layout: FilesPaneLayout) => void;
}

function sortKeyLabel(key: FilesSortKey): string {
  switch (key) {
    case "name":
      return STR.files.sortBar.keyName;
    case "kind":
      return STR.files.sortBar.keyKind;
    case "size":
      return STR.files.sortBar.keySize;
    case "modified":
      return STR.files.sortBar.keyModified;
  }
}

/** Shared listing, ordering, and dual-pane controls above the file tree. */
export function FilesTreeToolbar({
  sort,
  treeMode,
  dual,
  layout,
  ascendingLabel,
  descendingLabel,
  onSortChange,
  onTreeModeChange,
  onDualChange,
  onLayoutChange,
}: FilesTreeToolbarProps) {
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortKeys: readonly FilesSortKey[] = [
    "name",
    "kind",
    "size",
    "modified",
  ];
  return (
    <div className="tree-bar">
      <button
        className={`mini-btn sort-chip${sortMenuOpen ? " on" : ""}`}
        title={STR.files.sortBar.sortHint}
        aria-expanded={sortMenuOpen}
        onClick={() => setSortMenuOpen((open) => !open)}
      >
        {sortKeyLabel(sort.key)}
        <span className="sort-dir">
          {sort.asc ? ascendingLabel : descendingLabel}
        </span>
      </button>
      <span
        className="tree-bar-group"
        role="group"
        aria-label={STR.files.viewSwitch.hint}
      >
        {(
          [
            ["tree", STR.files.viewSwitch.tree],
            ["miller", STR.files.viewSwitch.columns],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            className={`mini-btn${treeMode === mode ? " on" : ""}`}
            title={STR.files.viewSwitch.hint}
            aria-pressed={treeMode === mode}
            onClick={() => onTreeModeChange(mode)}
          >
            {label}
          </button>
        ))}
      </span>
      <span className="toolbar-spacer" />
      <span className="tree-bar-group pane-bar">
        <button
          className={`mini-btn${dual ? " on" : ""}`}
          title={STR.files.panes.dualHint}
          aria-pressed={dual}
          onClick={() => onDualChange(!dual)}
        >
          {STR.files.panes.dual}
        </button>
        {dual && (
          <button
            className="mini-btn"
            title={STR.files.panes.layoutHint}
            onClick={() =>
              onLayoutChange(layout === "row" ? "column" : "row")
            }
          >
            {layout === "row"
              ? STR.files.panes.layoutRow
              : STR.files.panes.layoutColumn}
          </button>
        )}
      </span>
      {sortMenuOpen && (
        <>
          <div
            className="sort-menu-scrim"
            onMouseDown={() => setSortMenuOpen(false)}
          />
          <div className="ctx-menu sort-menu">
            <div className="ctx-label">{STR.files.sortBar.sortHint}</div>
            {sortKeys.map((key) => (
              <button
                key={key}
                className={`ctx-item${sort.key === key ? " on" : ""}`}
                onClick={() =>
                  onSortChange(sort.key === key ? sort : { ...sort, key })
                }
              >
                {sort.key === key ? "✓ " : ""}
                {sortKeyLabel(key)}
              </button>
            ))}
            <button
              className={`ctx-item${!sort.asc ? " on" : ""}`}
              onClick={() => onSortChange({ ...sort, asc: !sort.asc })}
            >
              {sort.asc
                ? STR.files.sortBar.ascending
                : STR.files.sortBar.descending}
            </button>
            <button
              className={`ctx-item${sort.dirsFirst ? " on" : ""}`}
              onClick={() =>
                onSortChange({ ...sort, dirsFirst: !sort.dirsFirst })
              }
            >
              {sort.dirsFirst ? "✓ " : ""}
              {STR.files.sortBar.dirsFirst}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
