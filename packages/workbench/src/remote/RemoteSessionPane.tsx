import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  RemoteAgentPane,
  type RemoteAgentPaneProps,
} from "../agent/RemoteAgentPane";
import {
  subscribeTerminalFont,
  terminalFont,
  xtermFontOptions,
} from "../terminal/font";
import { loadGraphemeWidths } from "../terminal/graphemeWidths";
import { installMacKeyConventions } from "../terminal/keys";
import { scheduleScaleToFit } from "../terminal/scaleToFit";
import { remoteMirrorTheme } from "../theme";
import { STR } from "../strings";
import "./remote-session.css";

const REMOTE_THEME = remoteMirrorTheme();

export type RemoteRendererKind = "terminal" | "agent" | null;

export interface RemoteViewportHint {
  readonly cols: number;
  readonly rows: number;
  readonly percent: number;
}

export interface RemoteTermSink {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  reset(): void;
  rescale(): void;
  focus(): void;
  reportViewport(): void;
}

export interface RemoteTerminalPaneProps {
  readonly active: boolean;
  readonly attach: (sink: RemoteTermSink) => () => void;
  readonly sendInput: (data: string) => void;
  readonly sendViewport: (cols: number, rows: number) => void;
  readonly onViewportHint: (hint: RemoteViewportHint) => void;
  readonly imageMemoryMb: number | null;
}

export interface RemoteSessionPaneProps {
  readonly kind: RemoteRendererKind;
  readonly terminal: RemoteTerminalPaneProps;
  readonly agent: RemoteAgentPaneProps;
  readonly readOnly: boolean;
  readonly reconnectAttempt: number;
  readonly viewport: RemoteViewportHint | null;
  readonly showViewport: boolean;
}

/** Complete runtime-independent UI for a desktop tab joining a remote host. */
export function RemoteSessionPane({
  kind,
  terminal,
  agent,
  readOnly,
  reconnectAttempt,
  viewport,
  showViewport,
}: RemoteSessionPaneProps) {
  if (kind === "agent") return <RemoteAgentPane {...agent} />;

  return (
    <div className="term-pane">
      {kind === "terminal" ? (
        <RemoteTerminalPane {...terminal} />
      ) : (
        <div className="term-container remote remote-connecting">
          Connecting to remote session…
        </div>
      )}
      {(readOnly || reconnectAttempt > 0 || showViewport) && (
        <div className="remote-overlays">
          {showViewport && viewport !== null && (
            <span className="remote-chip">
              {STR.remote.viewportChip(viewport)}
            </span>
          )}
          {reconnectAttempt > 0 && (
            <span className="remote-chip reconnect">
              {STR.remote.reconnectChip({ attempt: reconnectAttempt })}
            </span>
          )}
          {readOnly && (
            <span className="remote-chip readonly">
              {STR.remote.viewOnlyChip}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The host-authoritative xterm renderer for a mirrored terminal share. */
function RemoteTerminalPane({
  active,
  attach,
  sendInput,
  sendViewport,
  onViewportHint,
  imageMemoryMb,
}: RemoteTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || termRef.current) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 10000,
      ...(xtermFontOptions(terminalFont()) ?? {}),
      macOptionIsMeta: true,
      theme: REMOTE_THEME,
      cols: 80,
      rows: 24,
    });
    loadGraphemeWidths(term);
    term.loadAddon(
      new ImageAddon({
        sixelSupport: true,
        iipSupport: true,
        ...(imageMemoryMb === null ? {} : { storageLimit: imageMemoryMb }),
      }),
    );
    term.loadAddon(new WebLinksAddon());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // The DOM renderer remains the supported fallback.
    }
    termRef.current = term;

    const bornWith = term.options.fontSize ?? 13;
    const base = () => terminalFont()?.size ?? bornWith;
    const rescale = () => {
      const from = base();
      term.options.fontSize = from;
      scheduleScaleToFit(term, element, from, (scale) =>
        onViewportHint({
          cols: term.cols,
          rows: term.rows,
          percent: Math.round(scale * 100),
        }),
      );
    };
    const applyFont = () => {
      const options = xtermFontOptions(terminalFont());
      if (options) Object.assign(term.options, options);
      rescale();
    };
    const unsubscribeFont = subscribeTerminalFont(applyFont);
    const scaleObserver = new ResizeObserver(rescale);
    scaleObserver.observe(element);

    installMacKeyConventions(term, sendInput);
    term.onData(sendInput);

    const reportViewport = () => {
      if (element.clientWidth < 120 || element.clientHeight < 120) return;
      const dimensions = fit.proposeDimensions();
      const from = base();
      const fontSize = term.options.fontSize ?? from;
      if (
        dimensions &&
        Number.isFinite(dimensions.cols) &&
        Number.isFinite(dimensions.rows)
      ) {
        sendViewport(
          Math.max(20, Math.floor((dimensions.cols * fontSize) / from)),
          Math.max(5, Math.floor((dimensions.rows * fontSize) / from)),
        );
      }
    };
    term.onResize(() => window.setTimeout(rescale, 50));
    const viewportObserver = new ResizeObserver(reportViewport);
    viewportObserver.observe(element);

    const detach = attach({
      write: (data) => term.write(data),
      resize: (cols, rows) => term.resize(cols, rows),
      reset: () => term.reset(),
      rescale,
      focus: () => term.focus(),
      reportViewport,
    });

    return () => {
      detach();
      unsubscribeFont();
      scaleObserver.disconnect();
      viewportObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // Runtime callbacks are stable ports; reconnects swap their targets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => termRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="term-container remote"
      onMouseDown={() => termRef.current?.focus()}
    />
  );
}
