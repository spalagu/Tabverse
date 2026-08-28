/**
 * What the touch toolbar sends, kept out of the component so "Ctrl+C is two
 * taps" is a thing with a test rather than a thing spread across button
 * handlers.
 */

export type ToolbarKey = "esc" | "tab" | "up" | "down" | "left" | "right";

/** The bytes each toolbar key puts on the wire — the same encodings a
 * hardware keyboard produces through xterm. */
export const TOOLBAR_BYTES: Record<ToolbarKey, string> = {
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

/**
 * The sticky Ctrl modifier: armed by a toolbar tap, consumed by the next
 * key. A printable character becomes its control code (`ch & 0x1f`, so a
 * tapped Ctrl followed by a typed `c` sends 0x03 — the interrupt); anything
 * else — an escape sequence, a paste, an IME commit — passes through
 * unchanged rather than being mangled, but still disarms the modifier so
 * its state is never a surprise.
 */
export function applyStickyCtrl(
  data: string,
  armed: boolean
): { bytes: string; consumed: boolean } {
  if (!armed) return { bytes: data, consumed: false };
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      // Ctrl+? is DEL by long terminal convention; everything else masks.
      const ctrl = code === 0x3f ? 0x7f : code & 0x1f;
      return { bytes: String.fromCharCode(ctrl), consumed: true };
    }
  }
  return { bytes: data, consumed: true };
}
