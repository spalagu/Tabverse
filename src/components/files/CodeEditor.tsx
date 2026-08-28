import * as monaco from "monaco-editor";
import {
  CodeEditor as SharedCodeEditor,
  type CodeEditorProps,
} from "@tabverse/workbench/files/code-editor";
import { useStore } from "../../state/store";
import { defineEditorThemes, editorThemeName } from "../../theme/tokens";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment =
  {
    getWorker(_id, label) {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

defineEditorThemes(monaco);

let appliedEditorTheme = editorThemeName(useStore.getState().resolvedTheme);
monaco.editor.setTheme(appliedEditorTheme);
useStore.subscribe((state, previous) => {
  if (state.resolvedTheme !== previous.resolvedTheme) {
    appliedEditorTheme = editorThemeName(state.resolvedTheme);
    monaco.editor.setTheme(appliedEditorTheme);
  }
});

export function currentEditorThemeName(): string {
  return appliedEditorTheme;
}

export {
  disposeEditorState,
  languageFor,
  openEditorFind,
} from "@tabverse/workbench/files/code-editor";

type DesktopCodeEditorProps = Omit<CodeEditorProps, "theme">;

export function CodeEditor(props: DesktopCodeEditorProps) {
  const theme = useStore((state) => editorThemeName(state.resolvedTheme));
  return <SharedCodeEditor {...props} theme={theme} />;
}
