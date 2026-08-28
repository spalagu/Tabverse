import type { Terminal } from "@xterm/xterm";

/**
 * Keyboard conventions a Mac terminal is expected to honour.
 *
 * The interesting one is Shift+Enter. Classic terminals cannot express it at
 * all: the wire protocol has no way to say "Enter, with Shift". Modern CLIs
 * that want a soft newline (Claude Code among them) therefore ask for the
 * **Kitty keyboard protocol**, where keys are reported as `CSI code;mods u` —
 * Shift+Enter becomes `CSI 13;2u`. An app enables it by pushing flags with
 * `CSI > flags u` and disables it with `CSI < u`.
 *
 * So: honour the negotiation. While an app has the protocol enabled we send
 * `CSI 13;2u`; otherwise we fall back to `ESC CR`, which is what VS Code's
 * `/terminal-setup` binding emits and which those CLIs also accept. Sending
 * CSI u unconditionally would spray `[13;2u` into every plain shell prompt.
 */
export function installMacKeyConventions(
  term: Terminal,
  send: (data: string) => void,
  paste: (text: string) => void = (text) => term.paste(text),
  copy: (text: string) => void = (text) => {
    void navigator.clipboard.writeText(text);
  }
): void {
  // The app's Kitty-protocol stack, flags per entry, plus the base entry the
  // protocol defines for when nothing was pushed. Nonzero current flags mean
  // the app wants CSI u reports. Tracking a bare depth here once left the
  // stack unbalanced: pop carries a count, and set edits the current entry.
  const stack: number[] = [];
  let base = 0;
  const current = () =>
    stack.length > 0 ? stack[stack.length - 1] : base;
  const setCurrent = (flags: number) => {
    if (stack.length > 0) stack[stack.length - 1] = flags;
    else base = flags;
  };

  // CSI > flags u — push (enable).
  term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
    stack.push(params.length > 0 ? Number(params[0]) : 1);
    return true;
  });
  // CSI = flags ; mode u — edit the current entry: 1 set, 2 or-in, 3 clear.
  term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
    const flags = Number(params[0] ?? 0);
    const mode = Number(params[1] ?? 1);
    if (mode === 2) setCurrent(current() | flags);
    else if (mode === 3) setCurrent(current() & ~flags);
    else setCurrent(flags);
    return true;
  });
  // CSI < n u — pop n entries (default 1).
  term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
    const n = Math.max(1, Number(params[0] ?? 1) || 1);
    stack.splice(Math.max(0, stack.length - n));
    return true;
  });
  // CSI ? u — the app asking what is enabled. Answering keeps apps that probe
  // before enabling from concluding the terminal has no support at all.
  term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
    send(`\x1b[?${current()}u`);
    return true;
  });

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;

    // Identify Return by any of the three fields that name it. `key` alone is
    // enough for a keyboard, but not every source of key events fills it in —
    // remote input and automation stacks routinely send only `code`.
    const isReturn =
      ev.key === "Enter" ||
      ev.code === "Enter" ||
      ev.code === "NumpadEnter" ||
      ev.keyCode === 13;

    if (isReturn && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      send(current() > 0 ? "\x1b[13;2u" : "\x1b\r");
      return false;
    }

    // Copy: the Mac's Cmd+C, and the Windows/Linux spellings — the join
    // page is opened from phones and Windows machines, where Cmd+C does
    // not exist and the reflex key (bare Ctrl+C) is SIGINT: with a
    // selection standing, the reflex must not reach the shell as \x03.
    const k = ev.key.toLowerCase();
    const copySpelled =
      (ev.metaKey && !ev.ctrlKey && !ev.altKey && k === "c") ||
      (ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey && k === "c") ||
      (ev.ctrlKey && !ev.shiftKey && !ev.metaKey && !ev.altKey &&
        ev.code === "Insert") ||
      // Bare Ctrl+C is the Windows terminal's dual-purpose key: COPY when
      // a selection stands, SIGINT when nothing does. Selection-gated
      // here; with no selection it falls through to the shell below.
      (ev.ctrlKey && !ev.shiftKey && !ev.metaKey && !ev.altKey &&
        k === "c" && term.hasSelection());
    if (copySpelled) {
      if (term.hasSelection()) copy(term.getSelection());
      // Cmd+C is swallowed with or without a selection (it is not a
      // terminal key); the Windows spellings are swallowed ONLY when they
      // copied something — a bare Ctrl+C with no selection is SIGINT and
      // must reach the shell.
      if (ev.metaKey || term.hasSelection()) return false;
    }
    // Paste: Cmd+V, and Windows' Ctrl+Shift+V. (Ctrl+Insert is COPY up
    // above; Shift+Insert is the paste twin, with no modern key field.)
    const pasteSpelled =
      (ev.metaKey && !ev.ctrlKey && !ev.altKey && k === "v") ||
      (ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey && k === "v") ||
      (!ev.ctrlKey &&
        ev.shiftKey &&
        !ev.metaKey &&
        !ev.altKey &&
        ev.code === "Insert");
    if (pasteSpelled) {
      void navigator.clipboard.readText().then((t) => {
        if (t) paste(t);
      });
      return false;
    }
    if (ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (k === "c") {
        // Handled above when a selection existed; a Cmd+C with nothing
        // selected still never reaches the app as a control code.
        return false;
      }
    }
    return true;
  });
}
