/** One host-owned command round trip supplied by a runtime adapter. */
export type HostRpc = (command: string, args: unknown) => Promise<unknown>;
