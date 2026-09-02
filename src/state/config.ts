import { coreLog } from "../errlog";
import { keyOverlay, setKeyOverrides } from "../shortcuts";
import { STR } from "../strings";
import {
  setProfileFontFamilies,
  setProfileLigatures,
  setTerminalFont,
  setTerminalLigatures,
  type TerminalFont,
} from "../term/font";
import type { ThemePreference } from "../theme/tokens";
import type { ArchiveThreshold, SearchEngineId } from "./store";


// ------------------------------------------------------------ wire shapes

/**
 * `[appearance]` as the file writes it. Field names are the TOML keys, not
 * the store's — serde spells them exactly as `config.rs` declares them, and
 * renaming here would only hide which key a value came from.
 */
export interface ConfigAppearance {
  theme: ThemePreference;
  sidebar_width: number;
  sidebar_pinned: boolean;
}

/** `[browser]`. */
export interface ConfigBrowser {
  search_engine: SearchEngineId;
  custom_search_template: string;
  archive_after: ArchiveThreshold;
}

export interface ConfigNetwork {
  dns_mode: string;
  dns_custom_url: string;
  cover_page_traffic?: boolean;
}

export interface ConfigProfile {
  /** Unique among profiles, and not blank. It is the handle ⌘N picks by. */
  name: string;
  /** Absolute path of the shell; absent means the one a plain terminal gets. */
  shell?: string;
  /** Where the shell starts; absent means the home directory. */
  cwd?: string;
  /** Extra environment for the shell, on top of what it inherits. */
  env?: Record<string, string>;
  /** The colour a pane and its sidebar row wear under this profile. */
  badge?: string;
  font?: string;
  ligatures?: boolean;
  /** A command typed into the shell as soon as it exists. */
  run_on_start?: string;
}

export interface ConfigTemplate {
  name: string;
  tree: ConfigTemplateNode;
}

/** One terminal in a saved layout. */
export interface ConfigTemplateLeaf {
  kind: "leaf";
  profile?: string;
  cwd?: string;
  run_on_start?: string;
}

/** A row or a column in a saved layout. `ratios` are integer weights. */
export interface ConfigTemplateSplit {
  kind: "split";
  vertical: boolean;
  ratios?: number[];
  children: ConfigTemplateNode[];
}

export type ConfigTemplateNode = ConfigTemplateLeaf | ConfigTemplateSplit;

export interface ConfigTerminal {
  /** Empty means "the built-in stack" — src/term/font.ts owns that list. */
  font_family?: string;
  font_size?: number;
  /** Percent of the font's natural line height; xterm's multiplier ×100. */
  line_height_percent?: number;
  ligatures?: boolean;
  background_tasks?: boolean;
  image_memory_mb?: number;
  paste_guard?: boolean;
  completions_url?: string;
  /** Absent and empty are the same state: this user has declared none. */
  profiles?: ConfigProfile[];
  templates?: ConfigTemplate[];
}

export interface ConfigResident {
  default: boolean;
}

export interface ConfigValues {
  appearance: ConfigAppearance;
  browser: ConfigBrowser;
  network?: ConfigNetwork;
  terminal?: ConfigTerminal;
  resident?: ConfigResident;
  files?: Record<string, unknown>;
  keys?: Record<string, unknown>;
}

export interface ConfigWriteError {
  /** Dotted path, as `config_set` was called with it. */
  key: string;
  /** Why the file could not be written, in the core's own words. */
  error: string;
}

/** One key the file names that the registry does not know, and where it is. */
export interface ConfigWarning {
  /** Dotted path as written in the file, e.g. `appearance.sidebar_wdith`. */
  key: string;
  path: string;
  line: number;
  column: number;
}

/** What `config_get` answers with. */
export interface ConfigSnapshot {
  values: ConfigValues;
  warnings: ConfigWarning[];
  /** The files that contributed, in reading order. Empty = no file exists. */
  sources: string[];
}

/**
 * What a text setting's content has to be — `TextRule` in config.rs, arriving
 * over `config_schema` verbatim.
 *
 * Terms rather than a pattern, and that is the whole point: a regular
 * expression shared between Rust and JavaScript would be two dialects of one
 * rule, which is the same disease as two copies of it. These three fields are
 * read here and enforced there from the same registry row.
 */
export interface TextRule {
  /** Whether the empty string is accepted — "nothing configured". */
  allow_empty: boolean;
  /** A substring the value must carry, or null to demand none. */
  must_contain: string | null;
  /**
   * The URL schemes the value may open with, compared case-insensitively
   * (RFC 3986 §3.1), or null when the value is not an address.
   */
  schemes: string[] | null;
}

/** Which control a setting is edited with — mirrors `Kind` in config.rs. */
export type SettingKind =
  | { choice: { options: string[] } }
  | { number: { min: number; max: number } }
  | { text: TextRule }
  | "toggle";

/**
 * One row of the registry as `config_schema` hands it over — `SettingRow` in
 * config.rs, whose `#[serde(flatten)]` puts the static description and the
 * default on the same level here.
 */
export interface Setting {
  key: string;
  kind: SettingKind;
  /** Settings-page section id — the anchor in settingsSections.ts. */
  section: string;
  /** Path into `STR` for this setting's short title. */
  str_key: string;
  /**
   * What this setting is when the file says nothing about it, read out of
   * `Config::default()` as the schema is serialized (config.rs `SettingRow`).
   *
   * It arrives from the core and is never written down here: the changed-only
   * view judges "has the user moved this?" against this value, and a default
   * restated in the interface is the very copy the registry exists to
   * abolish; registry-derived tests keep consumers from inventing one.
   */
  default: unknown;
}

// ------------------------------------------------------------------- keys

/**
 * The dotted paths `config_set` and `config_reset` take. Named once here so
 * a caller cannot invent `appearance.sidebarWidth` and have it silently do
 * nothing — the file spells these in snake case.
 */
