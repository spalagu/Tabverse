import type { Terminal } from "@xterm/xterm";

/**
 * Fit a mirrored terminal into its container by shrinking the *font*, never by
 * changing the column count and never with a CSS transform.
 *
 * Two constraints shape this:
 *
 *   - The host owns the grid. It writes output for the columns it has, so
 *     resizing the viewer re-wraps everything into noise.
 *   - xterm converts pointer positions to cells by dividing the offset within
 *     its bounding rect by the cell size it computed from the font. A CSS
 *     transform shrinks the rect but not the cell size, so every click and
 *     drag-selection lands in the wrong column — and worse the further right
 *     you go. Scaling the font keeps the two in step.
 *
 * Returns the scale that was applied, relative to `baseFontSize`.
 */
export function scaleTerminalToFit(
  term: Terminal | null,
  container: HTMLElement | null,
  baseFontSize: number
): number {
  const el = term?.element;
  if (!term || !el || !container) return 1;

  // A hidden window (background tab, minimised app, collapsed pane) measures
  // zero or a few pixels. Fitting to that would leave the terminal unreadably
  // small with nothing scheduled to undo it. No real viewport is this small.
  const MIN_USABLE_PX = 120;
  const availW = container.clientWidth;
  const availH = container.clientHeight;
  if (availW < MIN_USABLE_PX || availH < MIN_USABLE_PX) {
    return (term.options.fontSize ?? baseFontSize) / baseFontSize;
  }

  // The grid's true size lives on `.xterm-screen`; the outer element is
  // stretched to its container by xterm's own stylesheet, so measuring that
  // would always report "it fits" while the content is quietly clipped.
  const measure = () => {
    const screen = el.querySelector<HTMLElement>(".xterm-screen");
    return { w: screen?.offsetWidth ?? 0, h: screen?.offsetHeight ?? 0 };
  };

  let size = term.options.fontSize ?? baseFontSize;
  // Cell size is proportional to font size, so one step lands close and a
  // second pass corrects the rounding.
  for (let pass = 0; pass < 2; pass++) {
    const m = measure();
    if (m.w === 0 || m.h === 0) break;
    const ratio = Math.min(availW / m.w, availH / m.h);
    const wanted = Math.min(baseFontSize, Math.max(4, Math.floor(size * ratio)));
    if (wanted === size) break;
    size = wanted;
    term.options.fontSize = size;
  }

  return size / baseFontSize;
}

/**
 * Run the fit now, on the next frame, and once more shortly after.
 *
 * The first call usually lands before xterm has finished laying out its grid,
 * where the measurement reads zero (or the old size) and the fit comes out as
 * a no-op — leaving the view clipped with nothing scheduled to correct it.
 */
export function scheduleScaleToFit(
  term: Terminal | null,
  container: HTMLElement | null,
  baseFontSize: number,
  onScale?: (scale: number) => void
): void {
  const run = () => onScale?.(scaleTerminalToFit(term, container, baseFontSize));
  run();
  requestAnimationFrame(run);
  setTimeout(run, 300);
}

/** Render the host's grid at full size, letting the container scroll. */
export function unscaleTerminal(
  term: Terminal | null,
  baseFontSize: number
): void {
  if (term) term.options.fontSize = baseFontSize;
}
