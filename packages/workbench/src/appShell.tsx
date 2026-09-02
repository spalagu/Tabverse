import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { TabDefinition } from "./tabs";
import { TabKindOptionPresentation } from "./newTabPresentation";
import {
  GroupHeadPresentation,
  SidebarTreePresentation,
  TabRowPresentation,
  rootGroups,
  subtreeTabs,
  type WorkbenchSidebarTreeGroup,
  type WorkbenchTabRow,
} from "./sidebarPresentation";
import { FolderIcon, TAB_ICONS } from "./icons";
import { STR } from "./strings";
import { groupColor } from "./theme";
import type { TabType } from "@tabverse/runtime-contracts";


/** Every tab an app share mirrors is one of the two renderer kinds the
 * join page can already draw — the same family the welcome's tabType
 * names for single-tab shares (an "app" welcome is what mounts this
 * shell, not a kind of row inside it). */
export type AppShareTabType = TabType;

/** The mirrored rows are the store's own Tab and Group shapes — the
 * same rows the host sidebar draws, so the shared presentation core
 * (sidebarContent.tsx) renders both ends from one source. Fields the
 * wire never carries (subtitles, favicons, badges) are simply absent
 * and the shared core degrades them away by data. */
export type AppShareTab = WorkbenchTabRow;
export interface AppShareGroup extends WorkbenchSidebarTreeGroup {
  readonly colorIndex: number;
  readonly preset?: TabType;
}

/** Join's data adapter for the single shared tab-row presentation. A browser
 * viewer has no access to the host's native favicon cache or local terminal
 * markers, so those factual slots are absent while markup stays identical. */
function AppTabRowContent({ tab }: { tab: AppShareTab }) {
  return (
    <TabRowPresentation
      tab={tab}
      Icon={TAB_ICONS[tab.type]}
      favicon={null}
      deviationHint={STR.common.sidebar.deviationHint}
      attentionHint={STR.common.sidebar.attentionHint}
      broadcastHint={STR.common.sidebar.broadcastHint}
      broadcasting={false}
      viewersHint={STR.common.sidebar.viewersHint}
    />
  );
}

/** Join's runtime-neutral folder adapter. The viewer is intentionally fixed
 * to the same dark theme used by the mirrored terminal surface. */
function AppGroupHeadContent({
  group,
  count,
}: {
  group: AppShareGroup;
  count: number;
}) {
  return (
    <GroupHeadPresentation
      group={group}
      count={count}
      color={groupColor("dark", group.colorIndex)}
      FolderIcon={FolderIcon}
    />
  );
}

export interface AppShareShellProps {
  /** The host's tabs, in the host's sidebar order. */
  tabs: AppShareTab[];
  /** The host's folders — the same tree its sidebar draws. The rail and
   * the drawer render pinned folders above the Today seam exactly the
   * host way, so a visitor reads the same list on both screens. */
  groups: AppShareGroup[];
  /** The host's active tab; null until the first mirror frame says. */
  activeId: string | null;
  onSelect: (id: string) => void;
  readOnly?: boolean;
  onCreateTab?: (type: AppShareTabType, initial?: Readonly<Record<string, string>>) => void;
  /** Enabled RemoteContributions projected from Join's PluginCatalog. */
  tabDefinitions?: readonly TabDefinition[];
  /** Steer-level folder fold (the host sidebar's own click): sends the
 * toggleGroupCollapsed action for the named folder. Omitted at view
 * level — the head renders inert there. */
  onToggleGroup?: (id: string) => void;
  /** The active tab's renderer, filling the content area. */
  children: ReactNode;
}

const WIDE_QUERY = "(min-width: 769px)";
const COARSE_QUERY = "(pointer: coarse)";

/** Which form is on screen, live: re-read whenever either query flips,
 * with both listeners detached when the shell unmounts. Exported for the
 * page, whose terminal-fit default is form-dependent the same way. */
export function useWideForm(): boolean {
  const [wide, setWide] = useState(
      !window.matchMedia(COARSE_QUERY).matches,
  );

  useEffect(() => {
    const wideMq = window.matchMedia(WIDE_QUERY);
    const coarseMq = window.matchMedia(COARSE_QUERY);
    const sync = () => setWide(wideMq.matches && !coarseMq.matches);
    sync();
    wideMq.addEventListener("change", sync);
    coarseMq.addEventListener("change", sync);
    return () => {
      wideMq.removeEventListener("change", sync);
      coarseMq.removeEventListener("change", sync);
    };
  }, []);

  return wide;
}

