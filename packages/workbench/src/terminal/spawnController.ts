export interface TerminalSpawnLaunch {
  profile?: string;
  runOnStart?: string;
}

export interface TerminalSpawnOptions extends TerminalSpawnLaunch {
  cols: number;
  rows: number;
  attachId?: string;
  tabId?: string;
  cwd?: string;
}

export interface TerminalSpawnControllerPorts<Handle> {
  size: () => { cols: number; rows: number };
  attachId: string | null;
  tabId: string | null;
  create: (options: TerminalSpawnOptions) => Promise<Handle>;
  reportCwdFailure: (cwd: string, error: unknown) => void;
  writeCwdFallback: (cwd: string) => void;
}

export interface TerminalSpawnController<Handle> {
  spawn: (
    cwd: string | undefined,
    launch: TerminalSpawnLaunch
  ) => Promise<Handle>;
}

/**
 * Creates a terminal without allowing a stale remembered directory to leave
 * the pane empty. Attach is a distinct operation and never inherits launch
 * fields intended for a new shell.
 */
export function createTerminalSpawnController<Handle>(
  ports: TerminalSpawnControllerPorts<Handle>
): TerminalSpawnController<Handle> {
  return {
    spawn: (cwd, launch) => {
      const { cols, rows } = ports.size();
      if (ports.attachId !== null) {
        return ports.create({
          cols,
          rows,
          attachId: ports.attachId,
          ...(ports.tabId === null ? {} : { tabId: ports.tabId }),
        });
      }

      const common: TerminalSpawnOptions = {
        cols,
        rows,
        ...(ports.tabId === null ? {} : { tabId: ports.tabId }),
        ...launch,
      };
      return ports.create({ ...common, ...(cwd === undefined ? {} : { cwd }) })
        .catch((error) => {
          if (cwd === undefined) throw error;
          ports.reportCwdFailure(cwd, error);
          ports.writeCwdFallback(cwd);
          return ports.create(common);
        });
    },
  };
}
