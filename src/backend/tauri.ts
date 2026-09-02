import { invoke } from "@tauri-apps/api/core";
import {
  createTauriTerminal,
  transferPull,
  transferPush,
} from "@tabverse/runtime-desktop/terminal";
import type { Backend } from "./types";

export const tauriBackend: Backend = {
  kind: "tauri",
  createTerminal: createTauriTerminal,
  homeDir: () => invoke<string>("home_dir"),
  transferPull,
  transferPush,
};
