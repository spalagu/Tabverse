import type * as React from "react";
import { TOOLBAR_BYTES, type ToolbarKey } from "./toolbarKeys";

/**
 * The touch key toolbar: the keys a soft keyboard does not have.
 *
 * Every button prevents pointer-down default so a tap never steals focus
 * from xterm's hidden textarea — stealing it would drop the soft keyboard
 * mid-word, which reads as the page fighting the user.
 */
export function Toolbar({
  ctrlArmed,
  onKey,
  onCtrlToggle,
  onSummonKeyboard,
  onCopy,
}: {
  ctrlArmed: boolean;
  onKey: (key: ToolbarKey) => void;
  onCtrlToggle: () => void;
  onSummonKeyboard: () => void;
  onCopy: () => void;
}) {
  const keepTermFocus = (e: React.PointerEvent) => e.preventDefault();
  const key = (k: ToolbarKey, label: string, hint: string) => (
    <button
      className="key-btn"
      type="button"
      title={hint}
      onPointerDown={keepTermFocus}
      onClick={() => onKey(k)}
    >
      {label}
    </button>
  );
  return (
    <div className="key-toolbar" role="toolbar" aria-label="Terminal keys">
      <button
        className="key-btn key-btn-kbd"
        type="button"
        title="Show the keyboard"
        // No preventDefault here: this tap is the user gesture that lets the
        // focus call below open the soft keyboard at all.
        onClick={onSummonKeyboard}
      >
        ⌨
      </button>
      <button
        className="key-btn"
        type="button"
        title="Copy the selection"
        onPointerDown={keepTermFocus}
        onClick={onCopy}
      >
        copy
      </button>
      {key("esc", "esc", "Escape")}
      {key("tab", "tab", "Tab")}
      <button
        className="key-btn key-btn-ctrl"
        type="button"
        title="Sticky Ctrl — tap, then type a letter (Ctrl+C is two taps)"
        aria-pressed={ctrlArmed}
        onPointerDown={keepTermFocus}
        onClick={onCtrlToggle}
      >
        ctrl
      </button>
      {key("left", "←", "Arrow left")}
      {key("down", "↓", "Arrow down")}
      {key("up", "↑", "Arrow up")}
      {key("right", "→", "Arrow right")}
    </div>
  );
}

export { TOOLBAR_BYTES };
export type { ToolbarKey };