export const CONFIG_KEYS = {
  theme: "appearance.theme",
  sidebarWidth: "appearance.sidebar_width",
  sidebarPinned: "appearance.sidebar_pinned",
  searchEngine: "browser.search_engine",
  customSearchTemplate: "browser.custom_search_template",
  archiveAfter: "browser.archive_after",
} as const;

export const NETWORK_KEYS = {
  dnsMode: "network.dns_mode",
  dnsCustomUrl: "network.dns_custom_url",
  coverPageTraffic: "network.cover_page_traffic",
} as const;

export const TERMINAL_KEYS = {
  fontFamily: "terminal.font_family",
  fontSize: "terminal.font_size",
  lineHeightPercent: "terminal.line_height_percent",
  ligatures: "terminal.ligatures",
  backgroundTasks: "terminal.background_tasks",
  imageMemoryMb: "terminal.image_memory_mb",
  pasteGuard: "terminal.paste_guard",
  completionsUrl: "terminal.completions_url",
} as const;

export const RESIDENT_KEYS = {
  default: "resident.default",
} as const;

// --------------------------------------------------------------- mapping

/**
 * The six store fields the configuration file owns.
 *
 * Every one of them is nullable, and null has one meaning only: the file has
 * not been read yet. It is not "use the default" — the interface does not
 * know what the defaults are, on purpose, and a reader that meets a null
 * must say so or wait rather than substitute a value of its own.
 */
export interface ConfigSlice {
  themePreference: ThemePreference | null;
  sidebarWidth: number | null;
  sidebarPinned: boolean | null;
  searchEngine: SearchEngineId | null;
  customSearchTemplate: string | null;
  archiveThreshold: ArchiveThreshold | null;
}

/**
 * File shape to store fields — the one translation, used both for the
 * pre-load values and for what `config_get` answers, so the two can never
 * disagree about which key feeds which field.
 */
export function configSlice(values: ConfigValues): ConfigSlice {
  return {
    themePreference: values.appearance.theme,
    sidebarWidth: values.appearance.sidebar_width,
    sidebarPinned: values.appearance.sidebar_pinned,
    searchEngine: values.browser.search_engine,
    customSearchTemplate: values.browser.custom_search_template,
    archiveThreshold: values.browser.archive_after,
  };
}

/**
 * Nothing read yet. Six nulls and not one value — the state the interface is
 * in before either the injected configuration or `config_get` has answered.
 */
export const CONFIG_NOT_READ: ConfigSlice = {
  themePreference: null,
  sidebarWidth: null,
  sidebarPinned: null,
  searchEngine: null,
  customSearchTemplate: null,
  archiveThreshold: null,
};

/** An inclusive numeric range, as `Kind::Number` declares one. */
export interface NumberRange {
  min: number;
  max: number;
}

/**
 * The bounds the registry gives a numeric setting, read off the schema.
 *
 * The alternative is writing 180 and 520 beside the sidebar's drag clamp,
 * which is a copy of `SIDEBAR_WIDTH_MIN/MAX` exactly as much as `248` was a
 * copy of the default — and would go on clamping to the old bounds after the
 * registry widened them.
 */
export function numberRange(
  schema: readonly Setting[],
  key: string
): NumberRange | null {
  const setting = schema.find((s) => s.key === key);
  if (setting === undefined || typeof setting.kind !== "object") return null;
  const kind = setting.kind as { number?: NumberRange };
  return kind.number ?? null;
}

/**
 * The tokens a choice setting accepts, read off the schema.
 *
 * The third of the same family as [`numberRange`] and [`textRule`], and its
 * reason is theirs: a `<select>` whose options are typed out beside it is a
 * copy of the domain the file enforces, and it goes on offering a provider
 * the registry has dropped. Empty when the schema has not arrived or the key
 * names something that is not a choice — never a guess at the list.
 */
export function choiceOptions(
  schema: readonly Setting[],
  key: string
): readonly string[] {
  const setting = schema.find((s) => s.key === key);
  if (setting === undefined || typeof setting.kind !== "object") return [];
  const kind = setting.kind as { choice?: { options: string[] } };
  return kind.choice?.options ?? [];
}

/**
 * The content rule the registry gives a text setting, read off the schema.
 *
 * Its counterpart is [`numberRange`] and its reason is the same one: writing
 * "must be an http(s) address containing %s" beside the search-engine field
 * is a copy of `Kind::Text`'s rule exactly as much as `248` was a copy of the
 * sidebar's default — and would go on refusing what the registry had started
 * to accept. That is not hypothetical here: this rule had two homes and they
 * drifted over whether `HTTPS://` is a scheme.
 */
export function textRule(
  schema: readonly Setting[],
  key: string
): TextRule | null {
  const setting = schema.find((s) => s.key === key);
  if (setting === undefined || typeof setting.kind !== "object") return null;
  const kind = setting.kind as { text?: TextRule };
  return kind.text ?? null;
}

/**
 * Why `value` breaks `rule`, or null when it does not.
 *
 * THE judgement, on this side of the wire: the settings page's ok/bad note,
 * the search path's "can this template be used at all", and the demo
 * backend's refusal all ask this one function, which knows nothing except
 * what the rule it was handed says. The core's `check_text` is its opposite
 * number and reads the same registry row.
 */
export function textRefusal(rule: TextRule, value: string): string | null {
  // Empty is its own state, judged before any clause about content.
  if (value === "") return rule.allow_empty ? null : "must not be empty";
  if (rule.schemes !== null) {
    const head = value.toLowerCase();
    const offered = rule.schemes.map((s) => `${s}://`);
    if (!offered.some((s) => head.startsWith(s))) {
      return `must be a ${offered.join(" or ")} address`;
    }
  }
  if (rule.must_contain !== null && !value.includes(rule.must_contain)) {
    return `must contain ${rule.must_contain}`;
  }
  return null;
}

/** Whether every setting has arrived. */
export function configReady(slice: ConfigSlice): boolean {
  return Object.values(slice).every((v) => v !== null);
}

