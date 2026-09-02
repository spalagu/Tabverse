import {
  ResidentCoordinator,
  createTauriResidentPort,
} from "@tabverse/runtime-desktop";
import type {
  ContinuousResidentContribution,
  ResidentAttachReplay,
  ResidentContribution,
  ResidentRuntimeRef,
} from "@tabverse/tab-contracts";
import { configGet, residentDefaultOf } from "./state/config";
import { paneFields, useStore, type Tab } from "./state/store";
import { readPaneTree, updateLeaf } from "./paneTree";
import { desktopPluginComposition } from "./pluginComposition";

const coordinator = new ResidentCoordinator(createTauriResidentPort());
let takeover: Promise<readonly ResidentAttachReplay[]> | undefined;

function takeOverOnce(): Promise<readonly ResidentAttachReplay[]> {
  takeover ??= coordinator.takeOver().catch((error) => {
    takeover = undefined;
    throw error;
  });
  return takeover;
}

/** Resolve policy and attach/ensure before a continuous renderer starts work. */
export async function prepareResidentRuntime(
  tab: Tab,
  contribution: ResidentContribution | undefined,
): Promise<ResidentRuntimeRef | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const [config, catalog] = await Promise.all([
    configGet(),
    desktopPluginComposition().snapshot(),
  ]);
  const configured = residentDefaultOf(config.values);
  const appDefault = configured === true ? "on" : "off";
  const tabPolicy = tab.residentPolicy ?? "inherit";
  const continuous: readonly ContinuousResidentContribution[] =
    contribution?.capability === "continuous"
      ? [contribution]
      : contribution?.continuousTasks ?? [];
  if (continuous.length === 0) return null;
  const enabled = tabPolicy === "inherit" ? appDefault === "on" : tabPolicy === "on";
  if (!enabled) {
    await coordinator.stopTab(tab.id);
    return null;
  }
  await takeOverOnce();
  let primary: ResidentRuntimeRef | null = null;
  for (const task of continuous) {
    const result = await coordinator.mount({
      tabId: tab.id,
      contribution: task,
      policy: { appDefault, tab: tabPolicy },
      state: tab,
      catalogRevision: catalog.revision,
    });
    if (result.mode === "continuous" && primary === null) primary = result.runtime;
  }
  return primary;
}

export async function stopResidentTab(tabId: string): Promise<void> {
  await coordinator.stopTab(tabId);
}

export async function detachResidentForAppExit(): Promise<void> {
  await coordinator.detachForAppExit();
}

export async function takeOverResidentRuntimes(): Promise<readonly ResidentAttachReplay[]> {
  if (!("__TAURI_INTERNALS__" in window)) return [];
  return await takeOverOnce();
}

export function residentTakeoverFailures() {
  return coordinator.takeoverFailures();
}

/** Read-only Supervisor inventory used by PluginCatalog lifecycle blockers. */
export async function listResidentRuntimes(): Promise<readonly ResidentRuntimeRef[]> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<readonly ResidentRuntimeRef[]>("resident_list");
}

/**
 * A Remote ticket is deliberately absent from session.json. The running
 * Supervisor is the authority that can re-materialize that Tab after a GUI
 * replacement, using the checkpoint that created its still-live worker.
 */
export function reconcileResidentRemoteTabs(
  replays: readonly ResidentAttachReplay[],
): readonly string[] {
  const restored: string[] = [];
  const previousActive = useStore.getState().activeTabId;
  for (const replay of replays) {
    if (replay.runtime.kind !== "remote") continue;
    if (useStore.getState().tabs.some((tab) => tab.id === replay.runtime.tabId)) {
      continue;
    }
    const checkpoint = replay.checkpoint;
    if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
      continue;
    }
    const state = checkpoint as Partial<Tab>;
    if (
      state.type !== "remote" ||
      state.id !== replay.runtime.tabId ||
      typeof state.joinTicket !== "string" ||
      state.joinTicket.length === 0
    ) {
      continue;
    }
    const id = useStore.getState().addTab({
      id: replay.runtime.tabId,
      type: "remote",
      title: typeof state.title === "string" ? state.title : undefined,
      joinTicket: state.joinTicket,
      residentPolicy:
        state.residentPolicy === "inherit" ||
        state.residentPolicy === "on" ||
        state.residentPolicy === "off"
          ? state.residentPolicy
          : "on",
    });
    restored.push(id);
  }
  if (previousActive !== null && restored.length > 0) {
    useStore.setState({ activeTabId: previousActive });
  }
  return restored;
}

