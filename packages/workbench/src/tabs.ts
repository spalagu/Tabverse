import type { TabContribution } from "@tabverse/tab-contracts";
import type { TabType } from "@tabverse/runtime-contracts";

export interface TabDefinition {
  readonly type: TabType;
  readonly label: string;
  readonly hint: string;
  readonly icon: string;
  readonly order?: number;
  readonly groupLabel?: string;
  readonly launch?: "tab" | "dialog";
  readonly creation?: {
    readonly field: string;
    readonly fieldLabel: string;
    readonly placeholder: string;
    readonly submitLabel: string;
    readonly defaultScheme?: string;
  };
}

/** Project UI metadata from enabled contributions; no kind list lives here. */
export function tabDefinitionsFromContributions(
  contributions: readonly TabContribution<unknown>[],
  options: { readonly remoteOnly?: boolean } = {},
): readonly TabDefinition[] {
  return contributions
    .filter((contribution) => !options.remoteOnly || contribution.remote !== undefined)
    .map(({ manifest }) => ({ type: manifest.kind, ...manifest.presentation }))
    .sort((left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.type.localeCompare(right.type),
    );
}