// ------------------------------------------------------- the injected copy

/**
 * The name the core injects the loaded configuration under, before the
 * page's first script runs (src-tauri/src/lib.rs, beside the boot theme it
 * has done the same way since the previous round).
 *
 * This is what lets the store be built from real values despite being built
 * synchronously: no round trip, and — the point — no stand-in values here to
 * go stale when a default changes in `impl Default for Config`. The payload
 * is `config_get`'s `values` field verbatim. Warnings and sources are not
 * injected; they belong to the real load, which happens moments later and
 * has a banner of its own.
 */
export const BOOT_CONFIG_KEY = "__TABVERSE_BOOT_CONFIG__";

/**
 * The registry rows, under the name the browser demo receives them by.
 *
 * On the desktop the schema is a command rather than an injection — the page
 * can afford a round trip for it, since only the settings page reads it. The
 * demo has no command to make, so tools/vite-demo-config.mjs puts the same
 * rows here at dev-server start, derived from `SETTINGS` and
 * `Config::default()` by the extractor the registry gate already runs on
 * them. A separate name from [`BOOT_CONFIG_KEY`] because it is separate
 * knowledge: values are what the desktop injects, rows are what it answers.
 */
export const DEMO_SCHEMA_KEY = "__TABVERSE_DEMO_CONFIG_SCHEMA__";

export const DEMO_WRITE_FAILS_KEY = "__TABVERSE_DEMO_WRITE_FAILS__";

declare global {
  interface Window {
    [BOOT_CONFIG_KEY]?: unknown;
    [DEMO_SCHEMA_KEY]?: unknown;
    [DEMO_WRITE_FAILS_KEY]?: unknown;
  }
}

/**
 * Enough of a shape check that a malformed injection is treated as no
 * injection rather than as six undefined settings. It asks only that the two
 * live sections are objects — which fields they carry is the registry's
 * business, and listing them here would be a copy of the registry.
 */
function looksLikeConfig(v: unknown): v is ConfigValues {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.appearance === "object" &&
    c.appearance !== null &&
    typeof c.browser === "object" &&
    c.browser !== null
  );
}

export function bootConfig(): ConfigValues | null {
  if (typeof window === "undefined") return null;
  const raw = window[BOOT_CONFIG_KEY];
  return looksLikeConfig(raw) ? raw : null;
}

/** The six fields as the injected configuration leaves them. */
export function bootConfigSlice(): ConfigSlice {
  const boot = bootConfig();
  return boot === null ? CONFIG_NOT_READ : configSlice(boot);
}

// ------------------------------------------------------- the keys overlay

export function keyOverrides(values: ConfigValues | null): Record<string, string> {
  const raw = values?.keys;
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [command, keys] of Object.entries(raw)) {
    if (typeof keys === "string") out[command] = keys;
  }
  return out;
}

/**
 * Hand the overlay to `shortcuts.ts`, which every consumer of a key reads.
 *
 * Called from exactly two places, and both of them are reads of the file:
 * once at module evaluation for the copy the core injected before the first
 * paint, and again on every [`configGet`]. The direction matters — this
 * module knows about the shortcut table and the shortcut table knows nothing
 * about configuration, so a hand-edited file reaches the ⌘/ overlay, the
 * settings page and the key handler without any of them importing this.
 */
function publishKeyOverrides(values: ConfigValues | null): void {
  setKeyOverrides(keyOverrides(values));
}

publishKeyOverrides(bootConfig());

// -------------------------------------------------------- the terminal font

/**
 * The three font values a configuration holds, or null when it does not hold
 * all three.
 *
 * All three or none, and never a mixture: a terminal takes a family, a size
 * and a spacing together, and a half-read set would mean this module picking
 * the missing one — which is a default written in the interface, the disease
 * the registry exists to cure. Null is "not read yet", exactly as it is for
 * the six settings the store carries.
 */
export function terminalFontOf(values: ConfigValues | null): TerminalFont | null {
  const section = values?.terminal;
  if (typeof section !== "object" || section === null) return null;
  const { font_family: family, font_size: size } = section;
  const percent = section.line_height_percent;
  if (typeof family !== "string") return null;
  if (typeof size !== "number" || typeof percent !== "number") return null;
  return { family, size, lineHeightPercent: percent };
}

/**
 * What the configuration says about ligatures, or null when it says nothing.
 *
 * Null rather than an answer of this module's own: a core older than this
 * release sends a `[terminal]` without the key, and reading that as an
 * instruction would be the interface deciding a renderer.
 */
export function terminalLigaturesOf(values: ConfigValues | null): boolean | null {
  const on = values?.terminal?.ligatures;
  return typeof on === "boolean" ? on : null;
}

export function terminalBackgroundTasksOf(
  values: ConfigValues | null
): boolean | null {
  const on = values?.terminal?.background_tasks;
  return typeof on === "boolean" ? on : null;
}

/** App-wide resident default; null means an older core has not declared it. */
export function residentDefaultOf(values: ConfigValues | null): boolean | null {
  const on = values?.resident?.default;
  return typeof on === "boolean" ? on : null;
}

export function terminalImageMemoryOf(
  values: ConfigValues | null
): number | null {
  const mb = values?.terminal?.image_memory_mb;
  return typeof mb === "number" ? mb : null;
}

let imageMemoryMb: number | null = null;

/** The construction-time read (see the module-level holder above). */
export function terminalImageMemoryMb(): number | null {
  return imageMemoryMb;
}

/** Test seam: put the module in the state a published value would leave
 * it in, or back to "nothing has arrived". */
export function setTerminalImageMemoryForTest(mb: number | null): void {
  imageMemoryMb = mb;
}

export function terminalPasteGuardOf(values: ConfigValues | null): boolean | null {
  const on = values?.terminal?.paste_guard;
  return typeof on === "boolean" ? on : null;
}