interface ResidentTerminalSession {
  readonly id: readonly number[];
  readonly ownerKey?: string | null;
  readonly cwd: string | null;
  readonly attached: boolean;
}

type ResidentTerminalList = (
  runtimeId: string,
) => Promise<readonly ResidentTerminalSession[]>;

async function listResidentTerminalSessions(
  runtimeId: string,
): Promise<readonly ResidentTerminalSession[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<readonly ResidentTerminalSession[]>("term_resident_list", {
    runtimeId,
  });
}

function sessionHex(bytes: readonly number[]): string | null {
  if (
    bytes.length !== 16 ||
    bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    return null;
  }
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reconnect each persisted pane to the session with the same stable owner key. */
export async function reconcileResidentTerminalTabs(
  replays: readonly ResidentAttachReplay[],
  listSessions: ResidentTerminalList = listResidentTerminalSessions,
): Promise<readonly string[]> {
  const reconciled: string[] = [];
  const previousActive = useStore.getState().activeTabId;
  for (const replay of replays) {
    if (replay.runtime.kind !== "terminal") continue;
    const checkpoint = replay.checkpoint;
    if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
      continue;
    }
    const state = checkpoint as Partial<Tab>;
    if (state.type !== "terminal" || state.id !== replay.runtime.tabId) continue;

    let tab = useStore.getState().tabs.find((candidate) => candidate.id === state.id);
    if (tab === undefined) {
      useStore.getState().addTab({
        id: state.id,
        type: "terminal",
        title: typeof state.title === "string" ? state.title : undefined,
        cwd: typeof state.cwd === "string" ? state.cwd : undefined,
        profile: typeof state.profile === "string" ? state.profile : undefined,
        residentPolicy:
          state.residentPolicy === "inherit" ||
          state.residentPolicy === "on" ||
          state.residentPolicy === "off"
            ? state.residentPolicy
            : "on",
      });
      const panes = readPaneTree(state.panes);
      if (panes !== null) {
        useStore.setState((current) => ({
          tabs: current.tabs.map((candidate) =>
            candidate.id === state.id ? { ...candidate, ...paneFields(panes) } : candidate,
          ),
        }));
      }
      tab = useStore.getState().tabs.find((candidate) => candidate.id === state.id);
    }
    if (tab === undefined || tab.type !== "terminal") continue;

    const sessions = (await listSessions(replay.runtime.runtimeId))
      .map((session) => ({ ...session, hex: sessionHex(session.id) }))
      .filter((session): session is typeof session & { hex: string } => session.hex !== null);
    if (sessions.length === 0) continue;
    useStore.setState((current) => ({
      tabs: current.tabs.map((candidate) => {
        if (candidate.id !== replay.runtime.tabId) return candidate;
        if (candidate.panes === undefined) {
          const match =
            sessions.find((session) => session.ownerKey === candidate.id) ??
            (sessions.length === 1 ? sessions[0] : undefined);
          return match === undefined
            ? candidate
            : { ...candidate, attachSessionId: match.hex };
        }
        let panes = candidate.panes;
        for (const session of sessions) {
          if (typeof session.ownerKey !== "string") continue;
          panes = updateLeaf(panes, session.ownerKey, { attachSessionId: session.hex });
        }
        return { ...candidate, panes };
      }),
    }));
    reconciled.push(replay.runtime.tabId);
  }
  if (previousActive !== null && reconciled.length > 0) {
    useStore.setState({ activeTabId: previousActive });
  }
  return reconciled;
}
