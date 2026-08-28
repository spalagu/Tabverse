import { useEffect, useRef } from "react";
import { relativePath, tabsToClose, type CloseMode } from "./editorTabs";
import { STR } from "../strings";

export interface EditorTabFile {
  path: string;
}

export interface EditorTabMenuRuntime {
  copyText: (text: string) => Promise<void>;
  reveal: (path: string) => Promise<void>;
  reportError: (action: "copy" | "reveal", error: unknown) => void;
}

/** Which editor tab was right-clicked, and where the pointer was. */
export interface EditorTabMenuAt {
  path: string;
  x: number;
  y: number;
}

export interface EditorTabMenuProps<File extends EditorTabFile = EditorTabFile> {
  at: EditorTabMenuAt;
  /** The tab strip, in the order it is drawn — "to the right" means this. */
  open: readonly File[];
  /** The explorer's directory, which is what "relative" is relative to. */
  root: string;
  /** Hand the chosen tabs over; the caller owns confirming and closing. */
  onCloseTabs: (paths: string[]) => void;
  onCompareWith?: (path: string) => void;
  onDismiss: () => void;
  runtime: EditorTabMenuRuntime;
}

/** Roughly what the box occupies, used only to keep it on screen. */
const MENU_W = 236;
const MENU_H = 292;

/**
 * Right-click menu for one editor tab: the four close scopes, plus the two
 * things people leave the window for — a path they can paste, and the file
 * in Finder.
 */
export function EditorTabMenu<File extends EditorTabFile>({
  at,
  open,
  root,
  onCloseTabs,
  onCompareWith,
  onDismiss,
  runtime,
}: EditorTabMenuProps<File>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    // A menu that outlives the window losing focus comes back as a stale
    // panel floating over whatever the user does next.
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("mousedown", onDown, { capture: true });
    window.addEventListener("blur", onDismiss);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("mousedown", onDown, { capture: true });
      window.removeEventListener("blur", onDismiss);
    };
  }, [onDismiss]);

  const rel = relativePath(root, at.path);
  const scope = (mode: CloseMode) => tabsToClose(open, at.path, mode);
  const others = scope("others");
  const right = scope("right");

  const close = (mode: CloseMode) => {
    onDismiss();
    onCloseTabs(scope(mode));
  };

  const copy = (text: string) => {
    onDismiss();
    void runtime.copyText(text).catch((error) =>
      runtime.reportError("copy", error)
    );
  };

  const x = Math.max(8, Math.min(at.x, window.innerWidth - MENU_W - 8));
  const y = Math.max(8, Math.min(at.y, window.innerHeight - MENU_H - 8));

  return (
    <div
      className="ctx-menu editor-tab-menu"
      style={{ left: x, top: y }}
      ref={ref}
    >
      <div className="ctx-title" title={at.path}>
        {rel}
      </div>
      <button className="ctx-item" onClick={() => close("this")}>
        {STR.files.editorTabMenu.close}
      </button>
      <button
        className="ctx-item"
        disabled={others.length === 0}
        onClick={() => close("others")}
      >
        {STR.files.editorTabMenu.closeOthers}
        <span className="etm-count">{others.length}</span>
      </button>
      <button
        className="ctx-item"
        disabled={right.length === 0}
        onClick={() => close("right")}
      >
        {STR.files.editorTabMenu.closeRight}
        <span className="etm-count">{right.length}</span>
      </button>
      <button className="ctx-item" onClick={() => close("all")}>
        {STR.files.editorTabMenu.closeAll}
        <span className="etm-count">{open.length}</span>
      </button>
      <div className="ctx-sep" />
      {onCompareWith && (
        <button
          className="ctx-item"
          onClick={() => {
            onDismiss();
            onCompareWith(at.path);
          }}
        >
          {STR.files.editorTabMenu.compareWith}
        </button>
      )}
      <button className="ctx-item" onClick={() => copy(at.path)}>
        {STR.files.editorTabMenu.copyPath}
      </button>
      <button className="ctx-item" onClick={() => copy(rel)}>
        {STR.files.editorTabMenu.copyRelativePath}
      </button>
      <button
        className="ctx-item"
        onClick={() => {
          onDismiss();
          void runtime
            .reveal(at.path)
            .catch((error) => runtime.reportError("reveal", error));
        }}
      >
        {STR.files.tree.revealInFinder}
      </button>
    </div>
  );
}
