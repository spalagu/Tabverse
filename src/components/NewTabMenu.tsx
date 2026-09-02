import { useCallback, useEffect, useMemo, useState } from "react";
import type { TabContribution } from "@tabverse/tab-contracts";
import { TabKindOptionPresentation } from "@tabverse/workbench/new-tab";
import { keysShownFor } from "../shortcuts";
import { STR } from "../strings";
import { formatKeys } from "../strings/formatKeys";
import { useStore, type TabType } from "../state/store";
import type { ConfigProfile, ConfigTemplate } from "../state/config";
import { isCmdArrow, isIMEComposing } from "../localKeys";
import { useProfiles } from "./useProfiles";
import { useTemplates } from "./useTemplates";
import { templateLeaves } from "../terminalTemplates";
import { TAB_ICONS } from "./icons";
import { desktopPluginComposition } from "../pluginComposition";

const shortcuts: Partial<Record<TabType, string>> = {
  terminal: keysShownFor("new-terminal"),
  files: keysShownFor("new-files"),
  browser: keysShownFor("new-browser"),
  remote: keysShownFor("join"),
};
const M = STR.browser.newTabMenu;

/** The enabled PluginCatalog contribution list is the only New Tab registry. */
function optionsFor(contributions: readonly TabContribution<unknown>[]) {
  return contributions
    .map(({ manifest }) => ({
      type: manifest.kind,
      ...manifest.presentation,
      kbd: shortcuts[manifest.kind] ?? "",
    }))
    .sort((left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.type.localeCompare(right.type),
    );
}

type Entry =
  | {
      kind: "type";
      type: TabType;
      label: string;
      hint: string;
      icon: string;
      launch?: "tab" | "dialog";
      kbd: string;
    }
  | { kind: "profile"; profile: ConfigProfile }
  | { kind: "template"; template: ConfigTemplate };

/** How many entries the number keys can reach: one row of digits. */
export const DIRECT_KEYS = 9;

/**
 * The entry a key press names, or null when it names none.
 *
 * MODIFIERS DISQUALIFY, and that is the whole of the rule's subtlety: ⌘1…⌘9
 * is the jump-to-tab row of the shortcut table (src/shortcuts.json), which
 * answers whether or not this picker is up. A digit direct-dial that took
 * the key regardless of modifiers would swallow those nine bindings for as
 * long as the picker was open.
 */
export function directIndex(
  key: string,
  modifiers: { meta: boolean; ctrl: boolean; alt: boolean }
): number | null {
  if (modifiers.meta || modifiers.ctrl || modifiers.alt) return null;
  if (key.length !== 1 || key < "1" || key > "9") return null;
  const at = key.charCodeAt(0) - "1".charCodeAt(0);
  return at < DIRECT_KEYS ? at : null;
}

export function NewTabMenu() {
  const composition = desktopPluginComposition();
  const [contributions, setContributions] = useState<readonly TabContribution<unknown>[]>([]);
  const addTab = useStore((s) => s.addTab);
  const openTemplateTab = useStore((s) => s.openTemplateTab);
  const setJoinDialog = useStore((s) => s.setJoinDialog);
  const setNewTabMenu = useStore((s) => s.setNewTabMenu);
  const { list: profileList } = useProfiles();
  const { list: templateList } = useTemplates();

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void composition.tabContributions().then((next) => {
        if (!cancelled) setContributions(next);
      });
    };
    refresh();
    const unsubscribe = composition.subscribe(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [composition]);

  const entries = useMemo<Entry[]>(
    () => [
      ...optionsFor(contributions).map((o) => ({ kind: "type" as const, ...o })),
      ...profileList.map((profile) => ({ kind: "profile" as const, profile })),
      ...templateList.map((template) => ({ kind: "template" as const, template })),
    ],
    [contributions, profileList, templateList]
  );

  const open = useCallback(
    (entry: Entry) => {
      if (entry.kind === "profile") {
        addTab({ type: "terminal", profile: entry.profile.name });
        return;
      }
      if (entry.kind === "template") {
        openTemplateTab(entry.template);
        return;
      }
      if (entry.launch === "dialog") setJoinDialog(true);
      else addTab({ type: entry.type });
    },
    [addTab, openTemplateTab, setJoinDialog]
  );

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isIMEComposing(e) && !isCmdArrow(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setNewTabMenu(false);
        return;
      }
      const at = directIndex(e.key, {
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
      });
      if (at === null) return;
      const entry = entries[at];
      if (entry === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      open(entry);
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => window.removeEventListener("keydown", h, { capture: true });
  }, [entries, open, setNewTabMenu]);

  /** The digit that opens this entry, or empty past the ninth. */
  const digit = (at: number) => (at < DIRECT_KEYS ? String(at + 1) : "");

  return (
    <div className="overlay" onMouseDown={() => setNewTabMenu(false)}>
      <div className="newtab-menu" onMouseDown={(e) => e.stopPropagation()}>
        <div className="newtab-menu-title">{M.title}</div>
        {entries.map((entry, at) => {
          if (entry.kind !== "type") return null;
          const Icon = TAB_ICONS[entry.icon];
          return (
            <TabKindOptionPresentation
              key={entry.type}
              label={entry.label}
              hint={entry.hint}
              Icon={Icon}
              iconSize={18}
              onSelect={() => open(entry)}
              className="newtab-option"
              labelClassName="newtab-label"
              hintClassName="newtab-hint"
              leading={digit(at) ? <kbd>{digit(at)}</kbd> : undefined}
              trailing={entry.kbd ? <kbd>{formatKeys(entry.kbd)}</kbd> : undefined}
              data-direct-key={digit(at)}
            />
          );
        })}

        {profileList.length > 0 && (
          <>
            <div className="newtab-menu-title">{M.profiles}</div>
            {entries.map((entry, at) => {
              if (entry.kind !== "profile") return null;
              const Icon = TAB_ICONS.terminal;
              const detail = [entry.profile.shell, entry.profile.cwd]
                .filter((part) => typeof part === "string" && part.trim() !== "")
                .join(" · ");
              return (
                <button
                  key={`profile-${entry.profile.name}`}
                  className="newtab-option"
                  aria-label={entry.profile.name}
                  data-profile={entry.profile.name}
                  data-direct-key={digit(at)}
                  onClick={() => open(entry)}
                >
                  {digit(at) && <kbd>{digit(at)}</kbd>}
                  <Icon size={18} />
                  <span className="newtab-label">
                    {entry.profile.name}
                    <span className="newtab-hint">
                      {detail === "" ? M.profileHintPlain : detail}
                    </span>
                  </span>
                </button>
              );
            })}
          </>
        )}

        {templateList.length > 0 && (
          <>
            <div className="newtab-menu-title">{M.templates}</div>
            {entries.map((entry, at) => {
              if (entry.kind !== "template") return null;
              const Icon = TAB_ICONS.terminal;
              const cells = templateLeaves(entry.template.tree);
              const detail =
                cells.length === 1
                  ? cells[0].leaf.cwd ?? M.templateHintPlain
                  : M.templateHintCells({
                      count: cells.length,
                      cwd: cells[0].leaf.cwd ?? "",
                    });
              return (
                <button
                  key={`template-${entry.template.name}`}
                  className="newtab-option"
                  aria-label={entry.template.name}
                  data-template={entry.template.name}
                  data-direct-key={digit(at)}
                  onClick={() => open(entry)}
                >
                  {digit(at) && <kbd>{digit(at)}</kbd>}
                  <Icon size={18} />
                  <span className="newtab-label">
                    {entry.template.name}
                    <span className="newtab-hint">{detail}</span>
                  </span>
                </button>
              );
            })}
          </>
        )}
        {templateList.length === 0 && (
          <>
            <div className="newtab-menu-title">{M.templates}</div>
            {/* A line, not a control: there is nothing here to open, and a
                disabled row would still be a row — reachable by Tab, and one
                more thing for a screen reader to announce as an option. It is
                not an entry, so no number key reaches it either. The padding
                matches an option's so the section does not sit flush left. */}
            <p
              className="newtab-hint"
              style={{ padding: "var(--sp-8)" }}
              data-templates-empty=""
            >
              {M.templatesEmpty}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
