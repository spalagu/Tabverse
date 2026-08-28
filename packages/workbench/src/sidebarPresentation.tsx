import type { ComponentType, ReactNode } from "react";
import type { TabType } from "@tabverse/runtime-contracts";

export interface WorkbenchTabRow {
  readonly id: string;
  readonly type: TabType;
  readonly title: string;
  readonly groupId: string | null;
  readonly url?: string;
  readonly pinnedUrl?: string;
  readonly dormant?: true;
  readonly attention?: boolean;
  readonly remoteViewers?: number;
}

export interface WorkbenchGroupHead {
  readonly name: string;
  readonly collapsed: boolean;
}

export interface WorkbenchSidebarTreeGroup extends WorkbenchGroupHead {
  readonly id: string;
  readonly parentId?: string;
}

export interface WorkbenchSidebarTreeTab {
  readonly id: string;
  readonly groupId: string | null;
}

/** Root groups in source order. A dangling parent degrades to a root so its
 * tabs remain reachable instead of disappearing behind a missing node. */
export function rootGroups<T extends { id: string; parentId?: string }>(
  groups: T[],
): T[] {
  return groups.filter(
    (group) =>
      group.parentId === undefined ||
      !groups.some((candidate) => candidate.id === group.parentId),
  );
}

/** A group's tabs in the exact order the sidebar draws its subtree: child
 * folders first, recursively, then this folder's own rows. Corrupt cycles
 * are ignored after their first visit. */
export function subtreeTabs<
  Tab extends { groupId: string | null },
  Group extends { id: string; parentId?: string },
>(tabs: Tab[], groups: Group[], groupId: string): Tab[] {
  const out: Tab[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of groups) {
      if (child.parentId === id) walk(child.id);
    }
    out.push(...tabs.filter((tab) => tab.groupId === id));
  };
  walk(groupId);
  return out;
}

type TabIcon = ComponentType<{ className?: string }>;
type FolderIcon = ComponentType<{ open: boolean }>;

/** Pure, shared sidebar content. State, native APIs and network transport stay
 * in the entry adapters that supply this component's factual props. */
export function TabRowPresentation({
  tab,
  Icon,
  favicon,
  titleSlot,
  subtitleSlot,
  deviationHint,
  attentionHint,
  broadcastHint,
  broadcasting,
  remoteBadge,
  viewersHint,
}: {
  tab: WorkbenchTabRow;
  Icon: TabIcon;
  favicon: string | null;
  titleSlot?: ReactNode;
  subtitleSlot?: ReactNode;
  deviationHint: string;
  attentionHint: string;
  broadcastHint: string;
  broadcasting: boolean;
  remoteBadge?: { label: string; title: string };
  viewersHint: string;
}) {
  const deviated =
    tab.type === "browser" &&
    tab.groupId !== null &&
    tab.dormant !== true &&
    tab.pinnedUrl !== undefined &&
    tab.url !== undefined &&
    tab.url !== tab.pinnedUrl;
  const viewers =
    tab.type === "remote" && (tab.remoteViewers ?? 0) > 0
      ? tab.remoteViewers
      : null;

  return (
    <>
      {favicon !== null ? (
        <img className="tab-icon tab-favicon" src={favicon} alt="" />
      ) : (
        <Icon className="tab-icon" />
      )}
      {titleSlot !== undefined ? (
        titleSlot
      ) : (
        <span className="tab-lines">
          <span className="tab-title">
            {deviated && (
              <span className="tab-deviation" title={deviationHint}>
                /
              </span>
            )}
            {tab.title}
          </span>
          {subtitleSlot}
        </span>
      )}
      {tab.attention && <span className="attention-dot" title={attentionHint} />}
      {tab.type === "terminal" && broadcasting && (
        <span className="tab-broadcast-dot" title={broadcastHint} />
      )}
      {remoteBadge !== undefined && (
        <span className="tab-remote-badge" title={remoteBadge.title}>
          {remoteBadge.label}
        </span>
      )}
      {viewers !== null && <span className="viewers-badge" title={viewersHint}>{viewers}</span>}
    </>
  );
}

