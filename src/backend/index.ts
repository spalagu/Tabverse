import { mockBackend } from "./mock";
import { tauriBackend } from "./tauri";
import type { Backend } from "./types";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const backend: Backend = isTauri ? tauriBackend : mockBackend;
export type { Backend, TermHandle, CreateTermOpts } from "./types";
