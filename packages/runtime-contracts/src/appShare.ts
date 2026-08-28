/** Host actions that may cross an app-share session. This list is the wire
 * contract shared by the desktop executor, broadcaster and remote mirror. */
export const APP_MIRROR_ACTION_NAMES = [
  "addTab",
  "closeTab",
  "toggleSidebar",
  "setSidebarPeeking",
  "activateTab",
  "closeMenu",
  "openMenu",
  "splitWith",
  "setFilesOpenPath",
  "unsplit",
  "renameTab",
  "toggleGroupCollapsed",
  "setFilesOpenDir",
] as const;

export type AppMirrorActionName = (typeof APP_MIRROR_ACTION_NAMES)[number];

const APP_MIRROR_ACTION_SET: ReadonlySet<string> = new Set(APP_MIRROR_ACTION_NAMES);

export function isAppMirrorActionName(value: string): value is AppMirrorActionName {
  return APP_MIRROR_ACTION_SET.has(value);
}
