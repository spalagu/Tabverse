import { useEffect, useMemo, useState } from "react";
import { confirmAsk } from "./Confirm";
import { STR } from "../strings";
import { describeError, errorText, type ErrorDescription } from "../strings/errors";
import { ErrorState } from "./state/ErrorState";
import { templateRemove, templateSet, upsertTemplate, type ConfigTemplate, type ConfigTemplateNode } from "../state/config";
import { useStore } from "../state/store";
import { useTemplates } from "./useTemplates";
import {
  captureTemplate,
  templateLeaves,
} from "../terminalTemplates";
import { leaf as paneLeaf, type PaneNode } from "../paneTree";

const T = STR.dialogs.saveTemplate;

export function SaveTemplateDialog() {
  const tabId = useStore((s) => s.saveTemplateFor);
  const tab = useStore((s) =>
    s.saveTemplateFor === null
      ? undefined
      : s.tabs.find((t) => t.id === s.saveTemplateFor)
  );
  const close = useStore((s) => s.setSaveTemplateFor);
  const { list, reload } = useTemplates(tabId !== null);

  const [name, setName] = useState("");
  const [commands, setCommands] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failure, setFailure] = useState<ErrorDescription | null>(null);
  const [busy, setBusy] = useState(false);

  // The live tree as it stands while the dialog is open, already shaped as a
  // template. An un-split tab is captured as the one leaf it is — a one-pane
  // layout is a layout — wearing the tab's directory and, for a tab opened
  // under a profile, that profile as the pane's fallback.
  const base = useMemo<ConfigTemplate | null>(() => {
    if (tab === undefined || tab.type !== "terminal") return null;
    const live: PaneNode =
      tab.panes ?? paneLeaf(tab.id, tab.cwd);
    return captureTemplate("", live, { profile: tab.profile });
  }, [tab]);

  const cells = useMemo(
    () => (base === null ? [] : templateLeaves(base.tree)),
    [base]
  );

  // Fresh fields every time the dialog opens; nothing about the previous
  // edit is allowed to leak into the next one.
  useEffect(() => {
    if (tabId !== null) {
      setName("");
      setCommands(cells.map(() => ""));
      setRefusal(null);
      setFailure(null);
    }
    // The values are reset on open, not edited; the count is the only thing
    // a re-run follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, cells.length]);

  if (tabId === null || tab === undefined || base === null) return null;

  const clash = list.find((t) => t.name === name.trim());

  const save = async () => {
    // The blank command fields become absent fields, never empty strings:
    // absent is "do what a plain terminal does", which an empty string is not.
    let tree = base.tree;
    templateLeaves(base.tree).forEach(({ path }, at) => {
      const command = commands[at]?.trim();
      if (command !== undefined && command !== "") {
        tree = withCommand(tree, path, command);
      }
    });
    const template: ConfigTemplate = { name: name.trim(), tree };
    try {
      upsertTemplate(list, name.trim(), template);
    } catch (e) {
      // `upsertTemplate` throws the file format's own sentence, so a string
      // is shown as it stands; anything else goes through the one sanctioned
      // stringification rather than a `String(e)` of this component's own.
      setRefusal(typeof e === "string" ? e : errorText(e));
      return;
    }
    setRefusal(null);
    setBusy(true);
    try {
      await templateSet(name.trim(), template);
      setFailure(null);
      close(null);
      reload();
    } catch (e) {
      setFailure(describeError(e, STR.errors.actions.saveLayout));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (victim: ConfigTemplate) => {
    if (
      !(await confirmAsk(T.removeQuestion({ name: victim.name }), {
        confirmLabel: T.remove,
      }))
    )
      return;
    try {
      await templateRemove(victim.name);
      setFailure(null);
      reload();
    } catch (e) {
      setFailure(describeError(e, STR.errors.actions.removeLayout));
    }
  };

  return (
    <div className="overlay" onMouseDown={() => close(null)} data-save-template="">
      <div
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={T.title}
      >
        <div className="dialog-title">{T.title}</div>
        <p className="dialog-text">{T.blurb}</p>

        {failure && <ErrorState inline error={failure} />}

        <label htmlFor="template-name">{T.name}</label>
        <input
          id="template-name"
          className="settings-input"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {clash !== undefined && name.trim() !== "" && (
          <p className="pw-empty">{T.replaceNote({ name: clash.name })}</p>
        )}

        {cells.map(({ leaf }, at) => (
          <div key={at} className="template-pane" data-pane={at}>
            <div className="pw-empty">
              {T.paneSummary({
                n: at + 1,
                cwd: leaf.cwd ?? T.panePlainCwd,
                profile: leaf.profile ?? T.panePlainProfile,
              })}
            </div>
            <label htmlFor={`template-command-${at}`}>{T.commandLabel}</label>
            <input
              id={`template-command-${at}`}
              className="settings-input"
              spellCheck={false}
              placeholder={T.commandPlaceholder}
              value={commands[at] ?? ""}
              onChange={(e) =>
                setCommands((prev) =>
                  prev.map((c, i) => (i === at ? e.target.value : c))
                )
              }
            />
          </div>
        ))}
        <p className="pw-empty">{T.commandHint}</p>

        {refusal !== null && (
          <div className="settings-banner danger" role="alert">
            <p>{refusal}</p>
          </div>
        )}

        {list.length > 0 && (
          <>
            <div className="dialog-title" style={{ fontSize: "var(--fs-base)" }}>
              {T.existing}
            </div>
            <table className="pw-table">
              <tbody>
                {list.map((template) => (
                  <tr key={template.name} data-template={template.name}>
                    <td>
                      <strong>{template.name}</strong>
                    </td>
                    <td>
                      <button
                        className="btn"
                        onClick={() => void remove(template)}
                      >
                        {T.remove}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <div className="btn-row">
          <button className="btn" disabled={busy} onClick={() => void save()}>
            {T.save}
          </button>
          <button className="btn" onClick={() => close(null)}>
            {STR.common.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

function withCommand(
  tree: ConfigTemplateNode,
  path: readonly number[],
  command: string
): ConfigTemplateNode {
  if (path.length === 0) {
    return tree.kind === "leaf" ? { ...tree, run_on_start: command } : tree;
  }
  if (tree.kind === "leaf") return tree;
  const [at, ...rest] = path;
  return {
    ...tree,
    children: tree.children.map((child, index) =>
      index === at ? withCommand(child, rest, command) : child
    ),
  };
}
