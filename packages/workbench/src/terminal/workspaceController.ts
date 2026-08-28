import type { Block } from "./blocks";

export type TerminalPaneDirection = "left" | "right" | "up" | "down";

export type TerminalWorkspaceAction =
  | { command: "find" }
  | { command: "command-blocks"; dir: -1 | 1 }
  | { command: "split-pane"; vertical: boolean }
  | { command: "focus-pane"; dir: TerminalPaneDirection }
  | { command: "resize-pane"; dir: TerminalPaneDirection }
  | { command: "zoom-pane" }
  | { command: "toggle-broadcast" }
  | { command: "scroll-end"; dir: -1 | 1 };

export interface TerminalWorkspaceActionPorts {
  openSearch: () => void;
  jumpBlock: (direction: -1 | 1) => void;
  currentCwd: () => string | null;
  splitPane: (vertical: boolean, cwd: string | undefined) => void;
  focusPane: (direction: TerminalPaneDirection) => void;
  resizePane: (direction: TerminalPaneDirection) => void;
  zoomPane: () => void;
  toggleBroadcast: () => { refused?: string };
  writeBroadcastRefusal: () => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
}

export function runTerminalWorkspaceAction(
  action: TerminalWorkspaceAction,
  ports: TerminalWorkspaceActionPorts
): void {
  switch (action.command) {
    case "find":
      ports.openSearch();
      break;
    case "command-blocks":
      ports.jumpBlock(action.dir);
      break;
    case "split-pane":
      ports.splitPane(action.vertical, ports.currentCwd() ?? undefined);
      break;
    case "focus-pane":
      ports.focusPane(action.dir);
      break;
    case "resize-pane":
      ports.resizePane(action.dir);
      break;
    case "zoom-pane":
      ports.zoomPane();
      break;
    case "toggle-broadcast":
      if (ports.toggleBroadcast().refused === "sharing") {
        ports.writeBroadcastRefusal();
      }
      break;
    case "scroll-end":
      if (action.dir === 1) ports.scrollToBottom();
      else ports.scrollToTop();
      break;
  }
}

export interface TerminalBlockNavigationPorts {
  blocks: () => readonly Block[];
  selected: () => Block | null;
  select: (block: Block) => void;
  scrollToLine: (line: number) => void;
}

export function navigateTerminalBlock(
  direction: -1 | 1,
  ports: TerminalBlockNavigationPorts
): Block | null {
  const blocks = ports.blocks();
  if (blocks.length === 0) return null;
  const selected = ports.selected();
  const currentIndex = selected
    ? blocks.findIndex((block) => block.id === selected.id)
    : blocks.length - 1;
  const nextIndex = Math.min(
    Math.max(currentIndex + direction, 0),
    blocks.length - 1
  );
  const target = blocks[nextIndex];
  ports.select(target);
  ports.scrollToLine(Math.max(0, target.start.line - 1));
  return target;
}

export interface TerminalBroadcastPorts {
  enabled: () => boolean;
  currentPane: string;
  paneIds: () => readonly string[];
  writePane: (paneId: string, data: string) => void;
}

export function broadcastTerminalInput(
  data: string | Uint8Array,
  ports: TerminalBroadcastPorts
): number {
  if (!ports.enabled()) return 0;
  const paneIds = ports.paneIds();
  if (paneIds.length < 2) return 0;
  const text =
    typeof data === "string"
      ? data
      : Array.from(data, (byte) => String.fromCharCode(byte)).join("");
  let writes = 0;
  for (const paneId of paneIds) {
    if (paneId === ports.currentPane) continue;
    ports.writePane(paneId, text);
    writes += 1;
  }
  return writes;
}
