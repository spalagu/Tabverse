import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { SEARCH_ENGINES, validSearchTemplate } from "../search";
import { confirmAsk } from "./Confirm";
import { passphraseAsk } from "./Passphrase";
import { BackgroundTasksSection } from "./BackgroundTasksSection";
import { UserScriptsSection } from "./UserScriptsSection";
import { ProfilesSection } from "./ProfilesSection";
import { TrashIcon } from "./icons";
import {
  clearZoomMemory,
  forgetZoom,
  zoomEntries,
  type ZoomEntry,
} from "../zoomMemory";
import {
  describeError,
  errorText,
  type ErrorDescription,
} from "../strings/errors";
import { STR } from "../strings";
import {
  PROFILES_SECTION_ID,
  SETTINGS_SECTIONS,
  TERMINAL_COMPLETIONS_SECTION_ID,
  USERSCRIPTS_SECTION_ID,
  currentSectionAt,
  jumpToSettingsSection,
  settingsJumpTarget,
  type SettingsGroup,
} from "./settingsSections";

/** The rail's family captions, in the group's own order of first appearance.
    The strings sit beside `nav.label` so all rail copy lives together. */
const GROUP_LABEL: Record<SettingsGroup, string> = {
  general: STR.settings.nav.groupGeneral,
  terminal: STR.settings.nav.groupTerminal,
  browser: STR.settings.nav.groupBrowser,
  network: STR.settings.nav.groupNetwork,
  automation: STR.settings.nav.groupAutomation,
  danger: STR.settings.nav.groupDanger,
};
import {
  SECTION_INDEX,
  buildSettingsIndex,
  buildShortcutIndex,
  searchSettings,
  shortcutsAt,
  strAt,
} from "./settingsSearch";
import { captureKeys } from "./keyCapture";
import { SettingsChanged } from "./SettingsChanged";
import { formatKeys } from "../strings/formatKeys";
import type { AppCommand } from "../appCommands";
import {
  chordId,
  chordKeys,
  inspectBinding,
  keyOverlay,
  keysFor,
  reservedAt,
  useKeyBindings,
  useVisibleShortcuts,
  type BindingVerdict,
  type Chord,
  type LocalCommand,
  type ReservedClaim,
} from "../shortcuts";
import { ErrorState } from "./state/ErrorState";
import {
  recordConfigWrite,
  useStore,
  type ArchiveThreshold,
  type SearchEngineId,
} from "../state/store";
import {
  CONFIG_KEYS,
  NETWORK_KEYS,
  TERMINAL_KEYS,
  choiceOptions,
  clearKeyBinding,
  configGet,
  configSchema,
  configSetSoon,
  keyConfigKey,
  numberRange,
  revealConfigFile,
  setKeyBinding,
  terminalFontOf,
  terminalImageMemoryOf,
  terminalLigaturesOf,
  terminalBackgroundTasksOf,
  terminalCompletionsUrlOf,
  terminalPasteGuardOf,
  textRefusal,
  textRule,
  type ConfigNetwork,
  type Setting,
} from "../state/config";
import {
  familyList,
  setTerminalFont as publishTerminalFont,
  type TerminalFont,
} from "../term/font";
import { missingFamilies } from "../term/fontProbe";
import {
  completionSpecSource,
  completionSpecVersion,
  loadCompletionSpec,
  snapshotVersion,
  type SpecSource,
} from "../term/completionSpec";
import { dangerActions, runDangerAction } from "./dangerZone";
import { settingTitle } from "../state/modifiedSettings";
import { IS_MAC } from "../platform";
import { themeChoices, type ThemePreference } from "../theme/tokens";

const THEME_CHOICES: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: STR.settings.appearance.system },
  ...themeChoices().map((t) => ({ value: t.id, label: t.label })),
];

const DNS_LABELS: Record<string, string> = {
  system: STR.settings.network.system,
  custom: STR.settings.network.custom,
};

/** A `network.dns_mode` option's label — see [`DNS_LABELS`]. */
function dnsLabel(token: string): string {
  return DNS_LABELS[token] ?? token.charAt(0).toUpperCase() + token.slice(1);
}

/** The one `network.dns_mode` token that asks for an address of its own. */
const DNS_CUSTOM_MODE = "custom";

/**
 * The one `network.dns_mode` token that means "no DoH": the system
 * resolver. Named for what it IS rather than for the field it is compared
 * against, and compared rather than assigned, which is the difference the
 * registry gate reads between asking which mode you have and restating the
 * mode's default.
 */
const DNS_PLAIN_MODE = "system";

const UNCOVERED_EXITS: readonly string[] = [
  STR.settings.network.uncoveredRemote,
  STR.settings.network.uncoveredSocket,
  STR.settings.network.uncoveredTerminal,
  STR.settings.network.uncoveredProvider,
];

/**
 * What a control shows while its setting has not been read: nothing
 * selected, nothing typed. Named once rather than written inline beside each
 * control, so it cannot be mistaken for — or drift into — a default value
 * for any particular setting.
 */
const UNREAD = "";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Health {
  shellIntegration: boolean;
  homeDir: string;
  version: string;
}

/** Mirrors `Status` in src-tauri/src/default_apps.rs. */
interface DefaultAppStatus {
  kind: "browser" | "terminal" | "editor";
  /** How many of this switch's system objects Tabverse holds, out of total. */
  held: number;
  total: number;
  enabled: boolean;
  representative: string | null;
  missing: string[];
  settable: boolean;
  note: ErrorDescription | null;
}

const DEFAULT_APP_LABELS: Record<
  DefaultAppStatus["kind"],
  { title: string; blurb: string }
> = {
  browser: {
    title: STR.settings.defaultApps.browserTitle,
    blurb: STR.settings.defaultApps.browserBlurb,
  },
  terminal: {
    title: STR.settings.defaultApps.terminalTitle,
    blurb: STR.settings.defaultApps.terminalBlurb,
  },
  editor: {
    title: STR.settings.defaultApps.editorTitle,
    blurb: STR.settings.defaultApps.editorBlurb,
  },
};


export type KeyCommit = (
  command: AppCommand | LocalCommand,
  keys: string | null
) => void | Promise<void>;

const commitKeyBinding: KeyCommit = async (command, keys) => {
  const id = String(command);
  try {
    await setKeyBinding(id, keys);
    recordConfigWrite(keyConfigKey(id), null);
  } catch (e) {
    recordConfigWrite(keyConfigKey(id), e);
  }
};

/**
 * Back to the key the app ships with — the other half of the same seam.
 *
 * Not expressible as a commit: an override equal to today's default is a
 * different fact from having no opinion, and the difference shows the day a
 * default moves. Deleting the line is what "shipped key" means, both here
 * and in the file — which is why this calls a deletion rather than a write
 * of whatever the shipped key currently is.
 */
const resetKeyBinding = async (
  command: AppCommand | LocalCommand
): Promise<void> => {
  const id = String(command);
  try {
    await clearKeyBinding(id);
    recordConfigWrite(keyConfigKey(id), null);
  } catch (e) {
    recordConfigWrite(keyConfigKey(id), e);
  }
};

/** What holds a reserved key, in the strings table's words. */
function holderName(claim: ReservedClaim): string {
  // The path, rather than nothing, when the leaf has gone stale: a warning
  // that names a dotted path is ugly and true, and one that names nothing
  // sends the reader looking for a holder the app knows and did not say.
  return strAt(claim.str) ?? claim.str;
}

function verdictLines(verdict: BindingVerdict): string[] {
  const S = STR.settings.keyboard;
  const keys = formatKeys(verdict.keys);
  const lines: string[] = [];
  for (const claim of verdict.taken) {
    // A view's key and an app-wide key read differently because they behave
    // differently: two rows of this table on one chord are one index entry
    // and one of them stops answering, while a view's own listener and the
    // app-wide one are siblings on the window that both run.
    lines.push(
      claim.local
        ? S.takenByView({ keys, action: claim.label })
        : S.takenBy({ keys, action: claim.label })
    );
  }
  for (const claim of verdict.reserved) {
    const held = { keys: formatKeys(claim.keys), holder: holderName(claim) };
    lines.push(
      claim.owner === "system" ? S.heldBySystem(held) : S.heldByApp(held)
    );
  }
  if (verdict.reserved.length > 0) lines.push(S.heldNote);
  if (verdict.free) lines.push(S.free({ keys }));
  return lines;
}

export interface SettingsViewProps {
  /**
   * Whether the page engine on this machine can be given a proxy at all:
   * macOS gates page coverage on macOS 14 or newer, and whether this Mac is
   * in is the core's to detect (the wiring task owns the version probe —
   * `NSProcessInfo`; this page only draws the consequence). Default true,
   * the honest placeholder: the states that cannot be covered are the
   * minority, and silence must not read as "cannot".
   */
  isCoverable?: boolean;
  pageProxyDown?: boolean;
}

/**
 * Settings, plus the answers to "why isn't X working" — the questions this app
 * actually generates: is shell integration live (command blocks depend on it),
 * where do shares come from, what do the shortcuts do.
 */