/**
 * The latest paste-guard answer the configuration has published, or null
 * when none has arrived.
 *
 * Module-held like the image limit, but read at paste time rather than at
 * construction: a paste is an instant, and the switch owes every pane —
 * open ones included — the moment the file answers it.
 */
let pasteGuardOn: boolean | null = null;

/** The at-paste-time read (see the module-level holder above). */
export function terminalPasteGuard(): boolean | null {
  return pasteGuardOn;
}

/** Test seam: the paste guard's twin of [`setTerminalImageMemoryForTest`]. */
export function setTerminalPasteGuardForTest(on: boolean | null): void {
  pasteGuardOn = on;
}

export function terminalCompletionsUrlOf(
  values: ConfigValues | null
): string | null {
  const url = values?.terminal?.completions_url;
  return typeof url === "string" ? url : null;
}

export function profileLigaturesOf(
  values: ConfigValues | null
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const profile of profiles(values)) {
    if (typeof profile.ligatures === "boolean") {
      out[profile.name] = profile.ligatures;
    }
  }
  return out;
}

export function profileFontsOf(values: ConfigValues | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const profile of profiles(values)) {
    if (typeof profile.font === "string" && profile.font.trim() !== "") {
      out[profile.name] = profile.font;
    }
  }
  return out;
}

/**
 * Hand the font to `term/font.ts`, which every living terminal listens to.
 *
 * The same direction, and the same two call sites, as
 * [`publishKeyOverrides`]: once at module evaluation for the copy the core
 * injected before the first paint, and again on every [`configGet`]. A read
 * that does not carry the three values leaves the terminals as they are —
 * they are already drawing what the last good read said, and blanking that
 * would be this module deciding a terminal should have no font.
 */
function publishTerminalFont(values: ConfigValues | null): void {
  const font = terminalFontOf(values);
  if (font !== null) setTerminalFont(font);
  setProfileFontFamilies(profileFontsOf(values));
  const on = terminalLigaturesOf(values);
  if (on !== null) setTerminalLigatures(on);
  setProfileLigatures(profileLigaturesOf(values));
  // The image storage limit rides the same two call sites (module eval and
  // every configGet): unlike the font it is not pushed to living terminals —
  // nothing about an open pane changes — it is simply the latest answer for
  // the next terminal to be constructed with.
  imageMemoryMb = terminalImageMemoryOf(values);
  // The paste guard rides along for the same ride: the latest answer, read
  // at paste time by whichever pane catches one.
  pasteGuardOn = terminalPasteGuardOf(values);
}

publishTerminalFont(bootConfig());

/**
 * The prefix a `[keys]` entry is addressed by outside this module — the demo
 * carrier below, and the failed-save banner, which shows a key that could not
 * be written by the name the file gives it.
 *
 * `keys.duplicate-tab` is not a registry key and `config_set` refuses it, on
 * purpose (see [`Keys`] in config.rs): the leaves of that section are command
 * ids, which the registry knows nothing about. It is spelled the same way for
 * the same reason the six are — so that it can be said in one place.
 */
export const KEYS_PREFIX = "keys.";

/** `keys.duplicate-tab` for `duplicate-tab`. */
export function keyConfigKey(command: string): string {
  return `${KEYS_PREFIX}${command}`;
}

export async function setKeyBinding(
  command: string,
  keys: string | null
): Promise<void> {
  await writeOverlay({ ...keyOverlay(), [command]: keys ?? "" }, (invoke) =>
    invoke<void>("config_key_set", { command, keys: keys ?? "" })
  );
}

/**
 * Take one command's override out, so the key the app ships with governs it
 * again.
 *
 * NOT expressible as [`setKeyBinding`] with today's shipped key: an override
 * that happens to equal the shipped key is a different fact from having no
 * opinion, and the difference shows on the day the shipped key moves. This is
 * the same distinction `config_reset` draws for a setting — delete the line,
 * never write the built-in value down.
 */
export async function clearKeyBinding(command: string): Promise<void> {
  const next = { ...keyOverlay() };
  delete next[command];
  await writeOverlay(next, (invoke) =>
    invoke<void>("config_key_reset", { command })
  );
}

/** Drop every override at once — the keyboard's half of a factory reset. */
export async function clearKeyOverrides(): Promise<void> {
  await writeOverlay({}, (invoke) => invoke<void>("config_keys_clear"));
}

/**
 * The one path all three take: publish, write, and put the old overlay back
 * if the write does not go through.
 *
 * The core is told separately from the page, and after the file rather than
 * before it: its menu is built in another language and cannot read this
 * one's memory, and a menu showing a key the file refused to keep would
 * outlive the refusal — the menu is rebuilt from the file at every launch.
 */
async function writeOverlay(
  next: Record<string, string>,
  write: (invoke: Invoke) => Promise<void>
): Promise<void> {
  const previous = keyOverlay();
  setKeyOverrides(next);
  try {
    if (!isTauri()) {
      demoWriteOverlay(next);
      return;
    }
    const invoke = await invoker();
    await write(invoke);
    await applyKeysToCore(next);
  } catch (e) {
    setKeyOverrides(previous);
    throw e;
  }
}

/**
 * The demo's overlay, kept beside its settings edits in the same carrier.
 *
 * Written whole rather than key by key, because that is what the overlay is:
 * the demo has no file to hold the lines this program did not write, so
 * "every override there is" is the only honest thing for it to store.
 */
function demoWriteOverlay(next: Record<string, string>): void {
  if (demoWriteFails()) throw STR.settings.config.demoWriteRefused;
  const edits = demoEdits();
  for (const key of Object.keys(edits)) {
    if (key.startsWith(KEYS_PREFIX)) delete edits[key];
  }
  for (const [command, keys] of Object.entries(next)) {
    edits[keyConfigKey(command)] = keys;
  }
  writeDemoEdits(edits);
}

// ---------------------------------------------------------- the profiles

