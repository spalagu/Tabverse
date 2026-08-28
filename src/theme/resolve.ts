import {
  isThemeName,
  resolveThemeName,
  type ThemeName,
  type ThemePreference,
} from "./tokens";

const SYSTEM_THEME: Record<"dark" | "light", ThemeName> = {
  dark: "dark",
  light: "light",
};

export const resolve = (p: ThemePreference, systemDark: boolean): ThemeName =>
  p === "system"
    ? SYSTEM_THEME[systemDark ? "dark" : "light"]
    : resolveThemeName(p);

/** A stored preference, or anything else — "system" or any theme
 *  tokens.json declares is taken at its word, and everything else falls back
 *  to "system", the same rule the Rust reader applies to theme.json. Adding
 *  a theme widens what this accepts without this file being touched. */
export function asThemePreference(v: unknown): ThemePreference {
  if (v === "system") return "system";
  return isThemeName(v) ? v : "system";
}
