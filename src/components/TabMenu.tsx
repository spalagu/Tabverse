import { useEffect, useRef } from "react";
import {
  archivableByState,
  splittable,
  useStore,
  visibleOrdered,
  type Group,
  type SplitGroup,
  type Tab,
} from "../state/store";
import { toggleMute } from "../mediaControl";
import { STR } from "../strings";
import { confirmAsk } from "./Confirm";

/** A stable empty array, so the scriptCommands selector below never returns
 *  a fresh reference on a tab with no commands (which loops useSyncExternalStore). */
const NO_COMMANDS: Array<{ scriptId: string; cmdId: number; name: string }> = [];

export function canSplitWithActive(
  tab: Tab | undefined,
  activeTab: Tab | undefined,
  split: SplitGroup | null
): boolean {
  if (!splittable(tab) || !splittable(activeTab)) return false;
  if (tab.id === activeTab.id) return false;
  const sharing =
    split !== null && split.ids.includes(tab.id) && split.ids.includes(activeTab.id);
  return !sharing;
}

export function batchActionTabs(
  tabs: Tab[],
  groups: Group[],
  split: SplitGroup | null,
  selectedTabIds: readonly string[],
  menuTabId: string | undefined
): Tab[] | null {
  if (!menuTabId || !selectedTabIds.includes(menuTabId)) return null;
  const targets = visibleOrdered(tabs, groups, split).filter((t) =>
    selectedTabIds.includes(t.id)
  );
  return targets.length > 1 ? targets : null;
}