/**
 * How the profile list is addressed outside this module — in the demo's own
 * edit store, and in a failed-save report, which names what could not be
 * written by the name the file gives it.
 *
 * Not a registry key: `config_set` refuses it, exactly as it refuses
 * `keys.<command>`, because `SETTINGS` describes settings of the form key →
 * one value and this is a list of entities (src-tauri/src/profiles.rs says
 * why at length). The two calls below are its `config_set` and
 * `config_reset`.
 */
export const PROFILES_KEY = "terminal.profiles";

/**
 * The profiles a configuration holds, or none.
 *
 * Empty is the honest answer for every "nothing there" case — no file, no
 * `[terminal]` section, no entries — because unlike the six settings there is
 * no default being withheld: a user who has declared no profiles has declared
 * none, and that is a complete fact rather than a value not read yet.
 */
export function profiles(values: ConfigValues | null): ConfigProfile[] {
  const list = values?.terminal?.profiles;
  return Array.isArray(list) ? list : [];
}

/**
 * Add or edit one profile: `target` is the entry to write over, and
 * `profile.name` is what it is called afterwards.
 *
 * Passing the same string for both edits in place; passing a different one
 * renames without moving the entry or losing the comments around it; passing
 * a name no entry has creates one. The file is the authority and this returns
 * nothing — the caller reads the result back with [`configGet`], as it does
 * after `configSet`.
 */
export async function profileSet(
  target: string,
  profile: ConfigProfile
): Promise<void> {
  if (!isTauri()) {
    await demoWriteProfiles(upsertProfile(demoProfiles(), target, profile));
    return;
  }
  const invoke = await invoker();
  await invoke<void>("config_profile_set", { target, profile });
}

/** Delete one profile. A name no entry has is not an error: it is already
 * the state this asks for. */
export async function profileRemove(name: string): Promise<void> {
  if (!isTauri()) {
    await demoWriteProfiles(demoProfiles().filter((p) => p.name !== name));
    return;
  }
  const invoke = await invoker();
  await invoke<void>("config_profile_remove", { name });
}

// ------------------------------------------------------------ the templates

/**
 * How the template list is addressed outside this module — the demo's edit
 * store and a failed-save report, on the same terms as [`PROFILES_KEY`].
 */
export const TEMPLATES_KEY = "terminal.templates";

/**
 * The layouts a configuration holds, or none. Empty is a complete fact, not
 * a value-not-read-yet, exactly as the profile list is.
 */
export function templates(values: ConfigValues | null): ConfigTemplate[] {
  const list = values?.terminal?.templates;
  return Array.isArray(list) ? list : [];
}

/**
 * Add or edit one layout: `target` is the entry to write over, and
 * `template.name` is what it is called afterwards — same three cases as
 * [`profileSet`], for the same reasons (a rename is a point edit, an unknown
 * target appends, the file is the authority).
 */
export async function templateSet(
  target: string,
  template: ConfigTemplate
): Promise<void> {
  if (!isTauri()) {
    await demoWriteTemplates(upsertTemplate(demoTemplates(), target, template));
    return;
  }
  const invoke = await invoker();
  await invoke<void>("config_template_set", { target, template });
}

/** Delete one layout. A name no entry has is already the asked-for state. */
export async function templateRemove(name: string): Promise<void> {
  if (!isTauri()) {
    await demoWriteTemplates(demoTemplates().filter((t) => t.name !== name));
    return;
  }
  const invoke = await invoker();
  await invoke<void>("config_template_remove", { name });
}

/**
 * `list` with `template` written over the entry called `target` — the demo's
 * path only, kept to the two rules a list can break on its own (a name has
 * to be something; no two entries share one), on the same terms as
 * [`upsertProfile`]. The tree's own rules belong to the core.
 */
export function upsertTemplate(
  list: readonly ConfigTemplate[],
  target: string,
  template: ConfigTemplate
): ConfigTemplate[] {
  if (template.name.trim() === "") throw "a terminal template's name must not be blank";
  const at = list.findIndex((t) => t.name === target);
  const clash = list.some((t, i) => i !== at && t.name === template.name);
  if (clash) {
    throw `two terminal templates are named \`${template.name}\` — template names have to be unique`;
  }
  if (at === -1) return [...list, template];
  return list.map((t, i) => (i === at ? template : t));
}

/**
 * `list` with `profile` written over the entry called `target`.
 *
 * THE DEMO'S PATH ONLY — the desktop's upsert is done by the core, over the
 * document itself, and is checked by re-parsing the whole file through the
 * loader afterwards. This exists because the browser demo has no core to ask
 * and no file to re-parse, and it is kept to the two rules that a list can
 * break on its own: a name has to be something, and no two entries may share
 * one. Anything richer would be a second copy of the file format's rules,
 * which is what the registry exists to abolish.
 */
export function upsertProfile(
  list: readonly ConfigProfile[],
  target: string,
  profile: ConfigProfile
): ConfigProfile[] {
  if (profile.name.trim() === "") throw "a profile's name must not be blank";
  const at = list.findIndex((p) => p.name === target);
  const clash = list.some((p, i) => i !== at && p.name === profile.name);
  if (clash) {
    throw `two terminal profiles are named \`${profile.name}\` — profile names have to be unique`;
  }
  if (at === -1) return [...list, profile];
  return list.map((p, i) => (i === at ? profile : p));
}

// -------------------------------------------------------- the demo backend

const DEMO_EDITS_KEY = "tabverse.demo.config";

/**
 * What the demo answers `sources` with once it has an edit store, and why it
 * is not the empty list forever.
 *
 * `sources` is not decoration: the store reads "no source at all" as "this
 * user has no configuration file yet", and that is the trigger for moving
 * the five session-held settings and the theme into it — a migration meant
 * to happen exactly once, whose done-marker on the desktop is the file it
 * has just created. A demo that reported no source forever would re-run it
 * on every read, and the visible damage is precise: resetting the theme
 * would appear to do nothing, because the migration puts the old stored
 * preference straight back. Naming the carrier is what makes it once here
 * too.
 *
 * Not a path, and deliberately shaped so it cannot be mistaken for one — it
 * gates an "open the file" button that no demo banner shows and that
 * `revealConfigFile` declines to act on anyway.
 */
