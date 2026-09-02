import type {
  CreateTermOpts,
  TermHandle,
} from "@tabverse/runtime-desktop/terminal";

export { type ShareAccess, type RemoteHostMsgPayload } from "@tabverse/runtime-contracts";
export type {
  CreateTermOpts,
  TermEventPayload,
  TermHandle,
} from "@tabverse/runtime-desktop/terminal";

export interface Backend {
  readonly kind: "tauri" | "mock" | "remote";
  createTerminal(opts: CreateTermOpts): Promise<TermHandle>;
  homeDir(): Promise<string>;
  transferPull(host: string, remotePath: string): Promise<string>;
  transferPush(
    host: string,
    dir: string,
    name: string,
    dataB64: string
  ): Promise<void>;
}
