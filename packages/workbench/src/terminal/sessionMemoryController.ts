import {
  TERM_MEMORY_SCROLLBACK,
  buildTermMemory,
  nextSaveDelay,
  restoreWrite,
  shouldWriteRestore,
  type TermMemory,
} from "./sessionMemory";

export interface TerminalSessionMemoryPorts {
  load: Promise<TermMemory | null>;
  serialize: (options: {
    scrollback: number;
    excludeAltBuffer: boolean;
    excludeModes: boolean;
  }) => string;
  cwd: () => string | null;
  cols: () => number;
  write: (data: string, callback?: () => void) => void;
  save: (memory: TermMemory) => void;
  remove: () => void;
  flush: () => void | Promise<void>;
  disposed: () => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface TerminalSessionMemoryController {
  loadedMemory: () => TermMemory | null;
  markSized: () => void;
  markOutput: () => void;
  capture: () => void;
  saveNow: () => void;
  scheduleSave: () => void;
  flushOnExit: () => void;
  dispose: () => void;
}

/**
 * Owns the lifecycle of a terminal's persisted transcript.
 *
 * The controller deliberately knows nothing about React, Tauri, tabs or pane
 * trees. The host decides when a pane is gone and where close events come
 * from; this state machine only coordinates xterm parsing, save cadence and
 * the race between a restored transcript and the new shell's first output.
 */
export function createTerminalSessionMemoryController(
  ports: TerminalSessionMemoryPorts
): TerminalSessionMemoryController {
  let memory: TermMemory | null = null;
  let outputSeen = false;
  let restoreWritten = false;
  let sized = false;
  let saveTimer: unknown | null = null;
  let dirtySince = 0;
  let stored = false;
  const now = ports.now ?? Date.now;
  const setTimer =
    ports.setTimer ??
    ((callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay));
  const clearTimer =
    ports.clearTimer ??
    ((timer: unknown) =>
      globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>));

  const capture = () => {
    if (ports.disposed()) return;
    const next = buildTermMemory(
      ports.serialize({
        scrollback: TERM_MEMORY_SCROLLBACK,
        excludeAltBuffer: true,
        excludeModes: true,
      }),
      ports.cwd()
    );
    if (next) {
      ports.save(next);
      stored = true;
    } else if (stored) {
      ports.remove();
      stored = false;
    }
  };

  const cancelSave = () => {
    if (saveTimer !== null) {
      clearTimer(saveTimer);
      saveTimer = null;
    }
    dirtySince = 0;
  };

  const saveNow = () => {
    cancelSave();
    if (ports.disposed()) return;
    // xterm parses writes asynchronously. Queueing capture behind an empty
    // write ensures the serialized buffer includes all preceding output.
    ports.write("", capture);
  };

  const scheduleSave = () => {
    if (ports.disposed()) return;
    const current = now();
    if (dirtySince === 0) dirtySince = current;
    if (saveTimer !== null) clearTimer(saveTimer);
    saveTimer = setTimer(
      saveNow,
      nextSaveDelay(current, dirtySince)
    );
  };

  const tryRestore = () => {
    if (
      !sized ||
      !shouldWriteRestore(memory, {
        disposed: ports.disposed(),
        outputSeen,
        alreadyWritten: restoreWritten,
      })
    ) {
      return;
    }
    restoreWritten = true;
    ports.write(restoreWrite(memory!, ports.cols()));
  };

  void ports.load.then((loaded) => {
    memory = loaded;
    tryRestore();
  });

  return {
    loadedMemory: () => memory,
    markSized: () => {
      sized = true;
      tryRestore();
    },
    markOutput: () => {
      outputSeen = true;
    },
    capture,
    saveNow,
    scheduleSave,
    flushOnExit: () => {
      cancelSave();
      capture();
      void ports.flush();
    },
    dispose: cancelSave,
  };
}