const DEMO_EDITS_SOURCE = `localStorage:${DEMO_EDITS_KEY}`;

/** The demo's own carrier, listed once it exists — see above for why. */
function demoSources(): string[] {
  try {
    return localStorage.getItem(DEMO_EDITS_KEY) === null
      ? []
      : [DEMO_EDITS_SOURCE];
  } catch {
    return [];
  }
}

/**
 * Whether the demo is currently set to refuse writes — read per write, so
 * turning it over between two of them is what the two of them show.
 *
 * Strictly `true`: any other value, including the string "true" a console
 * typo produces, leaves writes working. A switch that could be turned on by
 * accident would make the banner arrive without an explanation for it.
 */
function demoWriteFails(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    window[DEMO_WRITE_FAILS_KEY] === true
  );
}

/** The registry rows the dev server injected, or null in every other case. */
function demoSchema(): Setting[] | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const raw = window[DEMO_SCHEMA_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw as Setting[];
}

/** The keys the user has moved, dotted as `config_set` names them. */
function demoEdits(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(DEMO_EDITS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    // A demo whose scratch storage is unreadable is a demo showing the
    // registry's values, which is a defensible thing to show.
    return {};
  }
}

function writeDemoEdits(next: Record<string, unknown>): void {
  try {
    localStorage.setItem(DEMO_EDITS_KEY, JSON.stringify(next));
  } catch (e) {
    coreLog("error", `demo config write failed: ${String(e)}`);
  }
}

/**
 * The profiles the demo currently holds: the injected registry's, with the
 * demo's own edits laid over them — the same two-layer read [`configGet`]
 * does, so what a write starts from is what the page is showing.
 */
function demoProfiles(): ConfigProfile[] {
  const stored = demoEdits()[PROFILES_KEY];
  if (Array.isArray(stored)) return stored as ConfigProfile[];
  return profiles(bootConfig());
}

/**
 * Store the whole list, and refuse when the demo is set to refuse.
 *
 * Whole rather than entry by entry, for the reason the key overlay is written
 * whole: the demo has no file holding the lines this program did not write,
 * so "every profile there is" is the only honest thing for it to keep.
 */
function demoWriteProfiles(next: ConfigProfile[]): Promise<void> {
  if (demoWriteFails()) return Promise.reject(STR.settings.config.demoWriteRefused);
  writeDemoEdits({ ...demoEdits(), [PROFILES_KEY]: next });
  return Promise.resolve();
}

/** The templates the demo currently holds — the same two-layer read as
 * the profile list. */
function demoTemplates(): ConfigTemplate[] {
  const stored = demoEdits()[TEMPLATES_KEY];
  if (Array.isArray(stored)) return stored as ConfigTemplate[];
  return templates(bootConfig());
}

function demoWriteTemplates(next: ConfigTemplate[]): Promise<void> {
  if (demoWriteFails()) return Promise.reject(STR.settings.config.demoWriteRefused);
  writeDemoEdits({ ...demoEdits(), [TEMPLATES_KEY]: next });
  return Promise.resolve();
}

/**
 * Why the demo refuses to write this, or null when it does not refuse.
 *
 * The desktop rejects an unknown key and an out-of-domain value without
 * touching the file, and a demo that accepted either would be demonstrating
 * a tolerance the product does not have. Every rule applied here is read out
 * of the registry row itself — the key's existence, a choice's own options,
 * a number's own bounds — so none of them can come to disagree with the
 * core's: they are the same facts, arriving by the same export.
 *
 * THE DIVERGENCE THIS USED TO CARRY, and how it was closed.
 * `browser.custom_search_template` obeyed one rule the registry did not
 * describe — the core wanted it empty or an http(s) address containing `%s`,
 * and `Kind::Text` said none of that — so the demo accepted a template the
 * desktop would refuse. Restating the rule here was refused at the time for
 * a good reason: the rule already had two homes (the core's deserializer and
 * `validSearchTemplate` in src/search.ts) and they had drifted over whether
 * `HTTPS://` is a scheme, which is an argument against a third copy rather
 * than for one.
 *
 * The rule now lives in the registry row itself, as `Kind::Text`'s
 * [`TextRule`], and arrives here on the schema like a choice's options do.
 * So this enforces it without restating it, and the divergence is gone
 * rather than documented.
 */
function demoRejection(
  schema: readonly Setting[],
  key: string,
  value: unknown
): string | null {
  const row = schema.find((s) => s.key === key);
  if (row === undefined) return `${key} is not a setting`;
  const kind = row.kind;
  if (kind === "toggle") {
    return typeof value === "boolean" ? null : `${key} is on or off`;
  }
  if ("text" in kind) {
    if (typeof value !== "string") return `${key} is text`;
    const clause = textRefusal(kind.text, value);
    return clause === null ? null : `${key} ${clause}`;
  }
  if ("choice" in kind) {
    const { options } = kind.choice;
    return options.includes(value as string)
      ? null
      : `${key} is one of ${options.join(", ")}`;
  }
  const { min, max } = kind.number;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return `${key} is a whole number`;
  }
  return value >= min && value <= max
    ? null
    : `${key} is between ${min} and ${max}`;
}

/**
 * The registry's values with the demo's edits laid over them.
 *
 * Only keys the schema names are laid over: a key left in storage by a
 * setting that has since been renamed or dropped would otherwise go on
 * being applied to a file shape that no longer has a place for it. The
 * registry decides what a key is, here as everywhere else.
 */
