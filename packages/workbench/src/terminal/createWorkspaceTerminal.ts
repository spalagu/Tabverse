import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { OVERVIEW_RULER_WIDTH } from "./decorations";
import { loadGraphemeWidths } from "./graphemeWidths";
import {
  describeTerminalLink,
  parseTerminalLink,
  type TerminalLink,
} from "./links";
import type {
  TerminalLinkHover,
  TerminalPathLinkProvider,
} from "./pathLinks";

export interface WorkspaceTerminalPorts {
  container: HTMLElement;
  theme: ITheme;
  fontOptions?: Partial<ITerminalOptions>;
  ligatures: boolean;
  imageMemoryMb: number | null;
  providePathLinks: TerminalPathLinkProvider;
  currentCwd: () => string | null;
  openLink: (link: TerminalLink, metaKey: boolean, shiftKey: boolean) => void;
  setHover: TerminalLinkHover;
}

export interface WorkspaceTerminal {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
}

/** Create the shared xterm renderer and its platform-neutral addon stack. */
export function createWorkspaceTerminal(
  ports: WorkspaceTerminalPorts
): WorkspaceTerminal {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    scrollback: 10000,
    overviewRulerWidth: OVERVIEW_RULER_WIDTH,
    ...ports.fontOptions,
    macOptionIsMeta: true,
    theme: ports.theme,
    linkHandler: {
      allowNonHttpProtocols: true,
      activate: (event, text) => {
        const link = parseTerminalLink(text);
        if (link !== null) {
          ports.openLink(link, event.metaKey, event.shiftKey);
        }
      },
      hover: (_event, text) => {
        const link = parseTerminalLink(text);
        ports.setHover(link === null ? text : describeTerminalLink(link), link);
      },
      leave: () => ports.setHover(null, null),
    },
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  loadGraphemeWidths(term);
  term.loadAddon(
    new ImageAddon({
      sixelSupport: true,
      iipSupport: true,
      ...(ports.imageMemoryMb === null
        ? {}
        : { storageLimit: ports.imageMemoryMb }),
    })
  );
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      ports.openLink(
        { kind: "url", url: uri },
        event.metaKey,
        event.shiftKey
      );
    })
  );
  term.registerLinkProvider({
    provideLinks: (lineNumber, done) => {
      void ports
        .providePathLinks(
          term,
          lineNumber,
          ports.currentCwd(),
          ports.setHover
        )
        .then(done);
    },
  });
  term.open(ports.container);

  if (ports.ligatures) {
    term.loadAddon(new LigaturesAddon());
  } else {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // The DOM renderer is the supported fallback.
    }
  }

  return { term, fit, search, serialize };
}
