import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { installMacKeyConventions } from "./keys";
import {
  scheduleScaleToFit,
  unscaleTerminal,
} from "./scaleToFit";
import { TERMINAL_FONT_STACK } from "./font";
import { terminalTheme } from "../theme";
import { STR } from "../strings";

/** Font size at 100%; the fit shrinks from here and never grows past it. */
export const BASE_FONT_SIZE = 13;

/** Chrome slots for the viewer terminal, from the shared token layer — the
 * same keys this page has always set (no cursorAccent, no ANSI slots, which
 * stay on xterm's defaults exactly as before the React port). */
const FULL_THEME = terminalTheme("dark");
const VIEWER_THEME = {
  background: FULL_THEME.background,
  foreground: FULL_THEME.foreground,
  cursor: FULL_THEME.cursor,
  selectionBackground: FULL_THEME.selectionBackground,
};

export interface TermSink {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  reset(): void;
  /** Re-fit the grid to the pane (fit mode) or restore 1:1 (actual size). */
  rescale(): void;
  focus(): void;
  /** Measure this pane and report what it could display to the host. */
  reportViewport(): void;
  /** The selection standing in the grid, or "" — the toolbar's Copy. */
  getSelection(): string;
}

export interface TerminalViewerProps {
  /** Register with the connection; replays buffered ops. Returns detach. */
  attach: (sink: TermSink) => () => void;
  onInput: (data: string) => void;
  sendViewport: (cols: number, rows: number) => void;
  /** Fit shows the host's whole screen at once; actual size keeps the text
   * readable and lets the container scroll. Neither changes the column
   * count, which is the thing that would corrupt the stream. */
  fitMode: boolean;
  /** What the zoom button should read ("Fit", "Fit 80%", "100%"). */
  onScaleLabel: (label: string) => void;
  debugInput: boolean;
  /** The page's copy route, replacing the keys module's default board write. */
  onCopy?: (text: string) => void;
  /** Called with pasted text before it lands in the mirrored terminal. */
  onPaste?: (text: string) => void;
}

/**
 * The xterm renderer for a mirrored terminal share.
 *
 * The grid is host-authoritative: we render the host's cols×rows and show
 * all of it by scaling the font, never by resizing ourselves (that would
 * re-wrap output written for the host's columns) and never with a CSS
 * transform (that would break hit-testing).
 */
