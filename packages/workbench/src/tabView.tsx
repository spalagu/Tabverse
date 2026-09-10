import type { ReactNode } from "react";
import type { TabType } from "@tabverse/runtime-contracts";
import { tabDefinition } from "./tabs";

/** The renderer-facing facts shared by desktop and remote tab models. */
export interface WorkbenchTabViewModel {
  readonly id: string;
  readonly type: TabType;
  readonly title: string;
}

export interface WorkbenchTabViewRenderArgs<
  TTab extends WorkbenchTabViewModel,
  TContext,
> {
  readonly tab: TTab;
  readonly active: boolean;
  readonly context: TContext;
}

export type WorkbenchTabViewRenderer<
  TTab extends WorkbenchTabViewModel,
  TContext,
> = (args: WorkbenchTabViewRenderArgs<TTab, TContext>) => ReactNode;

/**
 * Every application entry must account for every registered tab type.
 * Adding a TabType therefore fails compilation until both runtime paths make
 * their support or unsupported state explicit.
 */
export type WorkbenchTabViewRenderers<
  TTab extends WorkbenchTabViewModel,
  TContext,
> = Readonly<Record<TabType, WorkbenchTabViewRenderer<TTab, TContext>>>;

/** Identity helper that preserves the exhaustive Record check at definition. */
export function defineTabViewRenderers<
  TTab extends WorkbenchTabViewModel,
  TContext,
>(
  renderers: WorkbenchTabViewRenderers<TTab, TContext>,
): WorkbenchTabViewRenderers<TTab, TContext> {
  return renderers;
}

export function renderWorkbenchTabView<
  TTab extends WorkbenchTabViewModel,
  TContext,
>(
  tab: TTab,
  active: boolean,
  context: TContext,
  renderers: WorkbenchTabViewRenderers<TTab, TContext>,
): ReactNode {
  // Resolve through the canonical registry as well as the exhaustive map.
  // This makes an invalid runtime value fail at the shared boundary.
  tabDefinition(tab.type);
  return renderers[tab.type]({ tab, active, context });
}

/** The only tab-type dispatch component used by application entries. */
export function WorkbenchTabHost<
  TTab extends WorkbenchTabViewModel,
  TContext,
>({
  tab,
  active,
  context,
  renderers,
}: {
  readonly tab: TTab;
  readonly active: boolean;
  readonly context: TContext;
  readonly renderers: WorkbenchTabViewRenderers<TTab, TContext>;
}) {
  return renderWorkbenchTabView(tab, active, context, renderers);
}
