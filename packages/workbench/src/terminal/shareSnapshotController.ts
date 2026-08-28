export const TERMINAL_SHARE_SNAPSHOT_SCROLLBACK = 1000;

export interface TerminalShareSnapshot {
  shareId: string;
  viewer: number;
  b64Data: string;
  cols: number;
  rows: number;
}

export interface TerminalShareSnapshotControllerPorts {
  currentShareId: () => string | null;
  write: (data: string, callback: () => void) => void;
  serialize: (options: { scrollback: number }) => string;
  encode: (value: string) => string;
  size: () => { cols: number; rows: number };
  send: (snapshot: TerminalShareSnapshot) => Promise<void>;
  reportError: (error: unknown) => void;
}

export interface TerminalShareSnapshotController {
  handleRequest: (viewer: number) => void;
}

/**
 * Produces a bounded, parse-complete terminal snapshot for a joining viewer.
 * Transport and share ownership are host ports; queue ordering and payload
 * shape are shared terminal behavior.
 */
export function createTerminalShareSnapshotController(
  ports: TerminalShareSnapshotControllerPorts
): TerminalShareSnapshotController {
  return {
    handleRequest: (viewer) => {
      const shareId = ports.currentShareId();
      if (shareId === null) return;
      // xterm parses writes asynchronously. Queue the capture behind every
      // byte already handed to the terminal so the joiner sees no gap.
      ports.write("", () => {
        const { cols, rows } = ports.size();
        const b64Data = ports.encode(
          ports.serialize({
            scrollback: TERMINAL_SHARE_SNAPSHOT_SCROLLBACK,
          })
        );
        void ports
          .send({ shareId, viewer, b64Data, cols, rows })
          .catch(ports.reportError);
      });
    },
  };
}