export function TerminalViewer({
  attach,
  onInput,
  sendViewport,
  fitMode,
  onScaleLabel,
  debugInput,
  onCopy,
  onPaste,
}: TerminalViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const rescaleRef = useRef<() => void>(() => {});

  // Render-scope values the once-mounted closures need fresh reads of.
  const fitModeRef = useRef(fitMode);
  const onInputRef = useRef(onInput);
  const sendViewportRef = useRef(sendViewport);
  const onScaleLabelRef = useRef(onScaleLabel);
  const onCopyRef = useRef(onCopy);
  const onPasteRef = useRef(onPaste);
  useEffect(() => {
    onInputRef.current = onInput;
    sendViewportRef.current = sendViewport;
    onScaleLabelRef.current = onScaleLabel;
    onCopyRef.current = onCopy;
    onPasteRef.current = onPaste;
  }, [onInput, sendViewport, onScaleLabel, onCopy, onPaste]);


  useEffect(() => {
    fitModeRef.current = fitMode;
    rescaleRef.current();
  }, [fitMode]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || termRef.current) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: TERMINAL_FONT_STACK,
      fontSize: BASE_FONT_SIZE,
      lineHeight: 1.2,
      cols: 80,
      rows: 24,
      theme: VIEWER_THEME,
    });
    const uni = new Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = "11";
    // Measurement only — never fit() a mirrored grid; proposeDimensions()
    // tells us what we *could* show, which we report so the host can shrink
    // its grid to the smallest viewer, tmux-style.
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;

    const rescale = () => {
      if (!fitModeRef.current) {
        unscaleTerminal(term, BASE_FONT_SIZE);
        el.style.overflow = "auto";
        onScaleLabelRef.current("100%");
        return;
      }
      el.style.overflow = "hidden";
      // Reset before measuring: the fit only ever shrinks, so a stale small
      // font would make the grid look like it already fits.
      unscaleTerminal(term, BASE_FONT_SIZE);
      scheduleScaleToFit(term, el, BASE_FONT_SIZE, (scale) => {
        onScaleLabelRef.current(
          scale < 1
            ? STR.remote.web.fitPercent({ percent: Math.round(scale * 100) })
            : STR.remote.web.fit
        );
      });
    };
    rescaleRef.current = rescale;

    // Input is wired ONCE for this renderer's lifetime; reconnects swap the
    // session under the onInput closure. Read-only gating and the sticky
    // Ctrl modifier live with the owner — this component only produces the
    // keystrokes. The clipboard chords route through the page's hooks when
    // it has them: a copy may also push to a live app share, and a paste
    // reconciles first (the hook runs before the paste lands, which is the
    // order the reconciliation needs). Without hooks the keys module's own
    // defaults stand.
    installMacKeyConventions(
      term,
      (data) => onInputRef.current(data),
      (text) => {
        onPasteRef.current?.(text);
        term.paste(text);
      },
      (text) => {
        if (onCopyRef.current) onCopyRef.current(text);
        else void navigator.clipboard.writeText(text);
      }
    );
    term.onData((data) => {
      // `?debug` in the URL traces what the page forwards — the one thing
      // you cannot see from either end when input goes missing.
      if (debugInput) console.log("onData", JSON.stringify(data));
      onInputRef.current(data);
    });

    // Tell the host what we can display, measured at the base font size so a
    // scaled-down view doesn't report an ever-shrinking viewport.
    const reportViewport = () => {
      // A hidden or collapsed pane measures a few pixels; reporting that
      // would shrink the HOST's terminal to a sliver for everyone.
      if (el.clientWidth < 120 || el.clientHeight < 120) return;
      // Measure at the current font, then scale to the base font
      // arithmetically: toggling fontSize just to measure would re-layout
      // the grid twice and race with the fit logic doing the same.
      const dims = fit.proposeDimensions();
      const f = term.options.fontSize ?? BASE_FONT_SIZE;
      if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
        const cols = Math.max(20, Math.floor((dims.cols * f) / BASE_FONT_SIZE));
        const rows = Math.max(5, Math.floor((dims.rows * f) / BASE_FONT_SIZE));
        if (debugInput) console.log("viewport ->", cols, rows);
        sendViewportRef.current(cols, rows);
      }
    };

    // Re-fit when xterm finishes applying a host resize: this fires after
    // the internal re-layout, so the measurement is guaranteed fresh —
    // timers and rAF both race it or freeze in background tabs.
    term.onResize(() => window.setTimeout(() => rescale(), 50));
    // A window resize is not the only way the slot changes size — the soft
    // keyboard shrinking the visual viewport is another, and both land here.
    const ro = new ResizeObserver(() => {
      rescale();
      reportViewport();
    });
    ro.observe(el);

    const detach = attach({
      write: (data) => term.write(data),
      resize: (cols, rows) => {
        term.resize(cols, rows);
        rescale();
      },
      reset: () => term.reset(),
      rescale,
      focus: () => term.focus(),
      reportViewport,
      getSelection: () => term.getSelection(),
    });

    // The terminal now exists, so the viewport can finally be measured; the
    // report attempted right after connect ran before this and did nothing.
    // Both timers: rAF is frozen in background tabs, setTimeout is not.
    requestAnimationFrame(() => reportViewport());
    setTimeout(() => reportViewport(), 250);
    term.focus();
    rescale();

    return () => {
      detach();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      rescaleRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div id="term" ref={containerRef} />;
}
