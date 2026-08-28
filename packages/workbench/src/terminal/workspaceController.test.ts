import { describe, expect, it, vi } from "vitest";
import type { Block } from "./blocks";
import {
  broadcastTerminalInput,
  navigateTerminalBlock,
  runTerminalWorkspaceAction,
} from "./workspaceController";

function actionPorts() {
  return {
    openSearch: vi.fn(),
    jumpBlock: vi.fn(),
    currentCwd: vi.fn((): string | null => "/repo"),
    splitPane: vi.fn(),
    focusPane: vi.fn(),
    resizePane: vi.fn(),
    zoomPane: vi.fn(),
    toggleBroadcast: vi.fn((): { refused?: string } => ({})),
    writeBroadcastRefusal: vi.fn(),
    scrollToTop: vi.fn(),
    scrollToBottom: vi.fn(),
  };
}

describe("terminal workspace actions", () => {
  it("routes pane actions with the shell cwd", () => {
    const ports = actionPorts();
    runTerminalWorkspaceAction(
      { command: "split-pane", vertical: true },
      ports
    );
    runTerminalWorkspaceAction(
      { command: "focus-pane", dir: "left" },
      ports
    );
    runTerminalWorkspaceAction(
      { command: "resize-pane", dir: "down" },
      ports
    );
    expect(ports.splitPane).toHaveBeenCalledWith(true, "/repo");
    expect(ports.focusPane).toHaveBeenCalledWith("left");
    expect(ports.resizePane).toHaveBeenCalledWith("down");
  });

  it("surfaces a sharing refusal when broadcast cannot be enabled", () => {
    const ports = actionPorts();
    ports.toggleBroadcast.mockReturnValue({ refused: "sharing" });
    runTerminalWorkspaceAction({ command: "toggle-broadcast" }, ports);
    expect(ports.writeBroadcastRefusal).toHaveBeenCalledOnce();
  });

  it("routes search, block, zoom, and scroll actions", () => {
    const ports = actionPorts();
    runTerminalWorkspaceAction({ command: "find" }, ports);
    runTerminalWorkspaceAction(
      { command: "command-blocks", dir: -1 },
      ports
    );
    runTerminalWorkspaceAction({ command: "zoom-pane" }, ports);
    runTerminalWorkspaceAction({ command: "scroll-end", dir: -1 }, ports);
    runTerminalWorkspaceAction({ command: "scroll-end", dir: 1 }, ports);
    expect(ports.openSearch).toHaveBeenCalledOnce();
    expect(ports.jumpBlock).toHaveBeenCalledWith(-1);
    expect(ports.zoomPane).toHaveBeenCalledOnce();
    expect(ports.scrollToTop).toHaveBeenCalledOnce();
    expect(ports.scrollToBottom).toHaveBeenCalledOnce();
  });
});

function block(id: number, line: number): Block {
  return {
    id,
    command: `command-${id}`,
    start: { line } as Block["start"],
    startedAt: 0,
  };
}

describe("terminal block navigation", () => {
  it("steps and clamps against live blocks", () => {
    const blocks = [block(1, 0), block(2, 8), block(3, 20)];
    let selected: Block | null = blocks[1];
    const select = vi.fn((next: Block) => {
      selected = next;
    });
    const scrollToLine = vi.fn();
    const ports = {
      blocks: () => blocks,
      selected: () => selected,
      select,
      scrollToLine,
    };
    expect(navigateTerminalBlock(1, ports)).toBe(blocks[2]);
    expect(navigateTerminalBlock(1, ports)).toBe(blocks[2]);
    expect(navigateTerminalBlock(-1, ports)).toBe(blocks[1]);
    expect(scrollToLine).toHaveBeenLastCalledWith(7);
  });

  it("does nothing without a live block", () => {
    const select = vi.fn();
    expect(
      navigateTerminalBlock(1, {
        blocks: () => [],
        selected: () => null,
        select,
        scrollToLine: vi.fn(),
      })
    ).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });
});

describe("terminal broadcast", () => {
  it("fans string and binary input out to sibling panes", () => {
    const writePane = vi.fn();
    const ports = {
      enabled: () => true,
      currentPane: "pane-b",
      paneIds: () => ["pane-a", "pane-b", "pane-c"],
      writePane,
    };
    expect(broadcastTerminalInput("x", ports)).toBe(2);
    expect(broadcastTerminalInput(new Uint8Array([0x1b, 0x5b]), ports)).toBe(2);
    expect(writePane).toHaveBeenNthCalledWith(1, "pane-a", "x");
    expect(writePane).toHaveBeenNthCalledWith(4, "pane-c", "\x1b[");
  });

  it("does not fan out while disabled or without a sibling", () => {
    const writePane = vi.fn();
    expect(
      broadcastTerminalInput("x", {
        enabled: () => false,
        currentPane: "pane-a",
        paneIds: () => ["pane-a", "pane-b"],
        writePane,
      })
    ).toBe(0);
    expect(
      broadcastTerminalInput("x", {
        enabled: () => true,
        currentPane: "pane-a",
        paneIds: () => ["pane-a"],
        writePane,
      })
    ).toBe(0);
    expect(writePane).not.toHaveBeenCalled();
  });
});
