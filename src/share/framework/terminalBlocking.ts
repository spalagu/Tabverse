import { paneCount } from "../../paneTree";
import { STR } from "../../strings";
import { useStore, type Tab } from "../../state/store";

export type TerminalShareBlock = "panes" | "broadcast" | null;

export function shareBlockedReason(tab: Tab | undefined): TerminalShareBlock {
  if (tab?.type !== "terminal") return null;
  if (tab.panes && paneCount(tab.panes) > 1) return "panes";
  if (useStore.getState().broadcastTabs[tab.id] === true) return "broadcast";
  return null;
}

export function shareBlockedText(reason: TerminalShareBlock): string | null {
  if (reason === "panes") return STR.common.sidebar.shareNeedsOnePane;
  if (reason === "broadcast") return STR.common.sidebar.shareNeedsNoBroadcast;
  return null;
}
