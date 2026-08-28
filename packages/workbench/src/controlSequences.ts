/** Strip OSC, CSI and two-byte ESC sequences in one bounded linear scan. */
export function stripTerminalEscapeSequences(screen: string): string {
  let visible = "";
  let index = 0;
  while (index < screen.length) {
    if (screen.charCodeAt(index) !== 0x1b) {
      visible += screen[index];
      index += 1;
      continue;
    }

    const next = screen.charCodeAt(index + 1);
    if (next === 0x5d) {
      index += 2;
      while (index < screen.length) {
        if (screen.charCodeAt(index) === 0x07) {
          index += 1;
          break;
        }
        if (
          screen.charCodeAt(index) === 0x1b &&
          screen.charCodeAt(index + 1) === 0x5c
        ) {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (next === 0x5b) {
      index += 2;
      while (index < screen.length) {
        const code = screen.charCodeAt(index);
        index += 1;
        if (code >= 0x40 && code <= 0x7e) break;
        if (code < 0x20 || code > 0x3f) break;
      }
      continue;
    }

    if (next >= 0x40 && next <= 0x5f) {
      index += 2;
      continue;
    }

    index += 1;
  }
  return visible;
}