/** A folder's colour comes from the shared GroupHeadContent — the host's
 * groupColor() mapping against the mirrored store's resolved theme, one
 * source for both sidebars. */

export function defaultFitFor(kind: string | null, wideForm: boolean): boolean {
  return !(kind === "app" && !wideForm);
}

const depthVar = (level: number): CSSProperties =>
  ({ "--app-depth": level }) as CSSProperties;

/** One tab row — the flat list's own button, kept verbatim, plus the
 * depth var so a row inside folders indents like its host twin. */
function TabRow({
  tab,
  activeId,
  onSelect,
  depth = 0,
}: {
  tab: AppShareTab;
  activeId: string | null;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  return (
    <button
      key={tab.id}
      type="button"
      role="tab"
      className="app-tab-row"
      data-type={tab.type}
      aria-selected={tab.id === activeId}
      aria-controls="app-share-panel"
      style={depthVar(depth)}
      onClick={() => onSelect(tab.id)}
    >
      <AppTabRowContent tab={tab} />
    </button>
  );
}

function GroupBlock({
  group,
  groups,
  tabs,
  activeId,
  onSelect,
  onToggleGroup,
  depth = 0,
}: {
  group: AppShareGroup;
  groups: AppShareGroup[];
  tabs: AppShareTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onToggleGroup?: (id: string) => void;
  depth?: number;
}) {
  return (
    <SidebarTreePresentation
      group={group}
      groups={groups}
      tabs={tabs}
      depth={depth}
      className="app-tab-group"
      subtreeTabs={subtreeTabs}
      renderGroupHead={({ group: treeGroup, count, depth: treeDepth }) => (
        <div
          className="app-tab-group-head"
          style={depthVar(treeDepth)}
          role={onToggleGroup !== undefined ? "button" : undefined}
          tabIndex={onToggleGroup !== undefined ? 0 : undefined}
          aria-expanded={onToggleGroup !== undefined ? !treeGroup.collapsed : undefined}
          onClick={onToggleGroup !== undefined ? () => onToggleGroup(treeGroup.id) : undefined}
          onKeyDown={
            onToggleGroup !== undefined
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggleGroup(treeGroup.id);
                  }
                }
              : undefined
          }
        >
          <AppGroupHeadContent group={treeGroup} count={count} />
        </div>
      )}
      renderTab={({ tab, depth: treeDepth }) => (
        <TabRow tab={tab} activeId={activeId} onSelect={onSelect} depth={treeDepth} />
      )}
    />
  );
}

function TabList({
  tabs,
  groups,
  activeId,
  onSelect,
  readOnly = false,
  onToggleGroup,
}: Pick<
  AppShareShellProps,
  "tabs" | "groups" | "activeId" | "onSelect" | "readOnly" | "onToggleGroup"
>) {
  const known = new Set(groups.map((g) => g.id));
  const today = tabs.filter((t) => !t.groupId || !known.has(t.groupId));
  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-readonly={readOnly}
      className={`app-tab-list${readOnly ? " readonly" : ""}`}
    >
      {rootGroups(groups).map((g) => (
        <GroupBlock
          key={g.id}
          group={g}
          groups={groups}
          tabs={tabs}
          activeId={activeId}
          onSelect={onSelect}
          onToggleGroup={onToggleGroup}
        />
      ))}
      <div className="app-zone-divider" aria-hidden="true">
        Today
      </div>
      {today.map((t) => (
        <TabRow key={t.id} tab={t} activeId={activeId} onSelect={onSelect} />
      ))}
    </div>
  );
}

/** The joiner's new-tab picker: the HOST menu's shape (one row per tab
 * kind, icon + name), without the host-only machinery (profiles,
 * templates, shortcuts). Creation is Steer-only by construction — the
 * caller omits the handlers at view level and the button never appears. */