function withDemoEdits(
  values: ConfigValues,
  edits: Record<string, unknown>,
  schema: readonly Setting[]
): ConfigValues {
  const known = new Set(schema.map((s) => s.key));
  const out = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(edits)) {
    // The overlay is the one part of the file the registry does not
    // describe, so it is laid over by its own rule rather than by the
    // schema's — the same split `[keys]` has on the desktop, where the
    // shortcut table judges those leaves and `SETTINGS` cannot.
    if (key.startsWith(KEYS_PREFIX)) {
      if (typeof value !== "string") continue;
      const keys = (out.keys ?? {}) as Record<string, unknown>;
      keys[key.slice(KEYS_PREFIX.length)] = value;
      out.keys = keys;
      continue;
    }
    // The profile list is the other part of the file the registry does not
    // describe, and it is laid over whole for the same reason it is stored
    // whole: it is a list, not a value at a key.
    if (key === PROFILES_KEY) {
      if (!Array.isArray(value)) continue;
      out.terminal = { ...(out.terminal as ConfigTerminal | undefined), profiles: value };
      continue;
    }
    if (key === TEMPLATES_KEY) {
      if (!Array.isArray(value)) continue;
      out.terminal = { ...(out.terminal as ConfigTerminal | undefined), templates: value };
      continue;
    }
    if (!known.has(key)) continue;
    const dot = key.indexOf(".");
    if (dot <= 0) continue;
    const table = out[key.slice(0, dot)];
    if (typeof table !== "object" || table === null) continue;
    (table as Record<string, unknown>)[key.slice(dot + 1)] = value;
  }
  return out as unknown as ConfigValues;
}

// ------------------------------------------------------------- the calls

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Thrown instead of calling out when there is neither a desktop core to
 * answer nor an injected registry to answer from — a unit test that set up
 * neither, or a page served by something that is not this project's dev
 * server. It is a normal state rather than a failure to report on screen.
 *
 * The browser demo no longer reaches it: the dev server injects the registry
 * (see the demo backend above), so the four calls below have something to
 * work with there.
 */
export const NO_CONFIG_BACKEND = "no configuration backend";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * The import, kept as a promise rather than repeated per call.
 *
 * Caching the promise, not the module, is what makes it one import: several
 * settings can be written in the same tick — a migration moves six at once —
 * and each would otherwise start its own dynamic import of the same module.
 * Resolved once, every caller gets the same function.
 */
let invokePromise: Promise<Invoke> | null = null;

function invoker(): Promise<Invoke> {
  invokePromise ??= import("@tauri-apps/api/core").then(
    ({ invoke }) => invoke as Invoke
  );
  return invokePromise;
}

/**
 * The current configuration, or a rejection carrying the located error.
 *
 * In the demo there is no file, so there is nothing a load could have gone
 * wrong about and the warnings are empty — a demo cannot have mistyped a key
 * in a file it does not have. `sources` names the demo's own carrier once
 * that carrier exists, and is empty before then; [`DEMO_EDITS_SOURCE`] says
 * why that distinction is load-bearing rather than cosmetic.
 */
export async function configGet(): Promise<ConfigSnapshot> {
  if (!isTauri()) {
    const values = bootConfig();
    const schema = demoSchema();
    if (values === null || schema === null) throw NO_CONFIG_BACKEND;
    const merged = withDemoEdits(values, demoEdits(), schema);
    publishKeyOverrides(merged);
    publishTerminalFont(merged);
    return {
      values: merged,
      warnings: [],
      sources: demoSources(),
    };
  }
  const invoke = await invoker();
  const snap = await invoke<ConfigSnapshot>("config_get");
  // A re-read of the file is the moment the key overlay can have changed —
  // the user edited `[keys]` by hand and asked for a reload. Published here
  // so the handler, the ⌘/ overlay and the settings page all move together;
  // the core is told separately, because its menu is built in another
  // language and cannot read this one's memory.
  publishKeyOverrides(snap.values);
  // The other thing a re-read can have changed: the file's font block, or a
  // profile's `font`. Same door, same reason.
  publishTerminalFont(snap.values);
  void applyKeysToCore(keyOverrides(snap.values));
  return snap;
}

/**
 * Tell the core which keys are in force, so the native menu and the script
 * injected into pages follow the same composition this side reads.
 *
 * Fire-and-forget and failure-tolerant: the core composed the same overlay
 * out of the same file at startup, so a refused call costs an update, never
 * correctness. Nothing at all happens off the desktop, where there is no
 * menu and no injected script.
 */
async function applyKeysToCore(overrides: Record<string, string>): Promise<void> {
  if (!isTauri()) return;
  try {
    const invoke = await invoker();
    await invoke<void>("keys_apply", { overrides });
  } catch (e) {
    coreLog("error", `keys_apply failed: ${String(e)}`);
  }
}

/**
 * The rows the last successful [`configSchema`] answered with, so that code
 * with no component and no store slice of its own can still reach the
 * registry.
 *
 * One reader: the search path (src/search.ts), which decides whether the
 * user's custom template can be used at all and needs `Kind::Text`'s rule to
 * decide it. `searchUrl()` is called from a keypress handler and a command
 * row, neither of which has a schema to hand — and the alternative, letting
 * that module keep its own copy of the rule, is precisely what putting the
 * rule in the registry removed.
 *
 * A memo of what the backend said, never a substitute for asking: it is null
 * until a call has come back, and a null answer means "not read yet" for the
 * same reason the six values do.
 */
let lastSchema: readonly Setting[] | null = null;

/**
 * The text rule for `key` as of the last schema that arrived, or null when
 * none has arrived yet.
 */
export function knownTextRule(key: string): TextRule | null {
  return lastSchema === null ? null : textRule(lastSchema, key);
}

/** The registry rows: what to draw, where it belongs, which copy to use. */
export async function configSchema(): Promise<Setting[]> {
  if (!isTauri()) {
    const schema = demoSchema();
    if (schema === null) throw NO_CONFIG_BACKEND;
    lastSchema = schema;
    return schema;
  }
  const invoke = await invoker();
  const rows = await invoke<Setting[]>("config_schema");
  lastSchema = rows;
  return rows;
}

