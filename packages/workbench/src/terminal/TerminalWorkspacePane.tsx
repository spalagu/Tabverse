import type { ReactNode, RefObject } from "react";
import type { ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { ErrorState } from "../state/ErrorState";
import { LoadingState } from "../state/LoadingState";

export interface TerminalPaneBadge {
  readonly text: string;
  readonly title: string;
  readonly color?: string;
  readonly profile?: boolean;
}

export interface TerminalBlockActions {
  readonly copied: "command" | "output" | null;
  readonly canRerun: boolean;
  readonly onCopyCommand: () => void;
  readonly onCopyOutput: () => void;
  readonly onRerun: () => void;
}

export interface TerminalPullAction {
  readonly label: string;
  readonly disabled: boolean;
  readonly title?: string;
  readonly onRun: () => void;
}

export interface TerminalUploadPrompt {
  readonly host: string;
  readonly files: readonly { readonly name: string; readonly size: number }[];
  readonly destination: string;
  readonly valid: boolean;
}

export interface TerminalPastePrompt {
  readonly text: string;
  readonly lineCount: number;
}

export interface TerminalWorkspacePaneProps {
  readonly containerRef: RefObject<HTMLDivElement>;
  readonly broadcasting: boolean;
  readonly focused: boolean;
  readonly paneCount: number;
  readonly broadcastKeys: string;
  readonly hoverLink: string | null;
  readonly badge: TerminalPaneBadge | null;
  readonly transferBusy: boolean;
  readonly transferNotice: string | null;
  readonly transferError: ErrorDescription | null;
  readonly onDismissTransferError: () => void;
  readonly contextMenu: { readonly x: number; readonly y: number } | null;
  readonly onDismissContextMenu: () => void;
  readonly onToggleBroadcast: () => void;
  readonly pullAction: TerminalPullAction | null;
  readonly onOpenCwd: () => void;
  readonly blockActions: TerminalBlockActions | null;
  readonly uploadPrompt: TerminalUploadPrompt | null;
  readonly onDismissUpload: () => void;
  readonly onUploadDestinationChange: (value: string) => void;
  readonly onSubmitUpload: () => void;
  readonly pastePrompt: TerminalPastePrompt | null;
  readonly onDismissPaste: () => void;
  readonly onPasteChange: (value: string) => void;
  readonly onSubmitPaste: () => void;
  readonly completion: ReactNode;
  readonly search: ReactNode;
  readonly spawning: boolean;
  readonly allowFileTransfer: boolean;
  readonly onFilesDropped: (files: File[]) => void;
  readonly onOpenContextMenu: (x: number, y: number) => void;
  readonly onFocusPane: () => void;
  readonly onRulerPointerDown: (clientY: number) => void;
  readonly onRulerClick: (clientY: number, top: number, height: number) => void;
  readonly status: ReactNode;
}

/** Complete platform-independent DOM chrome around a desktop terminal grid. */
export function TerminalWorkspacePane({
  containerRef,
  broadcasting,
  focused,
  paneCount,
  broadcastKeys,
  hoverLink,
  badge,
  transferBusy,
  transferNotice,
  transferError,
  onDismissTransferError,
  contextMenu,
  onDismissContextMenu,
  onToggleBroadcast,
  pullAction,
  onOpenCwd,
  blockActions,
  uploadPrompt,
  onDismissUpload,
  onUploadDestinationChange,
  onSubmitUpload,
  pastePrompt,
  onDismissPaste,
  onPasteChange,
  onSubmitPaste,
  completion,
  search,
  spawning,
  allowFileTransfer,
  onFilesDropped,
  onOpenContextMenu,
  onFocusPane,
  onRulerPointerDown,
  onRulerClick,
  status,
}: TerminalWorkspacePaneProps) {
  return (
    <div
      className={`term-pane${broadcasting ? " broadcast" : ""}${badge !== null && !badge.profile ? " remote" : ""}`}
      onDragOver={(event) => {
        if (!allowFileTransfer || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!allowFileTransfer || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onFilesDropped(files);
      }}
    >
      {broadcasting && focused && (
        <div className="term-broadcast-banner" role="status">
          {STR.term.broadcasting({ count: paneCount, keys: broadcastKeys })}
        </div>
      )}
      {hoverLink !== null && (
        <div className="term-hover-link" aria-hidden="true">
          {hoverLink}
        </div>
      )}
      {badge !== null && (
        <div
          className={`term-remote-badge${badge.profile ? " profile-badge" : ""}`}
          style={badge.color === undefined ? undefined : { color: badge.color }}
          role={badge.profile ? undefined : "status"}
          title={badge.title}
        >
          {badge.text}
        </div>
      )}
      {transferBusy && (
        <div className="term-transfer-note" role="status">
          {STR.term.transferring}
        </div>
      )}
      {!transferBusy && transferNotice !== null && (
        <div className="term-transfer-note" role="status">
          {transferNotice}
        </div>
      )}
      {transferError !== null && (
        <div className="term-transfer-error" role="alert" onClick={onDismissTransferError}>
          <ErrorState inline error={transferError} />
        </div>
      )}
      {contextMenu !== null && (
        <div
          className="ctx-menu term-ctx-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className={`ctx-item${broadcasting ? " checked" : ""}`}
            onClick={onToggleBroadcast}
          >
            {broadcasting ? STR.term.broadcastOffItem : STR.term.broadcastOnItem}
          </button>
          {pullAction !== null && (
            <button
              className="ctx-item"
              disabled={pullAction.disabled}
              title={pullAction.title}
              onClick={pullAction.onRun}
            >
              {pullAction.label}
            </button>
          )}
          <button className="ctx-item" onClick={onOpenCwd}>
            {STR.term.openCwdInFiles}
          </button>
          {blockActions !== null && (
            <>
              <div className="ctx-sep" />
              <button
                className={`ctx-item${blockActions.copied === "command" ? " on" : ""}`}
                onClick={blockActions.onCopyCommand}
              >
                {blockActions.copied === "command" ? STR.term.copied : STR.term.copyCommand}
              </button>
              <button
                className={`ctx-item${blockActions.copied === "output" ? " on" : ""}`}
                onClick={blockActions.onCopyOutput}
              >
                {blockActions.copied === "output" ? STR.term.copied : STR.term.copyOutput}
              </button>
              {blockActions.canRerun && (
                <button className="ctx-item" onClick={blockActions.onRerun}>
                  {STR.term.rerun}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {uploadPrompt !== null && (
        <div className="term-upload-overlay" onMouseDown={onDismissUpload}>
          <div
            className="dialog term-upload-dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p className="dialog-title">{STR.term.uploadTitle({ host: uploadPrompt.host })}</p>
            <p className="dialog-text">{STR.term.uploadNote({ count: uploadPrompt.files.length })}</p>
            <ul className="term-upload-files">
              {uploadPrompt.files.map((file) => (
                <li key={`${file.name}:${file.size}`}>{file.name}</li>
              ))}
            </ul>
            <label className="term-upload-label" htmlFor="term-upload-dest">
              {STR.term.uploadDestLabel}
            </label>
            <input
              id="term-upload-dest"
              className="settings-input"
              spellCheck={false}
              value={uploadPrompt.destination}
              onChange={(event) => onUploadDestinationChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && uploadPrompt.valid) onSubmitUpload();
              }}
            />
            <div className="confirm-actions">
              <button className="btn" onClick={onDismissUpload}>
                {STR.common.cancel}
              </button>
              <button
                className="btn"
                disabled={transferBusy || !uploadPrompt.valid}
                onClick={onSubmitUpload}
              >
                {STR.term.uploadSubmit}
              </button>
            </div>
          </div>
        </div>
      )}
      {pastePrompt !== null && (
        <div className="term-paste-overlay" onMouseDown={onDismissPaste}>
          <div
            className="dialog term-paste-dialog"
            data-paste-preview=""
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p className="dialog-title">{STR.term.pasteTitle({ count: pastePrompt.lineCount })}</p>
            <p className="dialog-text">{STR.term.pasteNote}</p>
            <textarea
              className="term-paste-textarea"
              spellCheck={false}
              autoFocus
              aria-label={STR.term.pasteSubmit}
              value={pastePrompt.text}
              onChange={(event) => onPasteChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmitPaste();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onDismissPaste();
                }
                event.stopPropagation();
              }}
            />
            <div className="confirm-actions">
              <button className="btn" onClick={onDismissPaste}>
                {STR.common.cancel}
              </button>
              <button className="btn" onClick={onSubmitPaste}>
                {STR.term.pasteSubmit}
              </button>
            </div>
          </div>
        </div>
      )}
      {completion}
      {search}
      {spawning && (
        <div className="term-loading">
          <LoadingState inline label={STR.term.startingShell} />
        </div>
      )}
      <div
        ref={containerRef}
        className="term-container"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenContextMenu(event.clientX, event.clientY);
        }}
        onMouseDown={() => {
          if (contextMenu !== null) onDismissContextMenu();
          onFocusPane();
        }}
      />
      <div
        className="term-block-ruler-hit"
        aria-hidden="true"
        onPointerDown={(event) => onRulerPointerDown(event.clientY)}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onRulerClick(event.clientY, rect.top, rect.height);
        }}
      />
      {status}
    </div>
  );
}