function NewTabPicker({
  onCreateTab,
  tabDefinitions,
  onClose,
}: Pick<AppShareShellProps, "onCreateTab" | "tabDefinitions"> & {
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<TabDefinition | null>(null);
  const [value, setValue] = useState("");
  const pick = (definition: TabDefinition) => {
    if (definition.creation !== undefined) {
      setEditing(definition);
      return;
    }
    onCreateTab?.(definition.type);
    onClose();
  };
  return (
    <div className="app-new-menu" role="menu" aria-label="New tab on the host">
      <div className="app-new-menu-head">NEW TAB</div>
      {(tabDefinitions ?? []).map((definition) => {
        const creation = definition.creation;
        if (editing?.type === definition.type && creation !== undefined) {
          return (
            <form
              key={definition.type}
              className="app-new-menu-creation"
              data-tab-kind={definition.type}
              onSubmit={(event) => {
                event.preventDefault();
                const raw = value.trim();
                if (raw === "") return;
                const normalized =
                  creation.defaultScheme !== undefined &&
                  !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
                    ? `${creation.defaultScheme}://${raw}`
                    : raw;
                onCreateTab?.(definition.type, { [creation.field]: normalized });
                setValue("");
                onClose();
              }}
            >
              <input
                type="text"
                autoFocus
                value={value}
                placeholder={creation.placeholder}
                aria-label={creation.fieldLabel}
                onChange={(event) => setValue(event.target.value)}
              />
              <button type="submit">{creation.submitLabel}</button>
            </form>
          );
        }
        const Icon = TAB_ICONS[definition.icon];
        return (
          <TabKindOptionPresentation
            key={definition.type}
            role="menuitem"
            label={definition.label}
            hint={definition.hint}
            Icon={Icon}
            iconSize={16}
            onSelect={() => pick(definition)}
            className="app-new-menu-row"
            labelClassName="app-new-menu-label"
            hintClassName="app-new-menu-hint"
          />
        );
      })}
    </div>
  );
}
/** The shell itself: rail form on a wide fine-pointer viewport, drawer
 * form everywhere else. The content area and its id are shared by both
 * so the tabs' aria-controls points at something that exists either way. */
export function AppShareShell({
  tabs,
  groups,
  activeId,
  onSelect,
  readOnly = false,
  onCreateTab,
  tabDefinitions,
  onToggleGroup,
  children,
}: AppShareShellProps) {
  const wide = useWideForm();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Picking a tab from the drawer is the last thing the drawer is needed
  // for, so the select slides it back out of the way of what it chose —
  // the drawer overlays the pane, and a phone has no room for both.
  const selectFromDrawer = (id: string) => {
    onSelect(id);
    setDrawerOpen(false);
  };

  // The host's own entrance shape (its tab bar's +): a header button that
  // raises the kind picker. Steer-only by the same rule as every creation
  // — at view level neither handler is passed and the button hides.
  const canCreate = !readOnly && onCreateTab !== undefined;

  const form = wide
    ? "app-shell-wide"
    : drawerOpen
      ? "app-shell-drawer open"
      : "app-shell-drawer";

  return (
    <div className={`app-shell ${form}`}>
      {wide ? (
        <nav className="app-shell-side" aria-label="Shared tabs">
          {canCreate ? (
            <div className="app-shell-side-head">
              <button
                type="button"
                className="app-new-button"
                aria-label="New tab"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                +
              </button>
              {menuOpen ? (
                <NewTabPicker
                  onCreateTab={onCreateTab}
                  tabDefinitions={tabDefinitions}
                  onClose={() => setMenuOpen(false)}
                />
              ) : null}
            </div>
          ) : null}
          <TabList
            tabs={tabs}
            groups={groups}
            activeId={activeId}
            onSelect={onSelect}
            readOnly={readOnly}
            onToggleGroup={onToggleGroup}
          />
        </nav>
      ) : (
        <>
          <nav id="app-share-drawer" className="app-drawer" aria-label="Shared tabs">
            {canCreate ? (
              <div className="app-shell-side-head">
                <button
                  type="button"
                  className="app-new-button"
                  aria-label="New tab"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  +
                </button>
                {menuOpen ? (
                  <NewTabPicker
                  onCreateTab={onCreateTab}
                  tabDefinitions={tabDefinitions}
                    onClose={() => setMenuOpen(false)}
                  />
                ) : null}
              </div>
            ) : null}
            <TabList
              tabs={tabs}
              groups={groups}
              activeId={activeId}
              onSelect={selectFromDrawer}
              readOnly={readOnly}
              onToggleGroup={onToggleGroup}
            />
          </nav>
          <button
            type="button"
            className="app-drawer-handle"
            aria-expanded={drawerOpen}
            aria-controls="app-share-drawer"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            Tabs
          </button>
        </>
      )}
      <div className="app-shell-main" id="app-share-panel">
        {children}
      </div>
    </div>
  );
}

export interface LocalTabsVaultProps {
  /** Whether the app-level share owns the screen. */
  appActive: boolean;
  /** The page's own pre-join content — the gate and the local tab stage. */
  localContent: ReactNode;
  /** The app share shell, on screen only while the share is active. */
  children: ReactNode;
}

export function LocalTabsVault({
  appActive,
  localContent,
  children,
}: LocalTabsVaultProps) {
  return <>{appActive ? children : localContent}</>;
}