export function SettingsView({
  isCoverable = true,
  pageProxyDown = false,
}: SettingsViewProps = {}) {
  const [health, setHealth] = useState<Health | null>(null);
  const tabs = useStore((s) => s.tabs);
  const shared = tabs.filter((t) => t.share);
  const archiveThreshold = useStore((s) => s.archiveThreshold);
  const setArchiveThreshold = useStore((s) => s.setArchiveThreshold);
  const searchEngine = useStore((s) => s.searchEngine);
  const customSearchTemplate = useStore((s) => s.customSearchTemplate);
  const setSearchEngine = useStore((s) => s.setSearchEngine);
  const themePreference = useStore((s) => s.themePreference);
  const setThemePreference = useStore((s) => s.setThemePreference);
  // The Keyboard section lists the composition — defaults with the user's
  // `[keys]` overlay on top — and repaints when that overlay moves.
  const keyboardRows = useVisibleShortcuts();
  // The whole composition, which the rebinding verdicts are judged against:
  // the rows above are the visible ones.
  const bindings = useKeyBindings();
  const configError = useStore((s) => s.configError);
  const configWarnings = useStore((s) => s.configWarnings);
  const configWarningsDismissed = useStore((s) => s.configWarningsDismissed);
  const configPath = useStore((s) => s.configPath);
  const dismissConfigWarnings = useStore((s) => s.dismissConfigWarnings);
  const configWriteErrors = useStore((s) => s.configWriteErrors);
  const dismissConfigWriteErrors = useStore((s) => s.dismissConfigWriteErrors);
  const showConfigFile = () => {
    if (configPath === null) return;
    void revealConfigFile(configPath).catch(() => {});
  };
  const [templateDraft, setTemplateDraft] = useState(
    customSearchTemplate ?? UNREAD
  );

  const [onlyChanged, setOnlyChanged] = useState(false);

  // The page is its own scroll container (.settings-view is inset-0 with
  // overflow-y), so "which section am I on" is measured against this
  // element, not the window.
  const viewRef = useRef<HTMLDivElement>(null);
  const [currentSection, setCurrentSection] = useState(SETTINGS_SECTIONS[0].id);

  const [schema, setSchema] = useState<readonly Setting[]>([]);
  useEffect(() => {
    let live = true;
    configSchema()
      .then((rows) => {
        if (live) setSchema(rows);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  /**
   * What the file will accept in the custom-template box, read off the
   * schema like the sidebar's bounds are.
   *
   * Not written down here, and that is the point: this page and the file
   * used to hold the rule separately and disagreed about `HTTPS://`, so a
   * template this box marked good was refused on the way to disk. Null until
   * the schema arrives, and the note below draws nothing while it is —
   * calling a draft bad because we have not read the rule yet would be the
   * same lie in a smaller size.
   */
  const templateRule = useMemo(
    () => textRule(schema, CONFIG_KEYS.customSearchTemplate),
    [schema]
  );
  const templateOk = validSearchTemplate(templateDraft, templateRule);

  /**
   * What to call a setting the file would not take.
   *
   * The registry names the copy and the strings table holds it, so this is a
   * lookup and never a second list of titles. The dotted key stands in when
   * the schema has not arrived or its `str_key` leads nowhere: it is what the
   * file itself calls the setting, which is both true and the thing to search
   * for when opening the file to fix it.
   */
  const settingName = (key: string): string => {
    const row = schema.find((s) => s.key === key);
    return (row === undefined ? null : settingTitle(row)) ?? key;
  };

  const [query, setQuery] = useState("");
  const index = useMemo(() => buildSettingsIndex(schema), [schema]);
  const shortcutIndex = useMemo(
    () => buildShortcutIndex(keyboardRows),
    [keyboardRows]
  );
  // Null while the box is empty, which is what leaves the page whole.
  const match = useMemo(
    () => searchSettings(query, index, SECTION_INDEX, shortcutIndex),
    [query, index, shortcutIndex]
  );
  /**
   * Sections not on the result list are hidden outright rather than dimmed.
   *
   * Dimming keeps all thirteen sections' height in the scroll, so the row
   * that was searched for can still be an entire screen away and has to be
   * scrolled to past greyed-out material — which is the state the search was
   * meant to end. Hiding collapses the page onto the answer. The second
   * reason is the deciding one: a faded section is still in the tab order
   * and still read aloud, so a keyboard or screen-reader user would page
   * through twelve sections that the search had already ruled out.
   */
  const hidden = (id: string) =>
    match !== null && !match.sections.includes(id);
  /** The class suffix that lights up a row the search matched. */
  const hit = (key: string) =>
    match !== null && match.keys.includes(key) ? " settings-hit" : "";
  const visibleSections = SETTINGS_SECTIONS.filter((s) => !hidden(s.id));

  const [recording, setRecording] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [lookedUp, setLookedUp] = useState<Chord | null>(null);
  const [looking, setLooking] = useState(false);

  /**
   * Take the keyboard for as long as a row is listening or the lookup is.
   *
   * Through `keyCapture`, which is offered a key before the app-wide handler
   * — recording a shortcut by pressing it must not also RUN it, and a
   * listener added by this component could not have prevented that: the two
   * sit side by side on the window and the older one wins (see that module).
   */
  useEffect(() => {
    if (recording === null && !looking) return;
    return captureKeys({
      onChord: ({ chord, keys }) => {
        if (recording !== null) {
          setCandidate(keys);
          return;
        }
        setLookedUp(chord);
        // One question, one answer: the lookup stops listening so the next
        // keystroke goes back to being a keystroke.
        setLooking(false);
      },
      onCancel: () => {
        setRecording(null);
        setCandidate(null);
        setLooking(false);
      },
    });
  }, [recording, looking]);

  /** What stands in the way of the key just recorded, or null before one is. */
  const verdict = useMemo(
    () =>
      recording === null || candidate === null
        ? null
        : inspectBinding(recording, candidate, bindings),
    [recording, candidate, bindings]
  );

  /** What the lookup found, as sentences — one per thing that answers. */
  const lookupLines = useMemo(() => {
    if (lookedUp === null) return [];
    const S = STR.settings.keyboard;
    const pressed = chordKeys(lookedUp);
    const keys = formatKeys(pressed);
    const lines = shortcutsAt(chordId(lookedUp), shortcutIndex).map((e) => {
      const row = keyboardRows.find((r) => String(r.command) === e.command);
      return S.lookupHit({ keys, action: row?.label ?? e.command });
    });
    // The reserved list answers here too: "nothing answers ⌘C" would be true
    // of the shortcut table and useless to somebody who just pressed it.
    for (const claim of reservedAt(pressed)) {
      lines.push(
        S.lookupHeld({ keys: formatKeys(claim.keys), holder: holderName(claim) })
      );
    }
    return lines.length > 0 ? lines : [S.lookupMiss({ keys })];
  }, [lookedUp, shortcutIndex, keyboardRows]);

  /** The rows the Keyboard section is showing: all of them, or the search's. */
  const shortcutRows =
    match === null || match.commands.length === 0
      ? keyboardRows
      : keyboardRows.filter((s) => match.commands.includes(String(s.command)));

  const startRecording = (command: string) => {
    setLooking(false);
    setLookedUp(null);
    setCandidate(null);
    setRecording(command);
  };

  const stopRecording = () => {
    setRecording(null);
    setCandidate(null);
  };

  const firstHit = match?.sections[0] ?? null;
  useEffect(() => {
    if (firstHit !== null) jumpToSettingsSection(firstHit);
  }, [firstHit]);

  useEffect(() => {
    const root = viewRef.current;
    if (!root) return;

    /**
     * Read the rectangles, let `currentSectionAt` decide. Measured straight
     * out of the scroll handler rather than off a requestAnimationFrame:
     * thirteen reads on a page whose layout is already clean cost nothing
     * worth deferring, and one fewer callback is one fewer thing to cancel.
     */
    const measure = () => {
      const rootTop = root.getBoundingClientRect().top;
      const offsets = [];
      for (const s of SETTINGS_SECTIONS) {
        const el = root.querySelector(`[id="${s.id}"]`);
        if (!el) continue;
        offsets.push({ id: s.id, top: el.getBoundingClientRect().top - rootTop });
      }
      const next = currentSectionAt(offsets, root);
      if (next !== null) setCurrentSection(next);
    };

    measure();
    root.addEventListener("scroll", measure, { passive: true });
    // Sections that fill in after mount (the default-app switches arrive
    // from the OS) move every rectangle below them, and the page gets its
    // height only once it is the visible tab — both are height changes, so
    // both re-measure.
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    // The container is inset-0 and never changes size on its own, so the
    // column of sections inside it is what has to be watched.
    observer?.observe(root);
    const column = root.querySelector(".settings-sections");
    if (column) observer?.observe(column);
    return () => {
      root.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<Health>("app_health").then(setHealth).catch(() => {})
    );
  }, []);

  const [network, setNetwork] = useState<ConfigNetwork | null>(null);
  const [font, setFont] = useState<TerminalFont | null>(null);
  // Whether terminals draw ligatures — read here for the same reason, and
  // null until the file has answered.
  const [ligatures, setLigatures] = useState<boolean | null>(null);
  const [backgroundTasks, setBackgroundTasks] = useState<boolean | null>(null);
  const [imageMemory, setImageMemory] = useState<number | null>(null);
  const [pasteGuard, setPasteGuard] = useState<boolean | null>(null);
  const [completionsUrl, setCompletionsUrl] = useState<string | null>(null);
  const [completionsVersion, setCompletionsVersion] = useState<string | null>(
    null
  );
  const [completionsSource, setCompletionsSource] = useState<SpecSource | null>(null);
  const [completionsBusy, setCompletionsBusy] = useState(false);
  const [completionsNote, setCompletionsNote] = useState<
    string | ErrorDescription | null
  >(null);
  useEffect(() => {
    let live = true;
    void loadCompletionSpec().then(() => {
      if (!live) return;
      setCompletionsVersion(completionSpecVersion());
      setCompletionsSource(completionSpecSource());
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    configGet()
      .then((snap) => {
        if (!live) return;
        if (snap.values.network !== undefined) setNetwork(snap.values.network);
        setFont(terminalFontOf(snap.values));
        setLigatures(terminalLigaturesOf(snap.values));
        setBackgroundTasks(terminalBackgroundTasksOf(snap.values));
        setImageMemory(terminalImageMemoryOf(snap.values));
        setPasteGuard(terminalPasteGuardOf(snap.values));
        setCompletionsUrl(terminalCompletionsUrlOf(snap.values));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const writeNetwork = (
    key: string,
    field: keyof ConfigNetwork,
    value: string
  ) => {
    const previous = network;
    if (previous === null) return;
    setNetwork({ ...previous, [field]: value });
    configSetSoon(key, value, (outcome) => {
      if (outcome.ok) {
        recordConfigWrite(key, null);
        return;
      }
      setNetwork(previous);
      recordConfigWrite(key, outcome.error);
    });
  };

  /**
   * What the user has typed into the address box, shown at once and committed
   * only once it validates.
   *
   * The same arrangement as the custom search template above, and for the
   * same reason: an address is invalid for most of the time it takes to type
   * one, and writing every keystroke would mean a stream of refusals from the
   * file and a failed-save banner for each. The value shown is the draft; the
   * value written is the last one the registry's rule accepted.
   */
  const typeDnsUrl = (value: string) => {
    if (network === null) return;
    setNetwork({ ...network, dns_custom_url: value });
    if (dnsUrlRule !== null && textRefusal(dnsUrlRule, value) === null) {
      configSetSoon(NETWORK_KEYS.dnsCustomUrl, value, (outcome) => {
        recordConfigWrite(
          NETWORK_KEYS.dnsCustomUrl,
          outcome.ok ? null : outcome.error
        );
      });
    }
  };

  const writeCover = (next: boolean) => {
    const previous = network;
    if (previous === null) return;
    setNetwork({ ...previous, cover_page_traffic: next });
    configSetSoon(NETWORK_KEYS.coverPageTraffic, next, (outcome) => {
      if (outcome.ok) {
        recordConfigWrite(NETWORK_KEYS.coverPageTraffic, null);
        return;
      }
      setNetwork(previous);
      recordConfigWrite(NETWORK_KEYS.coverPageTraffic, outcome.error);
    });
  };

  const writeFont = (key: string, value: string | number, next: TerminalFont) => {
    const previous = font;
    if (previous === null) return;
    setFont(next);
    publishTerminalFont(next);
    configSetSoon(key, value, (outcome) => {
      if (outcome.ok) {
        recordConfigWrite(key, null);
        return;
      }
      setFont(previous);
      publishTerminalFont(previous);
      recordConfigWrite(key, outcome.error);
    });
  };

  const writeLigatures = (next: boolean) => {
    const previous = ligatures;
    setLigatures(next);
    configSetSoon(TERMINAL_KEYS.ligatures, next, (outcome) => {
      if (outcome.ok) {
        recordConfigWrite(TERMINAL_KEYS.ligatures, null);
        return;
      }
      setLigatures(previous);
      recordConfigWrite(TERMINAL_KEYS.ligatures, outcome.error);
    });
  };

  const writeBackgroundTasks = (next: boolean) => {
    const previous = backgroundTasks;
    setBackgroundTasks(next);
    configSetSoon(TERMINAL_KEYS.backgroundTasks, next, (outcome) => {
      if (outcome.ok) {
        recordConfigWrite(TERMINAL_KEYS.backgroundTasks, null);
        return;
      }
      setBackgroundTasks(previous);
      recordConfigWrite(TERMINAL_KEYS.backgroundTasks, outcome.error);
    });
  };

  const writeImageMemory = (next: number) => {
    const previous = imageMemory;
    setImageMemory(next);
    configSetSoon(TERMINAL_KEYS.imageMemoryMb, next, (outcome) => {
      if (outcome.ok) {
        recordConfigWrite(TERMINAL_KEYS.imageMemoryMb, null);
        return;
      }
      setImageMemory(previous);
      recordConfigWrite(TERMINAL_KEYS.imageMemoryMb, outcome.error);
    });
  };

  const writePasteGuard = (next: boolean) => {
    const previous = pasteGuard;
    setPasteGuard(next);
    configSetSoon(TERMINAL_KEYS.pasteGuard, next, (outcome) => {
      if (outcome.ok) {
        recordConfigWrite(TERMINAL_KEYS.pasteGuard, null);
        return;
      }
      setPasteGuard(previous);
      recordConfigWrite(TERMINAL_KEYS.pasteGuard, outcome.error);
    });
  };

  const completionsUrlRule = useMemo(
    () => textRule(schema, TERMINAL_KEYS.completionsUrl),
    [schema]
  );

  /**
   * Type into the completions URL box: shown at once, committed only once
   * the registry's rule accepts — the custom-template arrangement, for the
   * same reason (an address is invalid for most of the time it takes to
   * type one, and a refusal per keystroke is a banner per keystroke).
   */
  const typeCompletionsUrl = (value: string) => {
    setCompletionsUrl(value);
    if (completionsUrlRule !== null && textRefusal(completionsUrlRule, value) === null) {
      configSetSoon(TERMINAL_KEYS.completionsUrl, value, (outcome) => {
        recordConfigWrite(
          TERMINAL_KEYS.completionsUrl,
          outcome.ok ? null : outcome.error
        );
      });
    }
  };

  const updateCompletions = async () => {
    const url = (completionsUrl ?? "").trim();
    if (url === "") return;
    setCompletionsBusy(true);
    setCompletionsNote(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<{ version: string }>("completions_update", {
        url,
      });
      await loadCompletionSpec(true);
      setCompletionsVersion(completionSpecVersion());
      setCompletionsSource(completionSpecSource());
      setCompletionsNote(STR.settings.completions.updated({ version: res.version }));
    } catch (e) {
      setCompletionsNote(describeError(e, STR.errors.actions.updateCompletions));
    } finally {
      setCompletionsBusy(false);
    }
  };

  /**
   * What is in the two number boxes while they are being typed in.
   *
   * A box being edited passes through states no setting may hold — empty,
   * a single digit on the way to two — and writing those would mean a
   * refusal from the file for every keystroke, with a failed-save banner
   * each time. The draft is what the box shows; the setting is what is
   * written, and only once the value is one the registry's range accepts.
   */
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const [spacingDraft, setSpacingDraft] = useState<string | null>(null);
  const fontSizeRange = useMemo(
    () => numberRange(schema, TERMINAL_KEYS.fontSize),
    [schema]
  );
  const lineHeightRange = useMemo(
    () => numberRange(schema, TERMINAL_KEYS.lineHeightPercent),
    [schema]
  );
  const imageMemoryRange = useMemo(
    () => numberRange(schema, TERMINAL_KEYS.imageMemoryMb),
    [schema]
  );
  // The image-memory box's while-being-typed state, same arrangement as the
  // two above and for the same reason: a draft may be a number no setting
  // may hold, and writing drafts would mean a refusal per keystroke.
  const [imageMemoryDraft, setImageMemoryDraft] = useState<string | null>(null);

  /** A typed number the registry's range accepts, or null. */
  const acceptedNumber = (
    raw: string,
    range: { min: number; max: number } | null
  ): number | null => {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || String(value) !== raw.trim()) return null;
    if (range === null) return null;
    return value >= range.min && value <= range.max ? value : null;
  };

  /**
   * The families the user named that this machine cannot draw with — null
   * while it could not be asked (see src/term/fontProbe.ts, which measures
   * whether it can before it answers anything).
   */
  const missingFonts = font === null ? null : missingFamilies(familyList(font.family));

  /**
   * What the file will accept in the custom-address box, read off the schema
   * like the search template's rule is — never restated here, for the reason
   * that one carries in its own comment.
   */
  const dnsUrlRule = useMemo(
    () => textRule(schema, NETWORK_KEYS.dnsCustomUrl),
    [schema]
  );
  /** The providers on offer, from the registry rather than from a list here. */
  const dnsModes = useMemo(
    () => choiceOptions(schema, NETWORK_KEYS.dnsMode),
    [schema]
  );
  const dnsUrlRefusal =
    dnsUrlRule === null || network === null
      ? null
      : textRefusal(dnsUrlRule, network.dns_custom_url);

  const coverPageTraffic: boolean | null =
    network !== null && typeof network.cover_page_traffic === "boolean"
      ? network.cover_page_traffic
      : null;
  // A provider must be chosen: the switch has nothing to carry while the
  // mode above reads "system", whatever the switch itself says.
  const dohChosen = network !== null && network.dns_mode !== DNS_PLAIN_MODE;
  // What the user has asked for, before the machine gets a say.
  const wantCover = coverPageTraffic === true && dohChosen;
  // What is actually in effect — the platform gate and a living proxy are
  // the two things that can leave pages uncovered while the switch is on.
  const covered = wantCover && isCoverable && !pageProxyDown;
  const proxyLost = wantCover && isCoverable && pageProxyDown;
  // The first line of the exits list: a status line for the browser tabs,
  // one sentence per state (see the strings table's comment).
  const tabsLine = covered
    ? STR.settings.network.coveredWebview
    : proxyLost
      ? STR.settings.network.coverDownWebview
      : STR.settings.network.uncoveredWebview;

  const [trusted, setTrusted] = useState<string[]>([]);
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<string[]>("list_trusted_hosts").then(setTrusted).catch(() => {})
    );
  }, []);

  const revokeTrust = async (host: string) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("revoke_trusted_host", { host }).catch(() => {});
    setTrusted((list) => list.filter((h) => h !== host));
  };

  /** Mirrors `MediaGrant` in src-tauri/src/page_prompts.rs. */
  interface MediaGrant {
    host: string;
    kind: string;
    allow: boolean;
  }
  // Camera/microphone answers remembered per site, enumerated by the same
  // shape of command the certificate exceptions have.
  const [media, setMedia] = useState<MediaGrant[] | null>(null);
  const loadMedia = async () => {
    if (!isTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<MediaGrant[]>("media_list")
      .then(setMedia)
      .catch(() => setMedia([]));
  };
  useEffect(() => {
    void loadMedia();
  }, []);

  const revokeMedia = async (host: string, kind: string) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("media_revoke", { host, kind }).catch(() => {});
    await loadMedia();
  };

  // Per-site zoom lives in the frontend module (zoomMemory), not behind a
  // command, so its list and its revoke are module calls — that IS the
  // channel this kind of memory always used.
  const [zooms, setZooms] = useState<ZoomEntry[]>(() => zoomEntries());
  const forgetZoomFor = (host: string) => {
    forgetZoom(host);
    setZooms(zoomEntries());
  };

  /** The fields of `ScriptInfo` (src-tauri/src/userscripts.rs) the panel reads. */
  interface GrantedScript {
    id: string;
    name: string;
    grantedHosts: string[];
  }
  const [scripts, setScripts] = useState<GrantedScript[] | null>(null);
  const loadScripts = async () => {
    if (!isTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<GrantedScript[]>("userscripts_list")
      .then(setScripts)
      .catch(() => setScripts([]));
  };
  useEffect(() => {
    void loadScripts();
  }, []);

  const revokeScriptGrant = async (scriptId: string, host: string) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("userscript_revoke_grant", { scriptId, host }).catch(
      () => {}
    );
    await loadScripts();
  };

  // The script→host[] shape the scripts are stored in, flattened into the
  // host→scripts[] shape a site panel answers in: one row per site, the
  // script names on a second line as the things that host was granted to.
  const scriptGrants = useMemo(() => {
    const byHost = new Map<string, { id: string; name: string }[]>();
    for (const s of scripts ?? []) {
      for (const h of s.grantedHosts) {
        byHost.set(h, [...(byHost.get(h) ?? []), { id: s.id, name: s.name }]);
      }
    }
    return [...byHost.entries()]
      .map(([host, granted]) => ({ host, granted }))
      .sort((a, b) => a.host.localeCompare(b.host));
  }, [scripts]);

  // The clear is a loop over each memory's own channel — there is no
  // bulk-erase command, and inventing one for the button would fork the
  // revocation paths this panel just promised stay where they are. A
  // confirmation, and no danger zone: everything here is memory a site
  // rebuilds by asking again, which is the line the danger section draws.
  const clearSiteMemory = async () => {
    if (
      !(await confirmAsk(STR.settings.sites.clearQuestion, {
        confirmLabel: STR.settings.sites.clearConfirm,
      }))
    )
      return;
    const { invoke } = await import("@tauri-apps/api/core");
    for (const host of trusted) {
      await invoke("revoke_trusted_host", { host }).catch(() => {});
    }
    for (const g of media ?? []) {
      await invoke("media_revoke", { host: g.host, kind: g.kind }).catch(
        () => {}
      );
    }
    for (const row of scriptGrants) {
      for (const s of row.granted) {
        await invoke("userscript_revoke_grant", {
          scriptId: s.id,
          host: row.host,
        }).catch(() => {});
      }
    }
    clearZoomMemory();
    setTrusted([]);
    setZooms(zoomEntries());
    await Promise.all([loadMedia(), loadScripts()]);
  };

  /**
   * The three default-app switches.
   *
   * Read from the operating system every time, never from anything this app
   * wrote down. The user can change a default in System Settings or from
   * Finder's Get Info, and a switch that showed its own last write would go on
   * claiming to be the default long after it stopped being one.
   */
  const [defaults, setDefaults] = useState<DefaultAppStatus[] | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);

  const loadDefaults = async () => {
    if (!isTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<DefaultAppStatus[]>("default_apps_status")
      .then(setDefaults)
      .catch(() => {});
  };

  useEffect(() => {
    void loadDefaults();
    // Re-read whenever this window comes back to the front: changing a default
    // is something people do in System Settings, and coming back to find the
    // old answer still on screen reads as a bug in Tabverse.
    const onFocus = () => void loadDefaults();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleDefault = async (s: DefaultAppStatus) => {
    setBusyKind(s.kind);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const next = await invoke<DefaultAppStatus>("default_apps_set", {
        kind: s.kind,
        enabled: !s.enabled,
      });
      setDefaults((prev) =>
        (prev ?? []).map((p) => (p.kind === next.kind ? next : p))
      );
      // The browser switch is answered in a panel of the system's own, which
      // is still on screen when the call returns. Nothing here can wait for
      // it, so the answer is collected by looking again a few times.
      if (s.kind === "browser") {
        for (const delay of [1500, 4000, 9000]) {
          setTimeout(() => void loadDefaults(), delay);
        }
      }
    } catch (e) {
      setDefaults((prev) =>
        (prev ?? []).map((p) =>
          p.kind === s.kind
            ? { ...p, note: describeError(e, STR.errors.actions.setDefaultApp) }
            : p
        )
      );
    } finally {
      setBusyKind(null);
    }
  };

  // What came of the last import or export. Counts only: the values
  // themselves never come up to this layer (see the core's pw_portable).
  const [transferNote, setTransferNote] = useState<
    string | ErrorDescription | null
  >(null);

  // What came of the last destructive action. Its own line rather than the
  // one above, because the danger zone is its own section now: a count of
  // forgotten logins belongs under the button that forgot them.
  const [dangerNote, setDangerNote] = useState<
    string | ErrorDescription | null
  >(null);

  const exportPasswords = async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    // Asked here, at the button, not at the save panel: by the time a
    // panel is up the decision has been made, and a check there reads as
    // an obstacle rather than as a question.
    try {
      await invoke("pw_authorize_export");
    } catch (e) {
      setTransferNote(
        errorText(e).includes("not authorized")
          ? STR.settings.exportNotAuthorized
          : describeError(e, STR.errors.actions.exportPasswords)
      );
      return;
    }
    const path = await save({
      defaultPath: "tabverse-passwords.csv",
      filters: [
        { name: STR.settings.passwords.csvFilterName, extensions: ["csv"] },
      ],
    });
    if (!path) return;
    try {
      const n = await invoke<number>("pw_export", { path });
      setTransferNote(STR.settings.passwords.exportedResult({ count: n }));
    } catch (e) {
      setTransferNote(describeError(e, STR.errors.actions.exportPasswords));
    }
  };

  const importPasswords = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await open({
      multiple: false,
      filters: [
        { name: STR.settings.passwords.csvFilterName, extensions: ["csv"] },
      ],
    });
    if (typeof path !== "string") return;
    try {
      const r = await invoke<{
        added: number;
        skipped: number;
        failed: number;
        firstError: string | null;
      }>("pw_import", { path });
      // Every number, including the unhappy ones: "imported 40" while 12
      // silently vanished is how people find out months later.
      setTransferNote(
        STR.settings.passwords.importedAdded({ count: r.added }) +
          (r.skipped
            ? STR.settings.passwords.importedSkipped({ count: r.skipped })
            : "") +
          (r.failed
            ? STR.settings.passwords.importedFailed({
                count: r.failed,
                error: r.firstError ?? "",
              })
            : "")
      );
    } catch (e) {
      setTransferNote(describeError(e, STR.errors.actions.importPasswords));
    }
  };

  // What came of the last migration export or import. Counts and a backup
  // path only — the archive's contents never come up to this layer.
  const [migrateNote, setMigrateNote] = useState<
    string | ErrorDescription | null
  >(null);

  // A filesystem-safe timestamp for the backup directory name. Generated
  // here because the core keeps no clock (it names the directory from what
  // this passes it), matching how the rest of the state layer stamps things.
  const stampNow = (): string => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  };

  const exportEverything = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("migrate_authorize_export");
    } catch (e) {
      setMigrateNote(
        errorText(e).includes("not authorized")
          ? STR.settings.exportNotAuthorized
          : describeError(e, STR.errors.actions.exportBackup)
      );
      return;
    }
    const passphrase = await passphraseAsk({
      title: STR.settings.migrate.exportPassTitle,
      note: STR.settings.migrate.exportPassNote,
      confirm: true,
      submitLabel: STR.common.proceed,
    });
    if (!passphrase) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: "tabverse-migration.tabverse",
      filters: [
        { name: STR.settings.migrate.filterName, extensions: ["tabverse"] },
      ],
    });
    if (!path) return;
    try {
      const s = await invoke<{ scopes: number; passwords: number }>(
        "migrate_export",
        { path, passphrase }
      );
      setMigrateNote(
        STR.settings.migrate.exportedResult({
          scopes: s.scopes,
          passwords: s.passwords,
        })
      );
    } catch (e) {
      setMigrateNote(describeError(e, STR.errors.actions.exportBackup));
    }
  };

  const importEverything = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await open({
      multiple: false,
      filters: [
        { name: STR.settings.migrate.filterName, extensions: ["tabverse"] },
      ],
    });
    if (typeof path !== "string") return;
    const passphrase = await passphraseAsk({
      title: STR.settings.migrate.importPassTitle,
      note: STR.settings.migrate.importPassNote,
      confirm: false,
      submitLabel: STR.settings.migrate.openLabel,
    });
    if (!passphrase) return;
    // One stamp, used for both the check (so the confirm box can show the
    // real backup path) and the apply.
    const stamp = stampNow();
    // Validate first: a wrong passphrase, a truncated file or an unknown
    // version fails here, before a single byte of current state is touched.
    let preview: {
      summary: { scopes: number; passwords: number };
      backupPath: string;
    };
    try {
      preview = await invoke("migrate_import_check", { path, passphrase, stamp });
    } catch (e) {
      setMigrateNote(describeError(e, STR.errors.actions.importBackup));
      return;
    }
    const ok = await confirmAsk(
      STR.settings.migrate.replaceQuestion({
        scopes: preview.summary.scopes,
        passwords: preview.summary.passwords,
        backupPath: preview.backupPath,
      }),
      { confirmLabel: STR.settings.migrate.replaceLabel }
    );
    if (!ok) return;
    try {
      const res = await invoke<{
        summary: { scopes: number; passwords: number };
        backupPath: string;
      }>("migrate_import_apply", { path, passphrase, stamp });
      setMigrateNote(
        STR.settings.migrate.importedResult({
          scopes: res.summary.scopes,
          passwords: res.summary.passwords,
          backupPath: res.backupPath,
        })
      );
    } catch (e) {
      setMigrateNote(describeError(e, STR.errors.actions.importBackup));
    }
  };


  const danger = useMemo(() => dangerActions(setDangerNote), []);

  return (
    <div className="settings-view" ref={viewRef}>
      <h2>{STR.settings.title}</h2>

      {configError !== null && (
        <div className="settings-banner danger" role="alert">
          <p className="settings-banner-title">
            {STR.settings.config.errorHeading}
          </p>
          <p>{STR.settings.config.errorBlurb}</p>
          <pre className="settings-banner-detail">{configError}</pre>
          {configPath !== null && (
            <div className="btn-row">
              <button className="btn" onClick={showConfigFile}>
                {STR.settings.config.openFile}
              </button>
            </div>
          )}
        </div>
      )}

      {configWriteErrors.length > 0 && (
        <div
          className="settings-banner danger settings-write-failures"
          role="alert"
        >
          <p className="settings-banner-title">
            {STR.settings.config.writeFailedHeading}
          </p>
          <p>{STR.settings.config.writeFailedBlurb}</p>
          <ul className="settings-banner-list">
            {configWriteErrors.map((w) => (
              <li key={w.key} data-setting={w.key}>
                {STR.settings.config.writeFailedLine({
                  setting: settingName(w.key),
                  reason: w.error,
                })}
              </li>
            ))}
          </ul>
          <div className="btn-row">
            {configPath !== null && (
              <button className="btn" onClick={showConfigFile}>
                {STR.settings.config.openFile}
              </button>
            )}
            <button className="btn" onClick={dismissConfigWriteErrors}>
              {STR.settings.config.dismissWriteFailures}
            </button>
          </div>
        </div>
      )}

      {/* Unknown keys cost nothing but a line each — the rest of the file was
          read, and these lines are kept as written — so this one closes. */}
      {!configWarningsDismissed && configWarnings.length > 0 && (
        <div className="settings-banner warn" role="status">
          <p className="settings-banner-title">
            {STR.settings.config.warningsHeading}
          </p>
          <ul className="settings-banner-list">
            {configWarnings.map((w) => (
              <li key={`${w.path}:${w.line}:${w.column}:${w.key}`}>
                {STR.settings.config.warningLine({ line: w.line, key: w.key })}
              </li>
            ))}
          </ul>
          <p>{STR.settings.config.warningsBlurb}</p>
          <div className="btn-row">
            {configPath !== null && (
              <button className="btn" onClick={showConfigFile}>
                {STR.settings.config.openFile}
              </button>
            )}
            <button className="btn" onClick={dismissConfigWarnings}>
              {STR.settings.config.dismissWarnings}
            </button>
          </div>
        </div>
      )}

      <div className="settings-search">
        <input
          className="settings-input settings-search-input"
          type="search"
          spellCheck={false}
          aria-label={STR.settings.search.label}
          placeholder={STR.settings.search.label}
          value={query}
          onChange={(e) => {
            // Typing here ends a recording, and it has to: while a row is
            // listening, `keyCapture` takes every key press in the window —
            // including the ones aimed at this box, which would otherwise
            // stay empty however hard somebody typed into it.
            stopRecording();
            setLooking(false);
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>

      {match !== null && match.empty && (
        <p className="settings-search-empty" role="status">
          {STR.settings.search.noMatches({ query: match.query })}
        </p>
      )}

      <SettingsChanged
        onlyChanged={onlyChanged}
        onOnlyChangedChange={setOnlyChanged}
      />

      {/* With the filter on, the two columns give way to the list above:
          the rail and every section are taken out of the layout by
          `.only-changed` in styles.css, so the page shows the changed
          settings and nothing else. */}
      <div
        className={`settings-layout${onlyChanged ? " only-changed" : ""}`}
      >
        <nav className="settings-nav" aria-label={STR.settings.nav.label}>
          <ul>
            {visibleSections.map((s, i, run) => {
              // The caption renders where a family begins — the list is
              // ordered by group (settingsSections.ts), so one comparison
              // against the previous entry is the whole rule.
              const newGroup = i === 0 || run[i - 1].group !== s.group;
              return (
                <Fragment key={s.id}>
                  {newGroup && (
                    <li className="settings-nav-group">
                      {GROUP_LABEL[s.group]}
                    </li>
                  )}
                  <li>
                    <button
                      type="button"
                      className={`settings-nav-item${
                        currentSection === s.id ? " active" : ""
                      }`}
                      // The same string the rest of the app jumps by, so this
                      // rail exercises the public route rather than a private
                      // shortcut past it.
                      data-target={settingsJumpTarget(s.id)}
                      aria-current={
                        currentSection === s.id ? "location" : undefined
                      }
                      onClick={() => jumpToSettingsSection(s.id)}
                    >
                      {s.heading}
                    </button>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </nav>

        <div className="settings-sections">

          <section id="status" hidden={hidden("status")}>
            <h3>{STR.settings.status.heading}</h3>
            <div className="scroll">
              <table className="kv">
                <tbody>
                  <tr>
                    <td>{STR.settings.status.version}</td>
                    <td>{health?.version ?? "0.1.0"}</td>
                  </tr>
                  <tr>
                    <td>{STR.settings.status.runtime}</td>
                    <td>
                      {isTauri
                        ? STR.settings.status.runtimeDesktop
                        : STR.settings.status.runtimeDemo}
                    </td>
                  </tr>
                  <tr>
                    <td>{STR.settings.status.shellIntegration}</td>
                    <td>
                      {health
                        ? health.shellIntegration
                          ? STR.settings.status.shellInstalled
                          : STR.settings.status.shellMissing
                        : "—"}
                    </td>
                  </tr>
                  <tr>
                    <td>{STR.settings.status.home}</td>
                    <td>{health?.homeDir ?? "—"}</td>
                  </tr>
                  <tr>
                    <td>{STR.settings.status.sharedTabs}</td>
                    <td>
                      {shared.length === 0
                        ? STR.settings.status.noneShared
                        : shared
                            .map((t) =>
                              STR.settings.status.sharedEntry({
                                title: t.title,
                                viewers: t.share!.viewers.length,
                              })
                            )
                            .join(", ")}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="appearance" hidden={hidden("appearance")}>
            <h3>{STR.settings.appearance.heading}</h3>
            <p>{STR.settings.appearance.blurb}</p>
            {/* The control carries the registry key it edits, so a search
                hit lights up this row and nothing around it. */}
            <div
              className={`segmented${hit(CONFIG_KEYS.theme)}`}
              data-setting-key={CONFIG_KEYS.theme}
              role="radiogroup"
              aria-label={STR.settings.appearance.heading}
            >
              {THEME_CHOICES.map((c) => (
                <button
                  key={c.value}
                  role="radio"
                  aria-checked={themePreference === c.value}
                  // Judged on this setting alone: a control whose current
                  // value is unknown must not be offered, because changing
                  // it would write whatever it happens to be showing —
                  // which is nothing the user chose.
                  disabled={themePreference === null}
                  className={`segmented-btn${
                    themePreference === c.value ? " active" : ""
                  }`}
                  onClick={() => setThemePreference(c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <p>{STR.settings.appearance.terminalFontBlurb}</p>
            <label htmlFor="terminal-font-family">
              {STR.settings.appearance.terminalFontFamily}
            </label>
            <input
              id="terminal-font-family"
              className={`settings-input${hit(TERMINAL_KEYS.fontFamily)}`}
              data-setting-key={TERMINAL_KEYS.fontFamily}
              spellCheck={false}
              disabled={font === null}
              placeholder={STR.settings.appearance.terminalFontPlaceholder}
              value={font?.family ?? ""}
              onChange={(e) => {
                if (font === null) return;
                writeFont(TERMINAL_KEYS.fontFamily, e.target.value, {
                  ...font,
                  family: e.target.value,
                });
              }}
            />
            {/* Said on the spot, never by quietly falling back: a name this
                machine has no font for is still saved (the user may be about
                to install it), and they are told which one is not there
                rather than left wondering why nothing changed. Silence is
                the third state — the measurement itself was unavailable. */}
            {font !== null && font.family.trim() === "" && (
              <p className="pw-empty">
                {STR.settings.appearance.terminalFontEmptyNote}
              </p>
            )}
            {font !== null && font.family.trim() !== "" && missingFonts !== null && (
              <p className="pw-empty">
                {missingFonts.length === 0
                  ? STR.settings.appearance.terminalFontOkNote
                  : STR.settings.appearance.terminalFontMissingNote({
                      names: missingFonts.join(", "),
                    })}
              </p>
            )}
            <p className="pw-empty">
              {STR.settings.appearance.terminalFontIconNote}
            </p>

            <label htmlFor="terminal-font-size">
              {STR.settings.appearance.terminalFontSize}
            </label>
            <input
              id="terminal-font-size"
              type="number"
              className={`settings-input${hit(TERMINAL_KEYS.fontSize)}`}
              data-setting-key={TERMINAL_KEYS.fontSize}
              disabled={font === null || fontSizeRange === null}
              min={fontSizeRange?.min}
              max={fontSizeRange?.max}
              value={sizeDraft ?? (font === null ? "" : String(font.size))}
              onChange={(e) => {
                setSizeDraft(e.target.value);
                const size = acceptedNumber(e.target.value, fontSizeRange);
                if (size === null || font === null) return;
                writeFont(TERMINAL_KEYS.fontSize, size, { ...font, size });
              }}
              onBlur={() => setSizeDraft(null)}
            />
            <p className="pw-empty">
              {STR.settings.appearance.terminalFontSizeUnit}
            </p>

            <label htmlFor="terminal-line-height">
              {STR.settings.appearance.terminalLineHeight}
            </label>
            <input
              id="terminal-line-height"
              type="number"
              className={`settings-input${hit(TERMINAL_KEYS.lineHeightPercent)}`}
              data-setting-key={TERMINAL_KEYS.lineHeightPercent}
              disabled={font === null || lineHeightRange === null}
              min={lineHeightRange?.min}
              max={lineHeightRange?.max}
              value={
                spacingDraft ??
                (font === null ? "" : String(font.lineHeightPercent))
              }
              onChange={(e) => {
                setSpacingDraft(e.target.value);
                const percent = acceptedNumber(e.target.value, lineHeightRange);
                if (percent === null || font === null) return;
                writeFont(TERMINAL_KEYS.lineHeightPercent, percent, {
                  ...font,
                  lineHeightPercent: percent,
                });
              }}
              onBlur={() => setSpacingDraft(null)}
            />
            <p className="pw-empty">
              {STR.settings.appearance.terminalLineHeightUnit}
            </p>

            {/* The ligature switch. Judged on this setting alone, like every
                control above: `null` is "the file has not answered", and a
                switch showing off while the file says on would write the
                wrong answer the moment it was pressed. */}
            <label htmlFor="terminal-ligatures">
              {STR.settings.appearance.terminalLigatures}
            </label>
            <div className="btn-row">
              <button
                id="terminal-ligatures"
                className={`btn${ligatures === true ? " active" : ""}${hit(
                  TERMINAL_KEYS.ligatures
                )}`}
                data-setting-key={TERMINAL_KEYS.ligatures}
                role="switch"
                aria-checked={ligatures === true}
                disabled={ligatures === null}
                onClick={() => writeLigatures(ligatures !== true)}
              >
                {ligatures === true
                  ? STR.settings.appearance.on
                  : STR.settings.appearance.off}
              </button>
            </div>
            <p className="pw-empty">
              {ligatures === null
                ? STR.settings.appearance.terminalLigaturesUnread
                : STR.settings.appearance.terminalLigaturesNote}
            </p>
            {/* When it takes effect, and where — both said because both
                differ from what the rest of this section does. */}
            {ligatures !== null && (
              <>
                <p className="pw-empty">
                  {STR.settings.appearance.terminalLigaturesWhen}
                </p>
                <p className="pw-empty">
                  {STR.settings.appearance.terminalLigaturesScope}
                </p>
              </>
            )}

            <label htmlFor="terminal-background-tasks">
              {STR.settings.appearance.terminalBackgroundTasks}
            </label>
            <div className="btn-row">
              <button
                id="terminal-background-tasks"
                className={`btn${backgroundTasks === true ? " active" : ""}${hit(
                  TERMINAL_KEYS.backgroundTasks
                )}`}
                data-setting-key={TERMINAL_KEYS.backgroundTasks}
                role="switch"
                aria-checked={backgroundTasks === true}
                disabled={backgroundTasks === null}
                onClick={() => writeBackgroundTasks(backgroundTasks !== true)}
              >
                {backgroundTasks === true
                  ? STR.settings.appearance.on
                  : STR.settings.appearance.off}
              </button>
            </div>
            <p className="pw-empty">
              {backgroundTasks === null
                ? STR.settings.appearance.terminalBackgroundTasksUnread
                : STR.settings.appearance.terminalBackgroundTasksNote}
            </p>

            <label htmlFor="terminal-image-memory">
              {STR.settings.appearance.terminalImageMemory}
            </label>
            <input
              id="terminal-image-memory"
              type="number"
              className={`settings-input${hit(TERMINAL_KEYS.imageMemoryMb)}`}
              data-setting-key={TERMINAL_KEYS.imageMemoryMb}
              disabled={imageMemory === null || imageMemoryRange === null}
              min={imageMemoryRange?.min}
              max={imageMemoryRange?.max}
              value={
                imageMemoryDraft ??
                (imageMemory === null ? "" : String(imageMemory))
              }
              onChange={(e) => {
                setImageMemoryDraft(e.target.value);
                const mb = acceptedNumber(e.target.value, imageMemoryRange);
                if (mb === null) return;
                writeImageMemory(mb);
              }}
              onBlur={() => setImageMemoryDraft(null)}
            />
            <p className="pw-empty">
              {STR.settings.appearance.terminalImageMemoryUnit}
            </p>
            {/* Per pane and new-terminals-only, because both differ from
                what a reader would assume from the neighbours above. */}
            {imageMemory !== null && (
              <p className="pw-empty">
                {STR.settings.appearance.terminalImageMemoryWhen}
              </p>
            )}

            <label htmlFor="terminal-paste-guard">
              {STR.settings.appearance.terminalPasteGuard}
            </label>
            <div className="btn-row">
              <button
                id="terminal-paste-guard"
                className={`btn${pasteGuard === true ? " active" : ""}${hit(
                  TERMINAL_KEYS.pasteGuard
                )}`}
                data-setting-key={TERMINAL_KEYS.pasteGuard}
                role="switch"
                aria-checked={pasteGuard === true}
                disabled={pasteGuard === null}
                onClick={() => writePasteGuard(pasteGuard !== true)}
              >
                {pasteGuard === true
                  ? STR.settings.appearance.on
                  : STR.settings.appearance.off}
              </button>
            </div>
            <p className="pw-empty">
              {pasteGuard === null
                ? STR.settings.appearance.terminalLigaturesUnread
                : STR.settings.appearance.terminalPasteGuardNote}
            </p>
            {pasteGuard !== null && (
              <p className="pw-empty">
                {STR.settings.appearance.terminalPasteGuardWhen}
              </p>
            )}
          </section>


          <section id="default-apps" hidden={hidden("default-apps")}>
            <h3>{STR.settings.defaultApps.heading}</h3>
            {/* The second sentence is not a hedge. Merely installing Tabverse does
                change one thing: a type that no app had claimed opens here now,
                because there is nobody to prefer over it. Measured, not assumed —
                an earlier build claimed far more than that until every declaration
                was marked a secondary viewer, and the copy that said "nothing is
                claimed until you turn one on" was simply false. */}
            <p>{STR.settings.defaultApps.blurb}</p>
            {defaults === null ? (
              <p className="pw-empty">{STR.settings.defaultApps.reading}</p>
            ) : (
              <div className="scroll">
                <table className="kv">
                  <tbody>
                    {defaults.map((s) => {
                      const label = DEFAULT_APP_LABELS[s.kind];
                      return (
                        <tr key={s.kind}>
                          <td>
                            <strong>{label.title}</strong>
                            <div className="pw-empty">{label.blurb}</div>
                            {/* The count, not just on or off: another app can take
                                a type back at any time, and "97 of 118" is the
                                difference between working and nearly working. */}
                            <div className="pw-empty">
                              {s.enabled
                                ? STR.settings.defaultApps.opensAll({
                                    total: s.total,
                                  })
                                : s.held > 0
                                  ? STR.settings.defaultApps.opensSome({
                                      held: s.held,
                                      total: s.total,
                                    })
                                  : STR.settings.defaultApps.currently({
                                      app:
                                        s.representative ??
                                        STR.settings.defaultApps.nothing,
                                    })}
                            </div>
                            {s.note && <ErrorState inline error={s.note} />}
                            {!s.enabled && s.missing.length > 0 && (
                              <div className="pw-empty">
                                {STR.settings.defaultApps.stillElsewhere({
                                  apps: s.missing.join(" · "),
                                })}
                                {s.held + s.missing.length < s.total ? " …" : ""}
                              </div>
                            )}
                          </td>
                          <td>
                            <button
                              className={`btn${s.enabled ? " active" : ""}`}
                              disabled={busyKind === s.kind}
                              onClick={() => void toggleDefault(s)}
                            >
                              {busyKind === s.kind
                                ? STR.settings.defaultApps.working
                                : s.enabled
                                  ? STR.settings.defaultApps.turnOff
                                  : s.settable
                                    ? STR.settings.defaultApps.makeDefault
                                    : STR.settings.defaultApps.registerAndOpen}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section id="keyboard" hidden={hidden("keyboard")}>
            <h3>{STR.settings.keyboard.heading}</h3>
            <p>{STR.settings.keyboard.blurb}</p>
            <p>{STR.settings.keyboard.pageDelay}</p>
            <p>{STR.settings.keyboard.unknowable}</p>

            <div className="keyboard-lookup">
              <button
                className={`btn${looking ? " active" : ""}`}
                aria-pressed={looking}
                onClick={() => {
                  stopRecording();
                  setLookedUp(null);
                  setLooking((v) => !v);
                }}
              >
                {looking
                  ? STR.settings.keyboard.lookupListening
                  : STR.settings.keyboard.lookup}
              </button>
              {lookupLines.length > 0 && (
                <div className="keyboard-verdict" role="status">
                  {lookupLines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              )}
            </div>

            <div className="scroll">
              <table className="kv">
                <tbody>
                  {shortcutRows.map((s) => {
                    const command = String(s.command);
                    const isRecording = recording === command;
                    const lit =
                      match !== null && match.commands.includes(command);
                    return (
                      <tr
                        key={command}
                        data-command={command}
                        className={lit ? "settings-hit" : undefined}
                      >
                        <td>{s.keys && formatKeys(s.keys)}</td>
                        <td>
                          {s.label}
                          {isRecording && (
                            <div className="keyboard-recorder">
                              <p className="pw-empty">
                                {STR.settings.keyboard.pressNow}
                              </p>
                              {verdict !== null && (
                                <div className="keyboard-verdict" role="status">
                                  {verdictLines(verdict).map((line) => (
                                    <p key={line}>{line}</p>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="keyboard-actions">
                          {isRecording ? (
                            <div className="btn-row">
                              <button
                                className="btn primary"
                                // A key another command already answers cannot
                                // be saved — the verdict above says which
                                // command, so this is a refusal with an
                                // address. A key the system holds is NOT
                                // blocked: that list can never be complete.
                                disabled={verdict === null || verdict.blocked}
                                onClick={() => {
                                  if (candidate === null) return;
                                  void commitKeyBinding(s.command, candidate);
                                  stopRecording();
                                }}
                              >
                                {STR.settings.keyboard.save}
                              </button>
                              <button className="btn" onClick={stopRecording}>
                                {STR.settings.keyboard.cancel}
                              </button>
                            </div>
                          ) : (
                            <div className="btn-row">
                              <button
                                className="btn"
                                onClick={() => startRecording(command)}
                              >
                                {STR.settings.keyboard.change}
                              </button>
                              {s.keys !== undefined && (
                                <button
                                  className="btn"
                                  onClick={() =>
                                    void commitKeyBinding(s.command, null)
                                  }
                                >
                                  {STR.settings.keyboard.unbind}
                                </button>
                              )}
                              {keyOverlay()[command] !== undefined && (
                                <button
                                  className="btn"
                                  onClick={() => resetKeyBinding(s.command)}
                                >
                                  {STR.settings.keyboard.reset}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section id="session" hidden={hidden("session")}>
            <h3>{STR.settings.session.heading}</h3>
            <p>{STR.settings.session.blurb}</p>
          </section>

          <section id="auto-archive" hidden={hidden("auto-archive")}>
            <h3>{STR.settings.autoArchive.heading}</h3>
            <p>{STR.settings.autoArchive.blurb}</p>
            <select
              className={`settings-select${hit(CONFIG_KEYS.archiveAfter)}`}
              data-setting-key={CONFIG_KEYS.archiveAfter}
              value={archiveThreshold ?? UNREAD}
              disabled={archiveThreshold === null}
              onChange={(e) =>
                setArchiveThreshold(e.target.value as ArchiveThreshold)
              }
            >
              {/* A select whose value matches no option shows the first one
                  instead — which would put "After 12 hours" on screen as
                  though it were the setting. An empty option, present only
                  while nothing has been read, is what makes the control
                  show nothing. It carries no words, so there is none to
                  translate. */}
              {archiveThreshold === null && <option value={UNREAD} />}
              <option value="12h">{STR.settings.autoArchive.after12h}</option>
              <option value="24h">{STR.settings.autoArchive.after24h}</option>
              <option value="7d">{STR.settings.autoArchive.after7d}</option>
              <option value="off">{STR.settings.autoArchive.never}</option>
            </select>
          </section>

          <div
            className="settings-section-slot"
            hidden={hidden(PROFILES_SECTION_ID)}
          >
            <ProfilesSection />
          </div>

          <section
            id={TERMINAL_COMPLETIONS_SECTION_ID}
            hidden={hidden(TERMINAL_COMPLETIONS_SECTION_ID)}
          >
            <h3>{STR.settings.completions.heading}</h3>
            <p>{STR.settings.completions.blurb}</p>
            {/* The two layers, named by which one is answering: what a
                terminal completes against, and what the app shipped with
                as the floor. */}
            <p className="pw-empty">
              {completionsVersion === null
                ? STR.settings.completions.currentNone
                : STR.settings.completions.currentVersion({
                    version: completionsVersion,
                  }) +
                  " " +
                  (completionsSource === "state"
                    ? STR.settings.completions.fromUpdate
                    : STR.settings.completions.fromSnapshot)}
            </p>
            {snapshotVersion() !== null && (
              <p className="pw-empty">
                {STR.settings.completions.snapshotVersion({
                  version: snapshotVersion() ?? "",
                })}
              </p>
            )}
            {typeof window !== "undefined" &&
            !("__TAURI_INTERNALS__" in window) ? (
              <p className="pw-empty">{STR.settings.completions.demoNote}</p>
            ) : (
              <>
                <label htmlFor="terminal-completions-url">
                  {STR.settings.completions.url}
                </label>
                <input
                  id="terminal-completions-url"
                  className={`settings-input${hit(
                    TERMINAL_KEYS.completionsUrl
                  )}`}
                  data-setting-key={TERMINAL_KEYS.completionsUrl}
                  spellCheck={false}
                  disabled={completionsUrl === null}
                  value={completionsUrl ?? ""}
                  onChange={(e) => typeCompletionsUrl(e.target.value)}
                />
                <p className="pw-empty">{STR.settings.completions.urlNote}</p>
                <div className="btn-row">
                  <button
                    className="btn"
                    disabled={completionsBusy || (completionsUrl ?? "") === ""}
                    onClick={() => void updateCompletions()}
                  >
                    {completionsBusy
                      ? STR.settings.completions.updating
                      : STR.settings.completions.updateNow}
                  </button>
                </div>
                {completionsNote !== null &&
                  (typeof completionsNote === "string" ? (
                    <p className="pw-empty">{completionsNote}</p>
                  ) : (
                    <ErrorState inline error={completionsNote} />
                  ))}
              </>
            )}
          </section>


          <section id="search-engine" hidden={hidden("search-engine")}>
            <h3>{STR.settings.searchEngine.heading}</h3>
            <p>
              {STR.settings.searchEngine.blurb({
                keys: formatKeys(keysFor("location-bar")),
              })}
            </p>
            <select
              className={`settings-select${hit(CONFIG_KEYS.searchEngine)}`}
              data-setting-key={CONFIG_KEYS.searchEngine}
              value={searchEngine ?? UNREAD}
              disabled={searchEngine === null}
              onChange={(e) => setSearchEngine(e.target.value as SearchEngineId)}
            >
              {/* Same reason as the auto-archive select above. */}
              {searchEngine === null && <option value={UNREAD} />}
              {(Object.keys(SEARCH_ENGINES) as Array<keyof typeof SEARCH_ENGINES>).map(
                (id) => (
                  <option key={id} value={id}>
                    {SEARCH_ENGINES[id].label}
                  </option>
                )
              )}
              <option value="custom">{STR.settings.searchEngine.custom}</option>
            </select>
            {searchEngine === "custom" && (
              <>
                <input
                  className={`settings-input${hit(
                    CONFIG_KEYS.customSearchTemplate
                  )}`}
                  data-setting-key={CONFIG_KEYS.customSearchTemplate}
                  spellCheck={false}
                  disabled={customSearchTemplate === null}
                  placeholder={STR.settings.searchEngine.templatePlaceholder}
                  value={templateDraft}
                  onChange={(e) => {
                    const value = e.target.value;
                    setTemplateDraft(value);
                    // Committed only once it validates; until then searches
                    // keep running on the last good template (or the default).
                    if (validSearchTemplate(value, templateRule)) {
                      setSearchEngine("custom", value.trim());
                    }
                  }}
                />
                {/* Nothing to say until there is a rule to say it by: with no
                    schema yet, "this is not a valid template" would be a
                    verdict nobody has the grounds for. */}
                {templateRule !== null && (
                  <p className="pw-empty">
                    {templateOk
                      ? STR.settings.searchEngine.templateOkNote
                      : STR.settings.searchEngine.templateBadNote}
                  </p>
                )}
              </>
            )}
          </section>

          <section id="history" hidden={hidden("history")}>
            <h3>{STR.settings.history.heading}</h3>
            <p>
              {STR.settings.history.blurb({
                keys: formatKeys(keysFor("history-panel")),
              })}
            </p>
          </section>

          <section id="passwords" hidden={hidden("passwords")}>
            <h3>{STR.settings.passwords.heading}</h3>
            <p>{STR.settings.savedPasswordsIntro}</p>
            <div className="btn-row">
              <button
                className="btn"
                onClick={async () => {
                  const { invoke } = await import("@tauri-apps/api/core");
                  // The gate is here, not on the settings page: settings shows
                  // no login, so there is nothing to protect until this opens.
                  try {
                    await invoke("pw_authorize_view");
                  } catch (e) {
                    setTransferNote(
                      errorText(e).includes("not authorized")
                        ? STR.settings.passwordsNotAuthorized
                        : describeError(e, STR.errors.actions.showPasswords)
                    );
                    return;
                  }
                  useStore.getState().setPasswordsOpen(true);
                }}
              >
                {STR.settings.passwords.showAll}
              </button>
              <button className="btn" onClick={importPasswords}>
                {STR.settings.passwords.importFile}
              </button>
              <button className="btn" onClick={exportPasswords}>
                {STR.settings.passwords.exportFile}
              </button>
            </div>
            {transferNote &&
              (typeof transferNote === "string" ? (
                <p className="pw-empty">{transferNote}</p>
              ) : (
                <ErrorState inline error={transferNote} />
              ))}
          </section>

          <section id="sites" hidden={hidden("sites")}>
            <h3>{STR.settings.sites.heading}</h3>
            <p>{STR.settings.sites.blurb}</p>

            <h4>{STR.settings.sites.permissionsHeading}</h4>
            {media === null || media.length === 0 ? (
              <p className="pw-empty">{STR.settings.sites.permissionsNone}</p>
            ) : (
              <table className="pw-table">
                <tbody>
                  {media.map((g) => (
                    <tr key={`${g.host}|${g.kind}`}>
                      <td>{g.host}</td>
                      <td>{g.kind}</td>
                      <td>
                        {g.allow
                          ? STR.settings.sites.allowed
                          : STR.settings.sites.refused}
                      </td>
                      <td>
                        <button
                          className="btn"
                          onClick={() => void revokeMedia(g.host, g.kind)}
                        >
                          {STR.settings.sites.remove}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h4>{STR.settings.sites.certsHeading}</h4>
            <p>{STR.settings.sites.certsBlurb}</p>
            {trusted.length === 0 ? (
              <p className="pw-empty">{STR.settings.sites.certsNone}</p>
            ) : (
              <table className="pw-table">
                <tbody>
                  {trusted.map((host) => (
                    <tr key={host}>
                      <td>{host}</td>
                      <td>
                        <button
                          className="btn"
                          onClick={() => void revokeTrust(host)}
                        >
                          {STR.settings.sites.remove}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h4>{STR.settings.sites.zoomHeading}</h4>
            {zooms.length === 0 ? (
              <p className="pw-empty">{STR.settings.sites.zoomNone}</p>
            ) : (
              <table className="pw-table">
                <tbody>
                  {zooms.map((z) => (
                    <tr key={z.host}>
                      <td>{z.host}</td>
                      <td>{Math.round(z.scale * 100)}%</td>
                      <td>
                        <button
                          className="btn"
                          onClick={() => forgetZoomFor(z.host)}
                        >
                          {STR.settings.sites.remove}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h4>{STR.settings.sites.scriptsHeading}</h4>
            {scriptGrants.length === 0 ? (
              <p className="pw-empty">{STR.settings.sites.scriptsNone}</p>
            ) : (
              <table className="pw-table">
                <tbody>
                  {scriptGrants.map((row) => (
                    <tr key={row.host}>
                      <td>
                        {row.host}
                        <div className="pw-empty">
                          {STR.settings.sites.scriptsSecondLine}{" "}
                          {row.granted.map((s) => (
                            <span key={s.id} className="us-grant">
                              {s.name}
                              <button
                                className="us-grant-x"
                                title={STR.settings.sites.scriptRevokeHint({
                                  script: s.name,
                                  host: row.host,
                                })}
                                aria-label={STR.settings.sites.scriptRevokeHint(
                                  { script: s.name, host: row.host }
                                )}
                                onClick={() =>
                                  void revokeScriptGrant(s.id, row.host)
                                }
                              >
                                <TrashIcon size={10} />
                              </button>
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="btn-row">
              <button className="btn" onClick={() => void clearSiteMemory()}>
                {STR.settings.sites.clearAll}
              </button>
            </div>
          </section>


          <section id="remote" hidden={hidden("remote")}>
            <h3>{STR.settings.remote.heading}</h3>
            <p>{STR.settings.remote.blurb}</p>
            <p>
              {STR.settings.remote.standaloneLead}{" "}
              <code>tools/build-web.sh</code>
              {STR.settings.remote.standaloneTail}
            </p>
          </section>

          <section id="network" hidden={hidden("network")}>
            <h3>{STR.settings.network.heading}</h3>
            <p>{STR.settings.network.blurb}</p>
            {/* A proxy that has died on its feet is a standing condition of
                the whole section while coverage was asked for, so it says so
                at the top — the same shape the unreadable-file banner uses
                one level up, in the section's own warn colours. */}
            {proxyLost && (
              <div className="settings-banner warn" role="alert">
                <p className="settings-banner-title">
                  {STR.settings.network.proxyDownHeading}
                </p>
                <p>{STR.settings.network.proxyDownBlurb}</p>
              </div>
            )}
            <select
              className={`settings-select${hit(NETWORK_KEYS.dnsMode)}`}
              data-setting-key={NETWORK_KEYS.dnsMode}
              value={network?.dns_mode ?? UNREAD}
              disabled={network === null || dnsModes.length === 0}
              onChange={(e) =>
                writeNetwork(NETWORK_KEYS.dnsMode, "dns_mode", e.target.value)
              }
            >
              {/* Same reason as the auto-archive select above: a value
                  matching no option would show the first one as though it
                  were the setting. */}
              {network === null && <option value={UNREAD} />}
              {dnsModes.map((id) => (
                <option key={id} value={id}>
                  {dnsLabel(id)}
                </option>
              ))}
            </select>
            {network?.dns_mode === DNS_CUSTOM_MODE && (
              <>
                <input
                  className={`settings-input${hit(NETWORK_KEYS.dnsCustomUrl)}`}
                  data-setting-key={NETWORK_KEYS.dnsCustomUrl}
                  spellCheck={false}
                  placeholder={STR.settings.network.customPlaceholder}
                  value={network.dns_custom_url}
                  onChange={(e) => typeDnsUrl(e.target.value)}
                />
                {/* Three states and not two: empty is "nothing set yet", which
                    is neither good nor bad and has its own consequence — the
                    lookups go on through the system. Nothing at all is said
                    until the rule has arrived, because calling an address bad
                    before reading the rule is a verdict without grounds. */}
                {dnsUrlRule !== null && (
                  <p className="pw-empty">
                    {network.dns_custom_url === ""
                      ? STR.settings.network.customEmptyNote
                      : dnsUrlRefusal === null
                        ? STR.settings.network.customOkNote
                        : STR.settings.network.customBadNote}
                  </p>
                )}
              </>
            )}

            <label htmlFor="network-cover-page-traffic">
              {STR.settings.network.coverPageTraffic}
            </label>
            <div className="btn-row">
              <button
                id="network-cover-page-traffic"
                className={`btn${coverPageTraffic === true ? " active" : ""}${hit(
                  NETWORK_KEYS.coverPageTraffic
                )}`}
                data-setting-key={NETWORK_KEYS.coverPageTraffic}
                role="switch"
                aria-checked={coverPageTraffic === true}
                disabled={coverPageTraffic === null}
                onClick={() => writeCover(coverPageTraffic !== true)}
              >
                {coverPageTraffic === true
                  ? STR.settings.appearance.on
                  : STR.settings.appearance.off}
              </button>
            </div>
            <p className="pw-empty">{STR.settings.network.coverNote}</p>
            <p className="pw-empty">{STR.settings.network.coverWhen}</p>
            {coverPageTraffic === null && (
              <p className="pw-empty">{STR.settings.network.coverUnread}</p>
            )}
            {!isCoverable && (
              <p className="pw-empty">{STR.settings.network.coverGateNote}</p>
            )}
            {!IS_MAC && (
              <p className="pw-empty">
                {STR.settings.network.coverWindowsNote}
              </p>
            )}
            <p className="pw-empty">{STR.settings.network.restartNote}</p>
            {/* Rendered as the section's own paragraphs rather than as a list
                with a style of its own: the words are the point, they read as
                sentences, and this page already has one voice for a muted
                aside. The tabs line leads because it is the one that moves
                with the switch above. */}
            <p>{STR.settings.network.uncoveredHeading}</p>
            <p className="pw-empty">{tabsLine}</p>
            {UNCOVERED_EXITS.map((line, i) => (
              <p className="pw-empty" key={i}>
                {line}
              </p>
            ))}
          </section>


          <section id="backup" hidden={hidden("backup")}>
            <h3>{STR.settings.migrate.heading}</h3>
            <p>{STR.settings.migrate.blurb}</p>
            <div className="btn-row">
              <button className="btn" onClick={exportEverything}>
                {STR.settings.migrate.exportBtn}
              </button>
              <button className="btn" onClick={importEverything}>
                {STR.settings.migrate.importBtn}
              </button>
            </div>
            {migrateNote &&
              (typeof migrateNote === "string" ? (
                <p className="pw-empty">{migrateNote}</p>
              ) : (
                <ErrorState inline error={migrateNote} />
              ))}
          </section>

          {/* The one section rendered from another file, so the search
              hides it from outside rather than from within — the slot is
              transparent to layout and is styled alongside a bare
              <section> in styles.css. */}

          <BackgroundTasksSection hidden={hidden("background-tasks")} />


          <div
            className="settings-section-slot"
            hidden={hidden(USERSCRIPTS_SECTION_ID)}
          >
            <UserScriptsSection />
          </div>


          <section
            id="danger"
            className="settings-danger"
            hidden={hidden("danger")}
          >
            <h3>{STR.settings.danger.heading}</h3>
            <p>{STR.settings.danger.blurb}</p>
            <div className="btn-row">
              {danger.map((action) => (
                <button
                  key={action.id}
                  className="btn danger"
                  data-danger={action.id}
                  onClick={() => void runDangerAction(action)}
                >
                  {action.label}
                </button>
              ))}
            </div>
            <p className="pw-empty">{STR.settings.danger.factoryKeeps}</p>
            {dangerNote &&
              (typeof dangerNote === "string" ? (
                <p className="pw-empty">{dangerNote}</p>
              ) : (
                <ErrorState inline error={dangerNote} />
              ))}
          </section>
        </div>
      </div>
    </div>
  );
}