export function GroupHeadPresentation({
  group,
  count,
  color,
  FolderIcon,
  titleSlot,
  afterTitleSlot,
}: {
  group: WorkbenchGroupHead;
  count: number;
  color: string;
  FolderIcon: FolderIcon;
  titleSlot?: ReactNode;
  afterTitleSlot?: ReactNode;
}) {
  return (
    <>
      <span className="group-folder" style={{ color }}>
        <FolderIcon open={!group.collapsed} />
      </span>
      {titleSlot !== undefined ? titleSlot : <span className="group-name">{group.name}</span>}
      {afterTitleSlot}
      <span className="group-count">{count}</span>
    </>
  );
}

/**
 * The runtime-neutral walk for a sidebar's pinned group tree. Hosts provide
 * interaction wrappers and row details; this component keeps nesting,
 * collapsed-subtree order and member order identical for every Workbench
 * entry point.
 */
export function SidebarTreePresentation<
  Tab extends WorkbenchSidebarTreeTab,
  Group extends WorkbenchSidebarTreeGroup,
>({
  group,
  groups,
  tabs,
  depth = 0,
  className,
  subtreeTabs,
  countForGroup,
  renderGroupHead,
  renderTab,
  renderExpandedTail,
  shouldRenderCollapsedTab,
}: {
  group: Group;
  groups: Group[];
  tabs: Tab[];
  depth?: number;
  className: string;
  subtreeTabs: (tabs: Tab[], groups: Group[], groupId: string) => Tab[];
  countForGroup?: (context: { group: Group; subtree: Tab[] }) => number;
  renderGroupHead: (context: { group: Group; count: number; depth: number }) => ReactNode;
  renderTab: (context: { tab: Tab; depth: number; peek: boolean }) => ReactNode;
  renderExpandedTail?: (context: { group: Group; depth: number }) => ReactNode;
  shouldRenderCollapsedTab?: (tab: Tab) => boolean;
}) {
  // Corrupt parent links must not recurse forever. The host can still render
  // the remaining sidebar outside this branch.
  if (depth > groups.length) return null;
  const children = groups.filter((candidate) => candidate.parentId === group.id);
  const members = tabs.filter((tab) => tab.groupId === group.id);
  const subtree = subtreeTabs(tabs, groups, group.id);
  const count = countForGroup?.({ group, subtree }) ?? subtree.length;

  return (
    <div
      className={`workbench-sidebar-tree-group ${className}`}
      data-collapsed={group.collapsed}
    >
      {renderGroupHead({ group, count, depth })}
      {group.collapsed ? (
        subtree
          .filter((tab) => shouldRenderCollapsedTab?.(tab) ?? true)
          .map((tab) => (
            <SidebarTreeTabSlot key={tab.id} tab={tab} depth={depth} peek renderTab={renderTab} />
          ))
      ) : (
        <>
          {children.map((child) => (
            <SidebarTreePresentation
              key={child.id}
              group={child}
              groups={groups}
              tabs={tabs}
              depth={depth + 1}
              className={className}
              subtreeTabs={subtreeTabs}
              countForGroup={countForGroup}
              renderGroupHead={renderGroupHead}
              renderTab={renderTab}
              renderExpandedTail={renderExpandedTail}
              shouldRenderCollapsedTab={shouldRenderCollapsedTab}
            />
          ))}
          {members.map((tab) => (
            <SidebarTreeTabSlot key={tab.id} tab={tab} depth={depth} peek={false} renderTab={renderTab} />
          ))}
          {renderExpandedTail?.({ group, depth })}
        </>
      )}
    </div>
  );
}

function SidebarTreeTabSlot<Tab extends WorkbenchSidebarTreeTab>({
  tab,
  depth,
  peek,
  renderTab,
}: {
  tab: Tab;
  depth: number;
  peek: boolean;
  renderTab: (context: { tab: Tab; depth: number; peek: boolean }) => ReactNode;
}) {
  return <>{renderTab({ tab, depth, peek })}</>;
}