export function TabMenu() {
  const menu = useStore((s) => s.menu);
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.menu?.tabId));
  const closeMenu = useStore((s) => s.closeMenu);
  const assignToGroup = useStore((s) => s.assignToGroup);
  const closeTab = useStore((s) => s.closeTab);
  const duplicateTab = useStore((s) => s.duplicateTab);
  const pinTab = useStore((s) => s.pinTab);
  const setRenamingTab = useStore((s) => s.setRenamingTab);
  const setSaveTemplateFor = useStore((s) => s.setSaveTemplateFor);
  const splitWith = useStore((s) => s.splitWith);
  const unsplit = useStore((s) => s.unsplit);
  const split = useStore((s) => s.split);
  const activeTab = useStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId)
  );
  const ref = useRef<HTMLDivElement>(null);
  const presetGroup = useStore((s) =>
    s.groups.find((g) => g.preset === tab?.type)
  );
  const scriptCommands = useStore((s) =>
    tab ? s.scriptCommands[tab.id] ?? NO_COMMANDS : NO_COMMANDS
  );
  const muted = useStore((s) => (tab ? !!s.mutedTabs[tab.id] : false));
  const tabs = useStore((s) => s.tabs);
  const groups = useStore((s) => s.groups);
  const splitState = useStore((s) => s.split);
  const selectedTabIds = useStore((s) => s.selectedTabIds);
  const mutedTabs = useStore((s) => s.mutedTabs);
  const closeTabs = useStore((s) => s.closeTabs);
  const archiveTabs = useStore((s) => s.archiveTabs);
  const setTabResidentPolicy = useStore((s) => s.setTabResidentPolicy);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("mousedown", onDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("mousedown", onDown, { capture: true });
    };
  }, [menu, closeMenu]);

  if (!menu || !tab) return null;

  const inSplit = split !== null && split.ids.includes(tab.id);
  const canSplit = canSplitWithActive(tab, activeTab, split);

  const batch = batchActionTabs(tabs, groups, splitState, selectedTabIds, menu.tabId);
  if (batch) {
    const n = batch.length;
    // The shelf's own gate, asked through the store's one answer (the
    // same rule archiveTabs applies — a copy is a thing that disagrees):
    // today rows only, and the state guard.
    const shelfable = (t: Tab) => t.groupId === null && archivableByState(t);
    const toShelve = batch.filter(shelfable);
    const held = batch.filter((t) => !shelfable(t));
    // Mute is a page's own act: awake browser rows only — a dormant item
    // has no page to silence, and other kinds make no page sound.
    const mutable = batch.filter(
      (t) => t.type === "browser" && t.dormant !== true
    );
    const notIncluded = (rows: Tab[]) =>
      STR.common.tabMenu.batchNotIncluded({
        names: rows.map((t) => t.title).join(", "),
      });

    // Keep the menu on screen when the click happens near an edge.
    const width = 210;
    const height = 150;
    const bx = Math.min(menu.x, window.innerWidth - width - 8);
    const by = Math.min(menu.y, window.innerHeight - height - 8);

    return (
      <div className="ctx-menu" style={{ left: bx, top: by }} ref={ref}>
        <div className="ctx-title">
          {STR.common.tabMenu.pickedTabs({ n })}
        </div>
        <button
          className="ctx-item danger"
          onClick={() => {
            closeMenu();
            // Every row through closeTab's own branches; the destructive
            // kinds (settings, remote) are asked about alone, each in its
            // turn, through the ask-then-close shape the page's own
            // closeTabAsking established.
            void closeTabs(batch.map((t) => t.id), (t) =>
              confirmAsk(STR.common.tabMenu.closeFinalAsk({ title: t.title }), {
                confirmLabel: STR.common.close,
              })
            );
          }}
        >
          {STR.common.tabMenu.closeBatch({ n })}
        </button>
        {toShelve.length > 0 && (
          <button
            className="ctx-item"
            title={held.length > 0 ? notIncluded(held) : undefined}
            onClick={() => {
              closeMenu();
              // The store's gate decides on the far side too; these counts
              // are the announcement, its rule is the deed.
              archiveTabs(batch.map((t) => t.id));
            }}
          >
            {STR.common.tabMenu.archiveBatch({
              acting: toShelve.length,
              total: n,
            })}
          </button>
        )}
        {mutable.length > 0 && (
          <button
            className="ctx-item"
            title={
              mutable.length < n
                ? notIncluded(batch.filter((t) => t.type !== "browser" || t.dormant === true))
                : undefined
            }
            onClick={() => {
              closeMenu();
              // A set, not a toggle-per-row: the clicked tab's own state
              // names the direction, and only rows not already there flip
              // — each flip its own page call, N independent invocations,
              // no transaction (one failing says nothing about the next).
              const target = !muted;
              for (const t of mutable) {
                if (!!mutedTabs[t.id] !== target) toggleMute(t.id);
              }
              useStore.getState().clearSelection();
            }}
          >
            {(muted
              ? STR.common.tabMenu.unmuteBatch
              : STR.common.tabMenu.muteBatch)({ acting: mutable.length, total: n })}
          </button>
        )}
      </div>
    );
  }

  // Keep the menu on screen when the click happens near an edge.
  const width = 210;
  const height = 330;
  const x = Math.min(menu.x, window.innerWidth - width - 8);
  const y = Math.min(menu.y, window.innerHeight - height - 8);

  return (
    <div className="ctx-menu" style={{ left: x, top: y }} ref={ref}>
      <div className="ctx-title">{tab.title}</div>
      {canSplit && (
        <button className="ctx-item" onClick={() => splitWith(tab.id)}>
          {STR.common.tabMenu.splitWithActive}
        </button>
      )}
      {inSplit && (
        <button className="ctx-item" onClick={() => unsplit()}>
          {STR.common.tabMenu.unsplit}
        </button>
      )}
      {tab.groupId === null && presetGroup && (
        <button
          className="ctx-item"
          onClick={() => assignToGroup(tab.id, presetGroup.id)}
        >
          {STR.common.tabMenu.pin}
        </button>
      )}
      {tab.groupId !== null && (
        <button className="ctx-item" onClick={() => assignToGroup(tab.id, null)}>
          {STR.common.tabMenu.unpin}
        </button>
      )}
      {tab.type === "browser" &&
        tab.groupId !== null &&
        tab.dormant !== true &&
        tab.pinnedUrl !== undefined &&
        tab.url &&
        tab.url !== tab.pinnedUrl && (
          <button className="ctx-item" onClick={() => pinTab(tab.id)}>
            {STR.common.tabMenu.updatePinnedAddress}
          </button>
        )}
      {/* A pinned FILES tab re-anchors on its live browsing directory —
          same verb, same menu, different payload (pinTab's files arm). */}
      {tab.type === "files" && tab.groupId !== null && tab.dormant !== true && (
        <button className="ctx-item" onClick={() => pinTab(tab.id)}>
          {STR.common.tabMenu.updatePinnedAddress}
        </button>
      )}
      {tab.type !== "settings" &&
        tab.type !== "remote" &&
        tab.dormant !== true && (
          <button className="ctx-item" onClick={() => duplicateTab(tab.id)}>
            {STR.common.tabMenu.duplicate}
          </button>
        )}
      <button
        className="ctx-item"
        onClick={() => {
          setRenamingTab(tab.id);
          closeMenu();
        }}
      >
        {STR.common.tabMenu.rename}
      </button>
      {tab.type === "browser" && tab.dormant !== true && (
        <button
          className="ctx-item"
          onClick={() => {
            toggleMute(tab.id);
            closeMenu();
          }}
        >
          {muted ? STR.common.tabMenu.unmute : STR.common.tabMenu.mute}
        </button>
      )}
      {scriptCommands.length > 0 && (
        <>
          <div className="ctx-sep" />
          <div className="ctx-title">{STR.common.tabMenu.scriptCommands}</div>
          {scriptCommands.map((c) => (
            <button
              key={`${c.scriptId}:${c.cmdId}`}
              className="ctx-item"
              onClick={() => {
                void import("@tauri-apps/api/core").then(({ invoke }) =>
                  invoke("userscript_menu_click", {
                    tabId: tab.id,
                    scriptId: c.scriptId,
                    cmdId: c.cmdId,
                  }).catch(() => {})
                );
                closeMenu();
              }}
            >
              {c.name}
            </button>
          ))}
        </>
      )}
      {tab.type === "terminal" && tab.dormant !== true && (
        <button
          className="ctx-item"
          onClick={() => {
            setSaveTemplateFor(tab.id);
            closeMenu();
          }}
        >
          {STR.common.tabMenu.saveLayout}
        </button>
      )}
      <div className="ctx-sep" />
      <div className="ctx-title">{STR.common.tabMenu.residentPolicy}</div>
      {([
        ["inherit", STR.common.tabMenu.residentInherit],
        ["on", STR.common.tabMenu.residentOn],
        ["off", STR.common.tabMenu.residentOff],
      ] as const).map(([policy, label]) => (
        <button
          key={policy}
          className={`ctx-item${(tab.residentPolicy ?? "inherit") === policy ? " active" : ""}`}
          role="menuitemradio"
          aria-checked={(tab.residentPolicy ?? "inherit") === policy}
          onClick={() => {
            setTabResidentPolicy(tab.id, policy);
            closeMenu();
          }}
        >
          {label}
        </button>
      ))}
      {tab.dormant !== true && (
        <>
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => closeTab(tab.id)}>
            {STR.common.close}
          </button>
        </>
      )}
    </div>
  );
}
