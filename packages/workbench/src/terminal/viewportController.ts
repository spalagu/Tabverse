export interface TerminalViewport {
  cols: number;
  rows: number;
}

export interface TerminalViewportControllerPorts {
  proposeDimensions: () => TerminalViewport | undefined;
  currentSize: () => TerminalViewport;
  resize: (cols: number, rows: number) => void;
  onSized: () => void;
}

export interface TerminalViewportController {
  fit: () => boolean;
  setViewerCap: (viewport: TerminalViewport | null) => void;
}

/**
 * Coordinates terminal sizing for both local panes and shared viewers.
 * Platform events stay with the host; every event feeds the same calculation
 * here so font changes, window resizes and remote caps cannot diverge.
 */
export function createTerminalViewportController(
  ports: TerminalViewportControllerPorts
): TerminalViewportController {
  let viewerCap: TerminalViewport | null = null;

  const fit = () => {
    const proposed = ports.proposeDimensions();
    if (
      proposed === undefined ||
      !Number.isFinite(proposed.cols) ||
      !Number.isFinite(proposed.rows)
    ) {
      return false;
    }

    let { cols, rows } = proposed;
    if (viewerCap !== null) {
      cols = Math.min(cols, viewerCap.cols);
      rows = Math.min(rows, viewerCap.rows);
    }
    cols = Math.max(cols, 2);
    rows = Math.max(rows, 2);

    const current = ports.currentSize();
    if (cols !== current.cols || rows !== current.rows) {
      ports.resize(cols, rows);
    }
    ports.onSized();
    return true;
  };

  return {
    fit,
    setViewerCap: (viewport) => {
      viewerCap = viewport;
      fit();
    },
  };
}
