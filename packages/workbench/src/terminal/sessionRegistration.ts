export interface TerminalSessionHandle {
  write: (data: string) => void;
  detach: () => Promise<void>;
}

export interface TerminalSessionApi {
  size: () => { cols: number; rows: number };
  serialize: () => string;
  focus: () => void;
  runCommand: (command: string) => void;
  write: (data: string) => void;
  detach: () => Promise<void>;
  openSearch: () => void;
  setViewerCap: (viewport: { cols: number; rows: number } | null) => void;
  cwd: () => string | null;
  debugLastBlockOutput?: () => { command: string; output: string } | null;
  debugWriteOutput?: (data: string) => void;
  debugThemeBackground?: () => string;
  debugPersistNow?: () => void;
}

export interface TerminalSessionRegistrationPorts {
  handle: TerminalSessionHandle;
  register: (api: TerminalSessionApi) => void;
  size: TerminalSessionApi["size"];
  serialize: TerminalSessionApi["serialize"];
  focus: TerminalSessionApi["focus"];
  openSearch: TerminalSessionApi["openSearch"];
  setViewerCap: TerminalSessionApi["setViewerCap"];
  cwd: TerminalSessionApi["cwd"];
  debugLastBlockOutput?: TerminalSessionApi["debugLastBlockOutput"];
  debugWriteOutput?: TerminalSessionApi["debugWriteOutput"];
  debugThemeBackground?: TerminalSessionApi["debugThemeBackground"];
  debugPersistNow?: TerminalSessionApi["debugPersistNow"];
  primary: boolean;
  handoverCommand?: string;
  handoverDone: () => boolean;
  markHandoverDone: () => void;
}

/**
 * Publishes the live terminal API and delivers a tab-level handover command
 * exactly once to the primary pane after its shell exists.
 */
export function installTerminalSessionRegistration(
  ports: TerminalSessionRegistrationPorts
): TerminalSessionApi {
  const api: TerminalSessionApi = {
    size: ports.size,
    serialize: ports.serialize,
    focus: ports.focus,
    runCommand: (command) => ports.handle.write(`${command}\n`),
    write: (data) => ports.handle.write(data),
    detach: () => ports.handle.detach(),
    openSearch: ports.openSearch,
    setViewerCap: ports.setViewerCap,
    cwd: ports.cwd,
    ...(ports.debugLastBlockOutput === undefined
      ? {}
      : { debugLastBlockOutput: ports.debugLastBlockOutput }),
    ...(ports.debugWriteOutput === undefined
      ? {}
      : { debugWriteOutput: ports.debugWriteOutput }),
    ...(ports.debugThemeBackground === undefined
      ? {}
      : { debugThemeBackground: ports.debugThemeBackground }),
    ...(ports.debugPersistNow === undefined
      ? {}
      : { debugPersistNow: ports.debugPersistNow }),
  };
  ports.register(api);

  if (
    ports.primary &&
    ports.handoverCommand !== undefined &&
    ports.handoverCommand !== "" &&
    !ports.handoverDone()
  ) {
    ports.markHandoverDone();
    ports.handle.write(`${ports.handoverCommand}\n`);
  }
  return api;
}
