import { STR } from "../strings";
import { CONFIG_KEYS, type ConfigSlice, type Setting } from "./config";


/**
 * The settings the interface holds, keyed by the dotted path that names them
 * in the file.
 *
 * This is `configSlice` seen from the other side, and it carries the same
 * thing that one does: field names, never values. The store is the live copy
 * — flipping a control has to make the row appear at once, and a value re-read
 * from the file would lag a debounced write by 300ms.
 */
export function settingValues(slice: ConfigSlice): Record<string, unknown> {
  // Typed by the key table rather than by `string`, so a setting added to
  // CONFIG_KEYS and forgotten here fails to compile instead of silently
  // becoming a row nobody can judge.
  const byKey: Record<(typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS], unknown> =
    {
      [CONFIG_KEYS.theme]: slice.themePreference,
      [CONFIG_KEYS.sidebarWidth]: slice.sidebarWidth,
      [CONFIG_KEYS.sidebarPinned]: slice.sidebarPinned,
      [CONFIG_KEYS.searchEngine]: slice.searchEngine,
      [CONFIG_KEYS.customSearchTemplate]: slice.customSearchTemplate,
      [CONFIG_KEYS.archiveAfter]: slice.archiveThreshold,
    };
  return byKey;
}

/**
 * Equality as the configuration file means it: two JSON values are the same
 * value.
 *
 * `===` would do for the six settings of this milestone, all of them scalars,
 * and would quietly report every future list-valued or table-valued setting
 * as changed the moment the page opened. Written structurally now rather than
 * discovered then.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => sameValue(item, b[i]));
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (k) => Object.hasOwn(right, k) && sameValue(left[k], right[k])
  );
}

/**
 * Has the user moved this setting off its default?
 *
 * `false` covers two quite different states on purpose — "no" and "there is
 * no way to tell" — because both mean the same thing to the view: do not
 * claim this row was changed, and do not offer to reset it. `decidable`
 * below is what tells the two apart for anyone who needs to.
 */
export function isModified(
  setting: Setting,
  values: Record<string, unknown>
): boolean {
  if (!decidable(setting, values)) return false;
  return !sameValue(values[setting.key], setting.default);
}

/**
 * Can this setting be judged at all: the core sent its default, and the
 * interface has read its current value.
 */
export function decidable(
  setting: Setting,
  values: Record<string, unknown>
): boolean {
  if (setting.default === undefined) return false;
  if (!Object.hasOwn(values, setting.key)) return false;
  return values[setting.key] !== null;
}

/**
 * Every setting standing away from its default, in registry order — which is
 * the order the settings page draws its sections in, so the list reads down
 * the page rather than in whatever order the comparisons finished.
 */
export function modifiedSettings(
  schema: readonly Setting[],
  slice: ConfigSlice
): Setting[] {
  const values = settingValues(slice);
  return schema.filter((setting) => isModified(setting, values));
}

/**
 * A setting's short title, read out of `STR` at the path the registry gave.
 *
 * The registry names the copy (`str_key`) rather than carrying it, so the
 * words stay in the one string table and stay translatable. A path that leads
 * nowhere answers null rather than a stand-in: the caller shows the dotted
 * key, which is at least true, instead of an empty row.
 */
export function settingTitle(setting: Setting): string | null {
  let cursor: unknown = STR;
  for (const part of setting.str_key.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "string" ? cursor : null;
}
