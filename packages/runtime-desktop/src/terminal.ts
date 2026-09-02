import { Channel, invoke } from "@tauri-apps/api/core";
import { b64decode, b64encode } from "@tabverse/remote-client/b64";

export type TermEventPayload =
  | { type: "data"; b64: string }
  | { type: "exit"; code: number | null }
  | { type: "snapshotRequest"; viewer: number };

export interface TermHandle {
  readonly id: string;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  detach(): Promise<void>;
  onData(callback: (data: Uint8Array) => void): () => void;
  onExit(callback: (code: number | null) => void): () => void;
  onSnapshotRequest(callback: (viewer: number) => void): () => void;
}

export interface CreateTermOpts {
  cols: number;
  rows: number;
  attachId?: string;
  cwd?: string;
  profile?: string;
  runOnStart?: string;
  tabId?: string;
  /** Stable identity of the owning Tab or split pane inside its worker. */
  ownerKey?: string;
  /** Supervisor-owned runtime selected before this pane asks for a PTY. */
  residentRuntimeId?: string;
}

/** Create a terminal backed by the desktop Tauri PTY commands. */
export async function createTauriTerminal(
  options: CreateTermOpts
): Promise<TermHandle> {
  const dataCallbacks = new Set<(data: Uint8Array) => void>();
  const exitCallbacks = new Set<(code: number | null) => void>();
  const snapshotCallbacks = new Set<(viewer: number) => void>();
  const backlog: Uint8Array[] = [];
  let exited: { code: number | null } | null = null;

  const channel = new Channel<TermEventPayload>();
  channel.onmessage = (message) => {
    if (message.type === "data") {
      const bytes = b64decode(message.b64);
      if (dataCallbacks.size === 0) backlog.push(bytes);
      else dataCallbacks.forEach((callback) => callback(bytes));
    } else if (message.type === "snapshotRequest") {
      snapshotCallbacks.forEach((callback) => callback(message.viewer));
    } else {
      exited = { code: message.code };
      exitCallbacks.forEach((callback) => callback(message.code));
    }
  };

  const id = options.attachId
    ? await invoke<string>("term_attach", {
        id: options.attachId,
        tabId: options.tabId ?? null,
        residentRuntimeId: options.residentRuntimeId ?? null,
        cols: options.cols,
        rows: options.rows,
        onEvent: channel,
      })
    : await invoke<string>("term_create", {
        cols: options.cols,
        rows: options.rows,
        tabId: options.tabId ?? null,
        ownerKey: options.ownerKey ?? null,
        residentRuntimeId: options.residentRuntimeId ?? null,
        cwd: options.cwd ?? null,
        profile: options.profile ?? null,
        runOnStart: options.runOnStart ?? null,
        onEvent: channel,
      });

  let detached = false;
  return {
    id,
    write(data) {
      void invoke("term_write", { id, dataB64: b64encode(data) });
    },
    resize(cols, rows) {
      void invoke("term_resize", { id, cols, rows });
    },
    kill() {
      if (!detached) void invoke("term_kill", { id }).catch(() => {});
    },
    async detach() {
      await invoke("term_detach", { id });
      detached = true;
    },
    onData(callback) {
      dataCallbacks.add(callback);
      for (const bytes of backlog.splice(0)) callback(bytes);
      return () => dataCallbacks.delete(callback);
    },
    onExit(callback) {
      exitCallbacks.add(callback);
      if (exited) callback(exited.code);
      return () => exitCallbacks.delete(callback);
    },
    onSnapshotRequest(callback) {
      snapshotCallbacks.add(callback);
      return () => snapshotCallbacks.delete(callback);
    },
  };
}

/** Create the plain-browser fake PTY used by the desktop UI harness. */
export async function createMockTerminal(
  options: CreateTermOpts
): Promise<TermHandle> {
  const encoder = new TextEncoder();
  const dataCallbacks = new Set<(data: Uint8Array) => void>();
  let line = "";
  let cwd = "/home/demo";

  const emit = (text: string) => {
    const bytes = encoder.encode(text);
    dataCallbacks.forEach((callback) => callback(bytes));
  };
  const base64 = (text: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const prompt = () => {
    emit(`\x1b]7;file://localhost${cwd}\x07`);
    emit("\x1b]133;A\x07");
    emit("\x1b[1;34m~\x1b[0m \x1b[1;32m❯\x1b[0m ");
    emit("\x1b]133;B\x07");
  };
  const finish = (code: number) => emit(`\x1b]133;D;${code}\x07`);
  const runLine = (command: string) => {
    const trimmed = command.trim();
    if (trimmed === "") {
      prompt();
      return;
    }
    emit(`\x1b]133;C;cmdline_b64=${base64(trimmed)}\x07`);
    let exitCode = 0;
    if (trimmed === "help") {
      emit("mock shell — this is the browser demo backend.\r\n");
      emit("The real app runs actual shells through a Rust PTY.\r\n");
      emit("Commands: help, clear, cd <dir>, fail, sleep <n>\r\n");
    } else if (trimmed === "clear") {
      emit("\x1b[2J\x1b[H");
    } else if (trimmed.startsWith("cd ")) {
      const target = trimmed.slice(3).trim();
      cwd = target.startsWith("/")
        ? target
        : `${cwd}/${target}`.replace(/\/+/g, "/");
    } else if (trimmed === "fail") {
      emit("mock: something went wrong\r\n");
      exitCode = 3;
    } else if (trimmed.startsWith("sleep ")) {
      const seconds = Number(trimmed.slice(6)) || 1;
      setTimeout(() => {
        emit(`slept ${seconds}s\r\n`);
        finish(0);
        prompt();
      }, seconds * 1000);
      return;
    } else {
      emit(`mock: executed \x1b[33m${trimmed}\x1b[0m\r\n`);
    }
    finish(exitCode);
    prompt();
  };

  setTimeout(() => {
    emit(
      `\x1b[1mTabverse\x1b[0m browser demo (${options.cols}x${options.rows}) — type \x1b[33mhelp\x1b[0m\r\n`
    );
    prompt();
  }, 10);

  return {
    id: crypto.randomUUID(),
    write(data) {
      const text =
        typeof data === "string" ? data : new TextDecoder().decode(data);
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          emit("\r\n");
          const command = line;
          line = "";
          runLine(command);
        } else if (character === "\x7f") {
          if (line.length > 0) {
            line = line.slice(0, -1);
            emit("\b \b");
          }
        } else if (character === "\x03") {
          line = "";
          emit("^C\r\n");
          prompt();
        } else if (character >= " " || character === "\t") {
          line += character;
          emit(character);
        }
      }
    },
    resize() {},
    kill() {},
    async detach() {},
    onData(callback) {
      dataCallbacks.add(callback);
      return () => dataCallbacks.delete(callback);
    },
    onExit() {
      return () => {};
    },
    onSnapshotRequest() {
      return () => {};
    },
  };
}

export const transferPull = (host: string, remotePath: string) =>
  invoke<string>("transfer_pull", { host, remotePath });

export const transferPush = (
  host: string,
  dir: string,
  name: string,
  dataB64: string
) => invoke<void>("transfer_push", { host, dir, name, dataB64 });

export interface SendTerminalShareSnapshotOptions {
  shareId: string;
  viewer: number;
  b64Data: string;
  cols: number;
  rows: number;
}

export const sendTerminalShareSnapshot = (
  options: SendTerminalShareSnapshotOptions
) => invoke<void>("share_snapshot", { ...options });
