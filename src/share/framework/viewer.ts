import type { ComponentType } from "react";
import { shareCapability, type ViewerFold } from "./capability";
import type { TabType } from "../../state/store";

export type { ViewerFold };

export interface ViewerPaneProps {
  state: unknown;
}

export interface ViewerRegistration {
  Pane: ComponentType<ViewerPaneProps>;
  fold: ViewerFold<unknown>;
}

/** The dom pane registered for a tab type, or null: not shareable, grid
 * payload (built-in xterm path), or a declaration that never named one. */
export function viewerPaneFor(type: TabType): ViewerRegistration | null {
  const cap = shareCapability(type);
  if (!cap.shareable || cap.payload !== "dom") return null;
  return cap.viewer ?? null;
}
