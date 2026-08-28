import type { Block, BlockEvents } from "./blocks";
import { classifyRemote, type RemoteTarget } from "./remoteState";

export interface TerminalBlockTracker {
  readonly blocks: Block[];
  readonly runningBlock: Block | null;
  pruneDead: () => number;
  dispose: () => void;
}

export interface TerminalBlockDecorations {
  sync: (blocks: readonly Block[]) => void;
  dispose: () => void;
}

export interface TerminalBlockControllerPorts<Tracker extends TerminalBlockTracker> {
  createTracker: (events: BlockEvents) => Tracker;
  decorations: TerminalBlockDecorations;
  setRunning: (block: Block | null) => void;
  setSelected: (block: Block | null) => void;
  setRemoteHost: (host: string | null) => void;
  setRemoteCwd: (cwd: string | null) => void;
  setTabRemote: (target: RemoteTarget | null) => void;
  setPaneBusy: (busy: boolean) => void;
  setPaneCwd: (cwd: string) => void;
  active: () => boolean;
  documentFocused: () => boolean;
  notifyFinished: (block: Block, durationMs: number) => void;
  setAttention: () => void;
  longCommandMs?: number;
}

export interface TerminalBlockController<Tracker extends TerminalBlockTracker> {
  tracker: Tracker;
  dispose: () => void;
}

const DEFAULT_LONG_COMMAND_MS = 8000;

/**
 * Connects shell-integration blocks to presentation and host state without
 * giving the tracker knowledge of React, application stores, or notifications.
 */
export function createTerminalBlockController<Tracker extends TerminalBlockTracker>(
  ports: TerminalBlockControllerPorts<Tracker>
): TerminalBlockController<Tracker> {
  let tracker!: Tracker;
  tracker = ports.createTracker({
    onChange: () => {
      tracker.pruneDead();
      ports.decorations.sync(tracker.blocks);
      const running = tracker.runningBlock;
      ports.setRunning(running);
      const remote = running === null ? null : classifyRemote(running.command);
      ports.setRemoteHost(remote?.host ?? null);
      if (remote === null) ports.setRemoteCwd(null);
      ports.setTabRemote(remote);
      ports.setPaneBusy(running !== null);
      ports.setSelected(tracker.blocks[tracker.blocks.length - 1] ?? null);
    },
    onCwd: (cwd) => {
      ports.setPaneCwd(cwd);
      const running = tracker.runningBlock;
      if (running !== null && classifyRemote(running.command) !== null) {
        ports.setRemoteCwd(cwd);
      }
    },
    onHost: (host) => {
      const running = tracker.runningBlock;
      if (running === null || classifyRemote(running.command) === null) return;
      ports.setRemoteHost(host);
      ports.setTabRemote({ host });
    },
    onFinished: (block, durationMs) => {
      const active = ports.active();
      if (
        durationMs >= (ports.longCommandMs ?? DEFAULT_LONG_COMMAND_MS) &&
        (!active || !ports.documentFocused())
      ) {
        ports.notifyFinished(block, durationMs);
      }
      if (!active) ports.setAttention();
    },
  });

  return {
    tracker,
    dispose: () => {
      ports.decorations.dispose();
      tracker.dispose();
    },
  };
}