/** Write one key. Rejects when the file cannot be edited. */
export async function configSet(key: string, value: unknown): Promise<void> {
  if (!isTauri()) {
    const schema = demoSchema();
    if (schema === null) throw NO_CONFIG_BACKEND;
    const refusal = demoRejection(schema, key, value);
    // Refused before anything is stored, as the core refuses before the file
    // is opened: a rejected write leaves no trace of itself.
    if (refusal !== null) throw refusal;
    // And the carrier's own refusal, which stands where "permission denied
    // writing this file" stands on the desktop: judged last, because a value
    // the registry would not take is refused whether or not the file could
    // have held it.
    if (demoWriteFails()) throw STR.settings.config.demoWriteRefused;
    writeDemoEdits({ ...demoEdits(), [key]: value });
    return;
  }
  const invoke = await invoker();
  await invoke<void>("config_set", { key, value });
}

export async function configReset(key: string): Promise<void> {
  if (!isTauri()) {
    const schema = demoSchema();
    if (schema === null) throw NO_CONFIG_BACKEND;
    if (!schema.some((s) => s.key === key)) throw `${key} is not a setting`;
    // A reset is a write too — it takes the line out of the file — so a
    // carrier that will not be written refuses this as well. Anything else
    // would show a demo in which settings cannot be saved but can be
    // un-saved.
    if (demoWriteFails()) throw STR.settings.config.demoWriteRefused;
    const edits = demoEdits();
    delete edits[key];
    writeDemoEdits(edits);
    return;
  }
  const invoke = await invoker();
  await invoke<void>("config_reset", { key });
}

// -------------------------------------------------------- write batching

const WRITE_DEBOUNCE_MS = 300;

export type WriteOutcome =
  | { ok: true; key: string; value: unknown }
  | { ok: false; key: string; value: unknown; error: unknown };

const pending = new Map<string, unknown>();
/**
 * Who hears how each key's queued write went.
 *
 * The FIRST reporter registered for a key while its write is still queued is
 * the one kept, and the later ones are dropped: a reporter closes over what
 * the setting was before the change that queued it, and across A→B→C inside
 * one window the value to put the interface back to is A. Keeping the last
 * one would roll a failed drag back to the middle of itself.
 */
const reporters = new Map<string, (o: WriteOutcome) => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<Promise<void>>();

function writeNow(key: string): Promise<void> {
  const timer = timers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(key);
  }
  if (!pending.has(key)) return Promise.resolve();
  const value = pending.get(key);
  pending.delete(key);
  // Taken out of the map at the moment the call goes out, not when it comes
  // back: a change made while this one is in flight is a new un-written
  // change, and it registers a reporter of its own rather than inheriting
  // this one's idea of "before".
  const done = reporters.get(key);
  reporters.delete(key);
  const p = configSet(key, value)
    .then(
      () => done?.({ ok: true, key, value }),
      (e: unknown) => {
        // Logged and never thrown at the caller: a settings change that
        // cannot reach the file must not take the interface down with it.
        coreLog("error", `config_set(${key}) failed: ${String(e)}`);
        // The browser demo has no configuration file and never had one, so
        // its refusal is nothing to roll back over and nothing to put in
        // front of anybody — the same reading initConfig gives it.
        if (e !== NO_CONFIG_BACKEND) {
          done?.({ ok: false, key, value, error: e });
        }
      }
    )
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);
  return p;
}

/**
 * Queue one key's new value, debounced and fire-and-forget.
 *
 * `onDone` is how the caller learns what became of it. Optional because not
 * every write has an interface to put back — but a caller that shows the
 * value on screen owes one, or a failed save leaves the screen claiming a
 * setting the file never took.
 */
export function configSetSoon(
  key: string,
  value: unknown,
  onDone?: (o: WriteOutcome) => void
): void {
  pending.set(key, value);
  if (onDone !== undefined && !reporters.has(key)) reporters.set(key, onDone);
  const timer = timers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  timers.set(
    key,
    setTimeout(() => void writeNow(key), WRITE_DEBOUNCE_MS)
  );
}

/**
 * Write every queued value now and wait for the calls already out. Called
 * on the way out, beside the state doorway's own flush, so the last change
 * before a quit is not the one that is lost.
 */
export function flushConfigWrites(): Promise<void> {
  const writes = [...pending.keys()].map((key) => writeNow(key));
  return Promise.all([...writes, ...inFlight]).then(() => undefined);
}

// --------------------------------------------------------- error reading

/**
 * The file a load error is about, read back out of its own text.
 *
 * `config_get` rejects with the error's rendering — `path:line:column:
 * message` and the source line beneath it — and that path is what the
 * banner's "open the file" action needs. Taking it from the text is the
 * only route the command contract offers: the values, warnings and sources
 * of a *failed* load are exactly what does not come back.
 *
 * The greedy first group is what makes a Windows path work: `C:\…\config.
 * toml:3:13: …` splits at the last `:line:column: `, not at the drive
 * letter's colon.
 */
export function configErrorPath(text: string): string | null {
  const first = text.split("\n", 1)[0] ?? "";
  const located = /^(.+):(\d+):(\d+): /.exec(first);
  if (located) return located[1];
  // The unlocated form — an unreadable file — is `path: message`. Searching
  // from index 2 steps over a drive letter's own colon.
  const at = first.indexOf(": ", 2);
  if (at === -1) return null;
  const path = first.slice(0, at);
  return path.length > 0 ? path : null;
}

/**
 * Show the configuration file in the system's file manager.
 *
 * `fs_reveal` rather than a handler of its own: it is the existing command
 * for "take me to this file", and it neither reads nor executes what it
 * points at.
 */
export async function revealConfigFile(path: string): Promise<void> {
  if (!isTauri()) return;
  const invoke = await invoker();
  await invoke<void>("fs_reveal", { path });
}
