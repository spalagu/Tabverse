import { STR } from "../strings";
import { createMockTerminal } from "@tabverse/runtime-desktop/terminal";
import type { ShareAccess, Backend } from "./types";

export interface MockShareStarted {
  shareId: string;
  ticket: string;
  viewers: { id: number; name: string; access: ShareAccess }[];
}

export function mockShareStart(
  access: ShareAccess,
  levels: readonly ShareAccess[]
): MockShareStarted {
  const ticket = `tabvdemo${"ticketticket".repeat(6)}demo`;
  const other = levels.find((level) => level !== access) ?? access;
  return {
    shareId: `demo-share-${crypto.randomUUID()}`,
    ticket,
    viewers: [
      { id: 1, name: "tabverse@demo-mac", access },
      { id: 2, name: "Safari (web)", access: other },
    ],
  };
}

export const mockBackend: Backend = {
  kind: "mock",
  createTerminal: createMockTerminal,
  homeDir: () => Promise.resolve("/home/demo"),
  transferPull: () => Promise.reject(new Error(STR.term.demoNoTransfer)),
  transferPush: () => Promise.reject(new Error(STR.term.demoNoTransfer)),
};
