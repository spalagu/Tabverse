import { STR } from "../strings";

export interface PathSegment {
  label: string;
  path: string;
}

/** Split an absolute path into the directory prefixes shown by the path bar. */
export function pathSegments(root: string): PathSegment[] {
  const segments: PathSegment[] = [{ label: "/", path: "/" }];
  let prefix = "";
  for (const part of root.split("/").filter(Boolean)) {
    prefix += `/${part}`;
    segments.push({ label: part, path: prefix });
  }
  return segments;
}

export interface FilesPathBarProps {
  paneCount: number;
  activePane: number;
  root: string;
  branch: string | null;
  showHidden: boolean;
  onActivePaneChange: (pane: number) => void;
  onRootChange: (root: string) => void;
  onShowHiddenChange: (showHidden: boolean) => void;
}

/** Shared file-workspace path navigation and active-pane presentation. */
export function FilesPathBar({
  paneCount,
  activePane,
  root,
  branch,
  showHidden,
  onActivePaneChange,
  onRootChange,
  onShowHiddenChange,
}: FilesPathBarProps) {
  return (
    <div className="files-pathbar">
      {paneCount === 2 &&
        Array.from({ length: paneCount }, (_, pane) => (
          <button
            key={pane}
            className={`mini-btn pane-chip${pane === activePane ? " on" : ""}`}
            aria-pressed={pane === activePane}
            aria-label={STR.files.pathBar.paneHint({ n: pane + 1 })}
            title={STR.files.pathBar.paneHint({ n: pane + 1 })}
            onClick={() => onActivePaneChange(pane)}
          >
            {pane + 1}
          </button>
        ))}
      {pathSegments(root).map((segment, index, all) => (
        <span key={segment.path} className="path-step">
          {index > 0 && <span className="path-sep">/</span>}
          <button
            className={`path-seg${index === all.length - 1 ? " tail" : ""}`}
            title={STR.files.pathBar.jumpHint({ dir: segment.path })}
            onClick={() => onRootChange(segment.path)}
          >
            {segment.label}
          </button>
        </span>
      ))}
      <span className="path-tail" />
      <span className="pathbar-side">
        {branch && (
          <span className="branch" title={STR.files.pathBar.branchHint}>
            ⎇ {branch}
          </span>
        )}
        <button
          className={`mini-btn${showHidden ? " on" : ""}`}
          title={
            showHidden
              ? STR.files.view.hideDotfilesHint
              : STR.files.view.showDotfilesHint
          }
          onClick={() => onShowHiddenChange(!showHidden)}
        >
          .*
        </button>
      </span>
    </div>
  );
}
