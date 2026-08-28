import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { languageFor } from "./editorLanguage";

export { languageFor } from "./editorLanguage";

export interface CodeEditorProps {
  path: string;
  value: string;
  /** Monaco theme name already registered by the host runtime. */
  theme: string;
  /** When set, show a side-by-side diff against this (the git HEAD version). */
  original?: string | null;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  /**
   * A line to land on when this file is opened from somewhere that knows
   * where it wants to go — a search result, for one. Cleared by the caller
   * once used, so opening the same file later does not jump again.
   */
  revealLine?: number | null;
}

/**
 * Models are cached per path so that switching between open files keeps each
 * file's undo history, and view state (cursor, scroll) is saved and restored
 * per path — the way an editor with tabs is expected to behave.
 */
const modelCache = new Map<string, monaco.editor.ITextModel>();
const viewStateCache = new Map<string, monaco.editor.ICodeEditorViewState>();

function modelFor(path: string, value: string): monaco.editor.ITextModel {
  let m = modelCache.get(path);
  if (!m || m.isDisposed()) {
    m = monaco.editor.createModel(value, languageFor(path));
    modelCache.set(path, m);
  }
  return m;
}

/** Drop a closed file's model and view state (frees memory, resets undo). */
export function disposeEditorState(path: string): void {
  modelCache.get(path)?.dispose();
  modelCache.delete(path);
  viewStateCache.delete(path);
}

let onScreen: monaco.editor.IStandaloneCodeEditor | null = null;

/**
 * Open the editor's own find, or its find-and-replace. Answers whether
 * there was an editor to open it in, so the caller knows whether the key
 * was actually used.
 */
export function openEditorFind(replace: boolean): boolean {
  if (!onScreen) return false;
  onScreen.focus();
  const action = onScreen.getAction(
    replace ? "editor.action.startFindReplaceAction" : "actions.find"
  );
  if (!action) return false;
  void action.run();
  return true;
}

export function CodeEditor({
  path,
  value,
  theme,
  original,
  readOnly,
  onChange,
  onSave,
  revealLine,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<
    monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null
  >(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const changeSubRef = useRef<monaco.IDisposable | null>(null);
  const diffMode = original != null;

  // Reveal after the model is in place, and centred: a match scrolled to
  // the very bottom edge reads as "not found".
  useEffect(() => {
    if (revealLine == null) return;
    const ed = editorRef.current;
    if (!ed || !("revealLineInCenter" in ed)) return;
    const editor = ed as monaco.editor.IStandaloneCodeEditor;
    editor.revealLineInCenter(revealLine);
    editor.setPosition({ lineNumber: revealLine, column: 1 });
    editor.focus();
  }, [revealLine, path, value]);

  // The plain editor persists across file switches (models swap in and out);
  // only a diff-mode change rebuilds the widget.
  const pathRef = useRef(path);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const lang = languageFor(path);
    const common: monaco.editor.IStandaloneEditorConstructionOptions = {
      theme,
      automaticLayout: true,
      fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Mono", monospace',
      fontSize: 12.5,
      minimap: { enabled: true, size: "proportional" },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      readOnly,
      tabSize: 2,
    };

    let disposeModels: monaco.editor.ITextModel[] = [];
    // Whichever kind is built below, the one that owns the text is the one
    // a find belongs to — for a diff that is the editable side.
    const remember = (ed: monaco.editor.IStandaloneCodeEditor) => {
      onScreen = ed;
    };
    if (diffMode) {
      const diff = monaco.editor.createDiffEditor(host, {
        ...common,
        renderSideBySide: true,
        originalEditable: false,
        splitViewDefaultRatio: 0.5,
        // Below ~900px Monaco silently switches to its inline-diff layout but
        // leaves a useless sliver of the original editor on the left. Our
        // pane is often narrower than that, so pin the mode to side-by-side.
        renderSideBySideInlineBreakpoint: 0,
        // Diff panes are narrow; the minimap costs more than it gives.
        minimap: { enabled: false },
      });
      const originalModel = monaco.editor.createModel(original ?? "", lang);
      // Diff edits flow through the SAME cached model, so edits made in diff
      // view survive toggling back to the plain editor.
      const modifiedModel = modelFor(path, value);
      diff.setModel({ original: originalModel, modified: modifiedModel });
      disposeModels = [originalModel];
      changeSubRef.current = modifiedModel.onDidChangeContent(() =>
        onChangeRef.current?.(modifiedModel.getValue())
      );
      diff.getModifiedEditor().addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => saveRef.current?.()
      );
      editorRef.current = diff;
      // A diff has two sides; the find belongs to the one that can be typed
      // in, which is also the one the file's text lives in.
      remember(diff.getModifiedEditor());
      // Re-measure once the flex layout has settled; automaticLayout only
      // reacts to *changes* after the initial (possibly wrong) measurement.
      requestAnimationFrame(() => diff.layout());
      setTimeout(() => diff.layout(), 200);
    } else {
      const model = modelFor(path, value);
      const ed = monaco.editor.create(host, { ...common, model });
      remember(ed);
      const sub = model.onDidChangeContent(() =>
        onChangeRef.current?.(model.getValue())
      );
      changeSubRef.current = sub;
      const vs = viewStateCache.get(path);
      if (vs) ed.restoreViewState(vs);
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
        saveRef.current?.()
      );
      editorRef.current = ed;
    }

    return () => {
      changeSubRef.current?.dispose();
      const ed = editorRef.current;
      if (ed && !diffMode) {
        const st = (ed as monaco.editor.IStandaloneCodeEditor).saveViewState();
        if (st) viewStateCache.set(pathRef.current, st);
      }
      editorRef.current?.dispose();
      editorRef.current = null;
      onScreen = null;
      // Diff models are throwaway; plain models live in the cache.
      disposeModels.forEach((m) => m.dispose());
    };
    // Value is intentionally not a dependency: the editor owns it after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffMode, readOnly]);

  // File switch in plain mode: swap models, keep the editor (and undo stacks).
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || diffMode) {
      pathRef.current = path;
      return;
    }
    const plain = ed as monaco.editor.IStandaloneCodeEditor;
    if (pathRef.current !== path) {
      const prevState = plain.saveViewState();
      if (prevState) viewStateCache.set(pathRef.current, prevState);
      changeSubRef.current?.dispose();
      const model = modelFor(path, value);
      plain.setModel(model);
      changeSubRef.current = model.onDidChangeContent(() =>
        onChangeRef.current?.(model.getValue())
      );
      const vs = viewStateCache.get(path);
      if (vs) plain.restoreViewState(vs);
      pathRef.current = path;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, diffMode]);

  return <div className="code-editor" ref={hostRef} />;
}
