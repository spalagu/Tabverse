import {
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { STR } from "../strings";
import {
  describeError,
  type ErrorDescription,
} from "../strings/errors";
import { ErrorState } from "../state/ErrorState";
import { LoadingState } from "../state/LoadingState";
import {
  draftedPane,
  type PaneFile,
  type PaneState,
} from "./panes";
import type {
  EditorTabMenuAt,
  EditorTabMenuProps,
} from "./EditorTabMenu";

export type FilesWorkspaceRenderKind =
  | "markdown"
  | "csv"
  | "tsv"
  | "html"
  | "notebook";

export interface FilesWorkspaceFile extends PaneFile {
  name: string;
  size: number;
  kind:
    | "text"
    | "image"
    | "pdf"
    | "audio"
    | "video"
    | "document"
    | "archive"
    | "binary";
  mime: string;
  text: string | null;
  truncated: boolean;
  readOnlyReason: string | null;
  headText: string | null;
}

export interface FilesWorkspaceBadge {
  color: string;
  letter: string;
  label: string;
}

export interface FilesWorkspaceComparison<File extends FilesWorkspaceFile> {
  a: string;
  b: File;
}

export interface FilesWorkspaceKeyHints {
  save: string;
  quickOpen: string;
  locationBar: string;
  terminalPanel: string;
}

export interface FilesWorkspaceCodeEditorProps {
  path: string;
  value: string;
  original?: string | null;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  revealLine?: number | null;
}

export interface FilesWorkspacePreviewFindProps {
  container: HTMLElement | null;
  isolated: boolean;
  onSearchSource: (term: string) => void;
  onClose: () => void;
}

export interface FilesWorkspaceRenderers<File extends FilesWorkspaceFile> {
  CodeEditor: ComponentType<FilesWorkspaceCodeEditorProps>;
  Preview: ComponentType<{ meta: File }>;
  PreviewFind: ComponentType<FilesWorkspacePreviewFindProps>;
  InspectView: ComponentType<{ meta: File }>;
  MarkdownView: ComponentType<{ path: string; text: string }>;
  CsvView: ComponentType<{
    text: string;
    delimiter: "," | "\t";
    onEdit?: (text: string) => void;
  }>;
  HtmlView: ComponentType<{
    path: string;
    text: string;
    onOpenInBrowser: () => void;
  }>;
  NotebookView: ComponentType<{ text: string }>;
  LogView: ComponentType<{ meta: File }>;
  EditorTabMenu: ComponentType<Omit<EditorTabMenuProps<File>, "runtime">>;
}

export interface FilesWorkspaceDescriptor<File extends FilesWorkspaceFile> {
  sel: File | null;
  ext: string;
  renderKind: FilesWorkspaceRenderKind | undefined;
  isCert: boolean;
  isScript: boolean;
  viewMode: string;
  inSource: boolean;
  showInspect: boolean;
  showSplit: boolean;
  showRendered: boolean;
  isBigText: boolean;
  draftText: string;
  conflicted: boolean;
  canDiff: boolean;
  dirty: boolean;
}

const RENDERABLE: Record<string, FilesWorkspaceRenderKind> = {
  md: "markdown",
  markdown: "markdown",
  csv: "csv",
  tsv: "tsv",
  html: "html",
  htm: "html",
  ipynb: "notebook",
};

const CERT_EXTS = new Set(["pem", "crt", "cer", "der", "csr", "key"]);

function fileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export function describeFilesWorkspacePane<File extends FilesWorkspaceFile>(
  pane: PaneState<File>
): FilesWorkspaceDescriptor<File> {
  const sel = pane.open.find((file) => file.path === pane.activePath) ?? null;
  const ext = sel ? fileExt(sel.name) : "";
  const renderKind = sel?.kind === "text" ? RENDERABLE[ext] : undefined;
  const isCert = !!sel && CERT_EXTS.has(ext);
  const isScript =
    !!sel && sel.kind === "text" && sel.mime === "text/x-shellscript";
  const viewMode = sel
    ? pane.viewModes.get(sel.path) ?? (isScript ? "source" : "preview")
    : "preview";
  const inSource = viewMode === "source";

  return {
    sel,
    ext,
    renderKind,
    isCert,
    isScript,
    viewMode,
    inSource,
    showInspect: (isCert || isScript) && !inSource,
    showSplit: !isCert && renderKind === "markdown" && viewMode === "split",
    showRendered:
      !isCert && !inSource && !!renderKind && viewMode === "preview",
    isBigText:
      !!sel &&
      sel.kind === "text" &&
      sel.truncated &&
      !renderKind &&
      !isCert,
    draftText: sel ? pane.drafts.get(sel.path) ?? sel.text ?? "" : "",
    conflicted: !!sel && pane.conflicts.has(sel.path),
    canDiff: sel?.kind === "text" && typeof sel.headText === "string",
    dirty:
      !!sel &&
      pane.drafts.get(sel.path) !== undefined &&
      pane.drafts.get(sel.path) !== (sel.text ?? ""),
  };
}

export interface FilesWorkspacePaneProps<File extends FilesWorkspaceFile> {
  pane: PaneState<File>;
  active: boolean;
  missing: ReadonlySet<string>;
  comparison: FilesWorkspaceComparison<File> | null;
  restored: boolean;
  error: string | ErrorDescription | null;
  saving: boolean;
  showDiff: boolean;
  findOpen: boolean;
  revealLine: number | null;
  terminalOpen: boolean;
  containerRef: RefObject<HTMLDivElement>;
  keyHints: FilesWorkspaceKeyHints;
  formatSize: (bytes: number) => string;
  badgeFor: (file: File) => FilesWorkspaceBadge | null;
  renderers: FilesWorkspaceRenderers<File>;
  onActivate: () => void;
  onPaneChange: (change: (pane: PaneState<File>) => PaneState<File>) => void;
  onCloseFile: (path: string) => void;
  onCloseTabs: (paths: string[]) => void;
  onCompareWith: (path: string) => void;
  onCloseCompare: () => void;
  onSave: (file: File) => void;
  onResolveConflict: (path: string, keepDraft: boolean) => void;
  onModeChange: (mode: string) => void;
  onShowDiffChange: (show: boolean) => void;
  onTerminalOpenChange: (open: boolean) => void;
  onErrorChange: (error: string | ErrorDescription | null) => void;
  onFindOpenChange: (open: boolean) => void;
  onReveal: (path: string) => void;
  onOpenHtmlInBrowser: (path: string) => void;
}

export function FilesWorkspacePane<File extends FilesWorkspaceFile>({
  pane,
  active,
  missing,
  comparison,
  restored,
  error,
  saving,
  showDiff,
  findOpen,
  revealLine,
  terminalOpen,
  containerRef,
  keyHints,
  formatSize,
  badgeFor,
  renderers,
  onActivate,
  onPaneChange,
  onCloseFile,
  onCloseTabs,
  onCompareWith,
  onCloseCompare,
  onSave,
  onResolveConflict,
  onModeChange,
  onShowDiffChange,
  onTerminalOpenChange,
  onErrorChange,
  onFindOpenChange,
  onReveal,
  onOpenHtmlInBrowser,
}: FilesWorkspacePaneProps<File>) {
  const {
    CodeEditor,
    Preview,
    PreviewFind,
    InspectView,
    MarkdownView,
    CsvView,
    HtmlView,
    NotebookView,
    LogView,
    EditorTabMenu,
  } = renderers;
  const [tabMenu, setTabMenu] = useState<EditorTabMenuAt | null>(null);
  const descriptor = describeFilesWorkspacePane(pane);
  const selected = descriptor.sel;
  const badge = selected ? badgeFor(selected) : null;

  const dirtyFor = (path: string): boolean => {
    const meta = pane.open.find((file) => file.path === path);
    if (!meta) return false;
    const draft = pane.drafts.get(path);
    return draft !== undefined && draft !== (meta.text ?? "");
  };

  const terminalToggle = (
    <button
      className={`mini-btn${terminalOpen ? " on" : ""}`}
      onClick={() => onTerminalOpenChange(!terminalOpen)}
      title={(terminalOpen
        ? STR.files.view.hideShellHint
        : STR.files.view.openShellHint)({ keys: keyHints.terminalPanel })}
    >
      {STR.files.view.terminalToggle}
    </button>
  );

  const comparisonIsOpen =
    comparison !== null && pane.open.some((file) => file.path === comparison.a);

  return (
    <div
      className={`files-main files-workspace-pane${active ? " active" : ""}`}
      ref={active ? containerRef : undefined}
      onMouseDown={() => {
        if (!active) onActivate();
      }}
    >
      {pane.open.length > 0 && (
        <div className="editor-tabs">
          {pane.open.map((file) => (
            <div
              key={file.path}
              className={`editor-tab${
                file.path === pane.activePath ? " active" : ""
              }${missing.has(file.path) ? " missing" : ""}`}
              title={
                missing.has(file.path)
                  ? `${file.path} — ${STR.files.view.missingFileHint}`
                  : file.path
              }
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onCloseFile(file.path);
                } else if (event.button === 0) {
                  onPaneChange((current) =>
                    current.activePath === file.path
                      ? current
                      : { ...current, activePath: file.path }
                  );
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenu({
                  path: file.path,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <span className="editor-tab-name">{file.name}</span>
              {dirtyFor(file.path) ? (
                <span
                  className="editor-tab-dot"
                  title={
                    pane.conflicts.has(file.path)
                      ? STR.files.view.dirtyConflictHint
                      : STR.files.view.dirtyCloseHint
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseFile(file.path);
                  }}
                />
              ) : (
                <button
                  className="editor-tab-close"
                  aria-label={STR.files.view.closeFile}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseFile(file.path);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {comparison && (
            <div
              className={`editor-tab compare-tab${
                pane.activePath === null ? " active" : ""
              }`}
              title={STR.files.view.compareTabHint({
                a: comparison.a.split("/").pop() ?? comparison.a,
                b: comparison.b.name,
              })}
              onMouseDown={(event) => {
                if (event.button === 0) {
                  onPaneChange((current) => ({ ...current, activePath: null }));
                }
              }}
            >
              <span className="editor-tab-name">
                {comparison.a.split("/").pop() ?? ""} ↔ {comparison.b.name}
              </span>
              {dirtyFor(comparison.a) ? (
                <span
                  className="editor-tab-dot"
                  title={STR.files.view.unsavedHint}
                />
              ) : (
                <button
                  className="editor-tab-close"
                  aria-label={STR.files.view.closeCompare}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseCompare();
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {tabMenu && pane.open.some((file) => file.path === tabMenu.path) && (
        <EditorTabMenu
          at={tabMenu}
          open={pane.open}
          root={pane.root}
          onCloseTabs={onCloseTabs}
          onCompareWith={(path) => {
            setTabMenu(null);
            onCompareWith(path);
          }}
          onDismiss={() => setTabMenu(null)}
        />
      )}

      {!selected ? (
        comparisonIsOpen ? (
          <ComparisonWorkspace
            pane={pane}
            comparison={comparison}
            saving={saving}
            terminalToggle={terminalToggle}
            keyHints={keyHints}
            CodeEditor={CodeEditor}
            onPaneChange={onPaneChange}
            onSave={onSave}
            onReveal={onReveal}
          />
        ) : (
          <>
            <div className="files-toolbar">
              <div className="toolbar-spacer" />
              {terminalToggle}
            </div>
            {!restored ? (
              <LoadingState label={STR.files.view.restoring} />
            ) : (
              <div className="placeholder">
                <div className="placeholder-title">
                  {STR.files.view.noFileTitle}
                </div>
                <div className="placeholder-blurb">
                  {STR.files.view.noFileBlurb({
                    quickOpenKeys: keyHints.quickOpen,
                    locationKeys: keyHints.locationBar,
                    terminalKeys: keyHints.terminalPanel,
                  })}
                </div>
              </div>
            )}
          </>
        )
      ) : (
        <>
          <div className="files-toolbar">
            <span className="file-name">{selected.name}</span>
            {missing.has(selected.path) && (
              <span
                className="file-missing"
                title={STR.files.view.missingFileHint}
              >
                {STR.files.view.missingChip}
              </span>
            )}
            {badge && (
              <span
                className="git-chip"
                style={{ color: badge.color }}
              >
                {badge.letter} {badge.label}
              </span>
            )}
            <span className="file-meta">
              {formatSize(selected.size)}
              {selected.truncated && STR.files.view.truncatedSuffix}
            </span>
            {descriptor.dirty && (
              <span className="dirty-dot" title={STR.files.view.unsavedHint} />
            )}
            <div className="toolbar-spacer" />
            <ViewModeControls
              descriptor={descriptor}
              onModeChange={onModeChange}
            />
            {descriptor.ext === "json" &&
              selected.kind === "text" &&
              !selected.readOnlyReason && (
                <button
                  className="mini-btn"
                  title={STR.files.view.formatJsonHint({ keys: keyHints.save })}
                  onClick={() => {
                    try {
                      const pretty = `${JSON.stringify(
                        JSON.parse(descriptor.draftText),
                        null,
                        2
                      )}\n`;
                      if (pretty !== descriptor.draftText) {
                        onPaneChange((current) =>
                          draftedPane(current, selected.path, pretty)
                        );
                      }
                      onErrorChange(null);
                    } catch (formatError) {
                      onErrorChange(
                        describeError(formatError, STR.errors.actions.formatJson)
                      );
                    }
                  }}
                >
                  {STR.files.view.formatJson}
                </button>
              )}
            {descriptor.canDiff &&
              !descriptor.conflicted &&
              !descriptor.showRendered &&
              !descriptor.showInspect && (
                <button
                  className={`mini-btn${showDiff ? " on" : ""}`}
                  onClick={() => onShowDiffChange(!showDiff)}
                  title={STR.files.view.diffHint}
                >
                  {STR.files.view.diff}
                </button>
              )}
            {selected.kind === "text" && !selected.readOnlyReason && (
              <button
                className="mini-btn"
                onClick={() => onSave(selected)}
                disabled={!descriptor.dirty || saving}
                title={STR.files.view.saveHint({ keys: keyHints.save })}
              >
                {saving ? STR.files.view.saving : STR.files.view.save}
              </button>
            )}
            {selected.readOnlyReason && (
              <span className="git-chip" title={selected.readOnlyReason}>
                {STR.files.view.readOnlyChip}
              </span>
            )}
            <button
              className="mini-btn"
              onClick={() => onReveal(selected.path)}
              title={STR.files.view.revealHint}
            >
              {STR.files.view.reveal}
            </button>
            {terminalToggle}
          </div>

          {selected.readOnlyReason && (
            <div className="files-note">{selected.readOnlyReason}</div>
          )}
          {descriptor.conflicted && (
            <div className="files-conflict">
              <span className="files-conflict-msg">
                <b>{selected.name}</b>
                {STR.files.view.conflictTail}
              </span>
              <button
                className="mini-btn"
                title={STR.files.view.keepDraftHint}
                onClick={() => onResolveConflict(selected.path, true)}
              >
                {STR.files.view.keepDraft}
              </button>
              <button
                className="mini-btn"
                title={STR.files.view.discardDraftHint}
                onClick={() => onResolveConflict(selected.path, false)}
              >
                {STR.files.view.discardDraft}
              </button>
            </div>
          )}
          {active &&
            error &&
            (typeof error === "string" ? (
              <div className="files-error">{error}</div>
            ) : (
              <ErrorState inline error={error} />
            ))}

          {descriptor.conflicted ? (
            <CodeEditor
              key={`${selected.path}:conflict`}
              path={selected.path}
              value={descriptor.draftText}
              original={selected.text ?? ""}
              readOnly={!!selected.readOnlyReason}
              onChange={(value) =>
                onPaneChange((current) =>
                  draftedPane(current, selected.path, value)
                )
              }
              onSave={() => onSave(selected)}
            />
          ) : descriptor.showInspect ? (
            <InspectView meta={selected} />
          ) : descriptor.isBigText ? (
            <LogView meta={selected} />
          ) : descriptor.showSplit ? (
            <div className="files-preview-split">
              <div className="files-preview-split-half">
                <CodeEditor
                  path={selected.path}
                  value={descriptor.draftText}
                  readOnly={!!selected.readOnlyReason}
                  onChange={(value) =>
                    onPaneChange((current) =>
                      draftedPane(current, selected.path, value)
                    )
                  }
                  onSave={() => onSave(selected)}
                />
              </div>
              <div className="files-preview-split-half rendered">
                <MarkdownView
                  path={selected.path}
                  text={descriptor.draftText}
                />
              </div>
            </div>
          ) : descriptor.showRendered &&
            descriptor.renderKind === "markdown" ? (
            <MarkdownView path={selected.path} text={descriptor.draftText} />
          ) : descriptor.showRendered &&
            descriptor.renderKind === "notebook" ? (
            <NotebookView text={descriptor.draftText} />
          ) : descriptor.showRendered && descriptor.renderKind === "html" ? (
            <HtmlView
              path={selected.path}
              text={descriptor.draftText}
              onOpenInBrowser={() => onOpenHtmlInBrowser(selected.path)}
            />
          ) : descriptor.showRendered ? (
            <CsvView
              text={descriptor.draftText}
              delimiter={descriptor.renderKind === "tsv" ? "\t" : ","}
              onEdit={
                selected.readOnlyReason
                  ? undefined
                  : (text) =>
                      onPaneChange((current) =>
                        draftedPane(current, selected.path, text)
                      )
              }
            />
          ) : selected.kind === "text" ? (
            <CodeEditor
              key={
                showDiff && descriptor.canDiff
                  ? `${selected.path}:diff`
                  : "editor"
              }
              path={selected.path}
              value={descriptor.draftText}
              revealLine={active ? revealLine : null}
              original={
                showDiff && descriptor.canDiff ? selected.headText : null
              }
              readOnly={!!selected.readOnlyReason}
              onChange={(value) =>
                onPaneChange((current) =>
                  draftedPane(current, selected.path, value)
                )
              }
              onSave={() => onSave(selected)}
            />
          ) : (
            <Preview meta={selected} />
          )}

          {findOpen && active && (
            <PreviewFind
              container={containerRef.current}
              isolated={
                descriptor.showRendered && descriptor.renderKind === "html"
              }
              onSearchSource={(term) => {
                onFindOpenChange(false);
                onModeChange("source");
                window.setTimeout(() => {
                  const editor =
                    containerRef.current?.querySelector<HTMLElement>(
                      ".monaco-editor"
                    );
                  editor?.focus();
                  if (term) void navigator.clipboard?.writeText(term);
                }, 120);
              }}
              onClose={() => onFindOpenChange(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

function ViewModeControls<File extends FilesWorkspaceFile>({
  descriptor,
  onModeChange,
}: {
  descriptor: FilesWorkspaceDescriptor<File>;
  onModeChange: (mode: string) => void;
}) {
  if (descriptor.conflicted) return null;
  if (descriptor.renderKind === "markdown") {
    return (
      <span className="mode-seg">
        {(
          [
            ["preview", STR.files.view.modePreview],
            ["split", STR.files.view.modeSplit],
            ["source", STR.files.view.modeSource],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            className={`mini-btn${descriptor.viewMode === mode ? " on" : ""}`}
            onClick={() => onModeChange(mode)}
          >
            {label}
          </button>
        ))}
      </span>
    );
  }
  if (
    !descriptor.renderKind &&
    !(
      descriptor.sel?.kind === "text" &&
      (descriptor.isCert || descriptor.isScript)
    )
  ) {
    return null;
  }
  return (
    <button
      className="mini-btn"
      onClick={() =>
        onModeChange(descriptor.inSource ? "preview" : "source")
      }
      title={
        descriptor.inSource
          ? STR.files.view.backToRenderedHint
          : STR.files.view.showSourceHint
      }
    >
      {descriptor.inSource
        ? descriptor.isCert || descriptor.isScript
          ? STR.files.view.modeDetails
          : STR.files.view.modePreview
        : STR.files.view.modeSource}
    </button>
  );
}

function ComparisonWorkspace<File extends FilesWorkspaceFile>({
  pane,
  comparison,
  saving,
  terminalToggle,
  keyHints,
  CodeEditor,
  onPaneChange,
  onSave,
  onReveal,
}: {
  pane: PaneState<File>;
  comparison: FilesWorkspaceComparison<File>;
  saving: boolean;
  terminalToggle: ReactNode;
  keyHints: FilesWorkspaceKeyHints;
  CodeEditor: ComponentType<FilesWorkspaceCodeEditorProps>;
  onPaneChange: (change: (pane: PaneState<File>) => PaneState<File>) => void;
  onSave: (file: File) => void;
  onReveal: (path: string) => void;
}) {
  const left = pane.open.find((file) => file.path === comparison.a);
  if (!left) return null;
  const draft = pane.drafts.get(comparison.a) ?? left.text ?? "";
  const dirty =
    pane.drafts.get(comparison.a) !== undefined &&
    pane.drafts.get(comparison.a) !== (left.text ?? "");

  return (
    <>
      <div className="files-toolbar">
        <span className="file-name">
          {left.name} ↔ {comparison.b.name}
        </span>
        <span className="file-meta">{STR.files.view.compareSides}</span>
        <span
          className="git-chip"
          title={STR.files.view.compareSnapshotHint({
            name: comparison.b.name,
          })}
        >
          {STR.files.view.compareSnapshotChip}
        </span>
        <div className="toolbar-spacer" />
        {left.kind === "text" && !left.readOnlyReason && (
          <button
            className="mini-btn"
            onClick={() => onSave(left)}
            disabled={!dirty || saving}
            title={STR.files.view.saveHint({ keys: keyHints.save })}
          >
            {saving ? STR.files.view.saving : STR.files.view.save}
          </button>
        )}
        {left.readOnlyReason && (
          <span className="git-chip" title={left.readOnlyReason}>
            {STR.files.view.readOnlyChip}
          </span>
        )}
        <button
          className="mini-btn"
          onClick={() => onReveal(left.path)}
          title={STR.files.view.revealHint}
        >
          {STR.files.view.reveal}
        </button>
        {terminalToggle}
      </div>
      <CodeEditor
        key={`compare:${comparison.a}:${comparison.b.path}`}
        path={comparison.a}
        value={draft}
        original={comparison.b.text ?? ""}
        readOnly={!!left.readOnlyReason}
        onChange={(value) =>
          onPaneChange((current) =>
            draftedPane(current, comparison.a, value)
          )
        }
        onSave={() => onSave(left)}
      />
    </>
  );
}
