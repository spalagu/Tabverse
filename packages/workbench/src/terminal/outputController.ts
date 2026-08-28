export const TERMINAL_OUTPUT_REPORT_INTERVAL_MS = 5000;

export interface TerminalOutputControllerPorts {
  disposed: () => boolean;
  onData: (listener: (data: Uint8Array) => void) => void;
  onExit: (listener: (code: number | null) => void) => void;
  write: (data: string | Uint8Array) => void;
  endSpawnWait: () => void;
  markMemoryOutput: () => void;
  scheduleMemorySave: () => void;
  reportOutputAt: (timestamp: number) => void;
  handleExit: (code: number | null) => string | null;
  now?: () => number;
}

/**
 * Installs the PTY output lifecycle shared by every desktop terminal pane.
 * Store-specific exit policy is a host port; ordering, throttling and memory
 * updates stay consistent here.
 */
export function installTerminalOutputController(
  ports: TerminalOutputControllerPorts
): void {
  const now = ports.now ?? Date.now;
  let firstByteSeen = false;
  let outputReportedAt = 0;

  const finishSpawn = () => {
    if (firstByteSeen) return;
    firstByteSeen = true;
    ports.endSpawnWait();
  };

  ports.onData((data) => {
    if (ports.disposed()) return;
    finishSpawn();
    ports.markMemoryOutput();
    const timestamp = now();
    if (timestamp - outputReportedAt > TERMINAL_OUTPUT_REPORT_INTERVAL_MS) {
      outputReportedAt = timestamp;
      ports.reportOutputAt(timestamp);
    }
    ports.write(data);
    ports.scheduleMemorySave();
  });

  ports.onExit((code) => {
    if (ports.disposed()) return;
    finishSpawn();
    ports.markMemoryOutput();
    const finalOutput = ports.handleExit(code);
    if (finalOutput === null) return;
    ports.write(finalOutput);
    ports.scheduleMemorySave();
  });
}
