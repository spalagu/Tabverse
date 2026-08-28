import type { ReactNode } from "react";
import {
  GroupHeadPresentation,
  TabRowPresentation,
} from "@tabverse/workbench/sidebar";
import { useFavicon } from "../favicons";
import { shortHost } from "@tabverse/workbench/terminal/remote-state";
import { groupColor, type Group, type Tab, useStore } from "../state/store";
import { STR } from "../strings";
import { FolderIcon, TAB_ICONS } from "./icons";

/**
 * Desktop adapter for the shared Workbench tab-row presentation.
 * Desktop-only state (favicons, remote host and broadcast status) stays here;
 * the markup and class contract are owned by packages/workbench.
 */
export function TabRowContent({
  tab,
  titleSlot,
  subtitleSlot,
}: {
  tab: Tab;
  titleSlot?: ReactNode;
  subtitleSlot?: ReactNode;
}) {
  const Icon = TAB_ICONS[tab.type];
  const favicon = useFavicon(
    tab.type === "browser" ? tab.url : undefined,
    tab.id,
  );
  const broadcasting = useStore((state) =>
    tab.type === "terminal" ? state.broadcastTabs?.[tab.id] === true : false,
  );
  const remote = useStore((state) =>
    tab.type === "terminal" ? state.remoteTabs?.[tab.id] : undefined,
  );
  const remoteBadge =
    tab.type === "terminal" && remote
      ? {
          label: shortHost(remote.host ?? ""),
          title: STR.common.sidebar.remoteHint({ host: remote.host ?? "" }),
        }
      : undefined;

  return (
    <TabRowPresentation
      tab={tab}
      Icon={Icon}
      favicon={favicon}
      titleSlot={titleSlot}
      subtitleSlot={subtitleSlot}
      deviationHint={STR.common.sidebar.deviationHint}
      attentionHint={STR.common.sidebar.attentionHint}
      broadcastHint={STR.common.sidebar.broadcastHint}
      broadcasting={broadcasting}
      remoteBadge={remoteBadge}
      viewersHint={STR.common.sidebar.viewersHint}
    />
  );
}

/** Desktop adapter for the shared Workbench group-header presentation. */
export function GroupHeadContent({
  group,
  count,
  titleSlot,
  afterTitleSlot,
}: {
  group: Group;
  count: number;
  titleSlot?: ReactNode;
  afterTitleSlot?: ReactNode;
}) {
  useStore((state) => state.resolvedTheme);

  return (
    <GroupHeadPresentation
      group={group}
      count={count}
      color={groupColor(group)}
      FolderIcon={FolderIcon}
      titleSlot={titleSlot}
      afterTitleSlot={afterTitleSlot}
    />
  );
}
