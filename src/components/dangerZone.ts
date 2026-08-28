import { clearHistory } from "../history";
import { deleteState, flushAll, listScopes } from "../persist";
import {
  CONFIG_KEYS,
  clearKeyOverrides,
  configReset,
} from "../state/config";
import { forgetSessionScopes, useStore } from "../state/store";
import { STR } from "../strings";
import { describeError, type ErrorDescription } from "../strings/errors";
import { confirmAsk } from "./Confirm";


/** One destructive action: what it says, and what it does if allowed. */
export interface DangerAction {
  /** Stable id — the `data-danger` attribute, and what a test names. */
  id: DangerActionId;
  /** The button on the page. */
  label: string;
  /** The proceed button in the confirmation. */
  confirmLabel: string;
  /**
   * The question, always built by `STR.settings.danger.question`. Held as
   * the finished sentence rather than as its slot so that the page cannot
   * render one sentence while the confirmation asks another.
   */
  question: string;
  /**
   * The erasure itself. Reached only through [`runDangerAction`], which does
   * not call it until the confirmation has come back yes.
   */
  perform: () => Promise<void>;
}

export type DangerActionId = "session" | "history" | "passwords" | "factory";

/** Where an action's result — or its failure — is shown. */
export interface DangerNote {
  (note: string | ErrorDescription): void;
}

/**
 * Every destructive action, in the order the section lists them: the three
 * that already existed, then the one that does all of it.
 *
 * `note` is the page's own line under the section. It is a parameter because
 * this module has no screen of its own, and because it is the whole of what
 * these need from the page — everything else they touch is storage.
 */
export function dangerActions(note: DangerNote): DangerAction[] {
  const S = STR.settings.danger;
  return [
    {
      id: "session",
      label: S.session,
      confirmLabel: S.sessionConfirm,
      question: S.question({ erases: S.sessionErases }),
      perform: forgetSession,
    },
    {
      id: "history",
      label: S.history,
      confirmLabel: S.historyConfirm,
      question: S.question({ erases: S.historyErases }),
      perform: async () => {
        clearHistory();
      },
    },
    {
      id: "passwords",
      label: S.passwords,
      confirmLabel: S.passwordsConfirm,
      question: S.question({ erases: S.passwordsErases }),
      perform: async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        try {
          const n = await invoke<number>("pw_forget_all");
          note(STR.settings.passwords.forgotResult({ count: n }));
        } catch (e) {
          note(describeError(e, STR.errors.actions.forgetLogins));
        }
      },
    },
    {
      id: "factory",
      label: S.factory,
      confirmLabel: S.factoryConfirm,
      question: S.question({ erases: S.factoryErases }),
      perform: () => restoreFactorySettings(note),
    },
  ];
}

export async function runDangerAction(
  action: DangerAction,
  ask: typeof confirmAsk = confirmAsk
): Promise<boolean> {
  const ok = await ask(action.question, { confirmLabel: action.confirmLabel });
  if (!ok) return false;
  await action.perform();
  return true;
}

/**
 * Forget the saved session: every scope except the theme snapshot.
 *
 * Every scope, not just the tab list: the point of a reset is that the next
 * launch starts clean, and per-tab workspace state (open files, drafts,
 * terminal history) outlives the tab list otherwise.
 *
 * What this no longer erases is the user's settings. Six of them used to ride
 * in the session scope and went with it — pressing this button once reset the
 * theme, the sidebar, the search engine and the archive threshold, none of
 * which is a saved session. They live in the configuration file now, which
 * this does not touch, and `forgetSessionScopes` keeps the one remaining
 * setting-derived file (theme.json, the cold-start snapshot) out of the
 * sweep.
 */
async function forgetSession(): Promise<void> {
  try {
    for (const scope of forgetSessionScopes(await listScopes())) {
      deleteState(scope);
    }
    // Deletes are debounced like saves; without the flush a reset followed
    // by a quick quit would leave the state files in place.
    await flushAll();
  } catch {
    // A reset that cannot reach storage has nothing to undo.
  }
}

async function restoreFactorySettings(note: DangerNote): Promise<void> {
  try {
    await clearKeyOverrides();
    await configReset(CONFIG_KEYS.theme);
    for (const scope of await listScopes()) deleteState(scope);
    await flushAll();
    // Re-read the file, which is what puts the theme back on screen and
    // republishes the emptied overlay to every consumer of a key. The same
    // call the app makes at startup, so there is no second path that could
    // come to disagree with it.
    await useStore.getState().initConfig();
    note(STR.settings.danger.factoryDone);
  } catch (e) {
    note(describeError(e, STR.errors.actions.restoreDefaults));
  }
}
