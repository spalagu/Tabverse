import {
  InputLine,
  completionFor,
  type CompletionOffer,
  type CompletionSpec,
} from "./completion";
import {
  BRACKETED_PASTE_START,
  guardPaste,
  type PasteGuardPorts,
} from "./pasteGuard";

export interface TerminalInputCompletion {
  offer: CompletionOffer;
  sel: number;
}

export interface TerminalInputControllerPorts {
  write: (data: string | Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  broadcast: (data: string | Uint8Array) => void;
  onData: (listener: (data: string) => void) => void;
  onBinary: (listener: (data: string) => void) => void;
  onResize: (listener: (size: { cols: number; rows: number }) => void) => void;
  plainPaste: (text: string) => void;
  askPaste: (text: string) => void;
  pasteGuardEnabled: () => boolean | null;
  setPastePorts: (ports: PasteGuardPorts) => void;
  setTyping: (typing: (data: string) => void) => void;
  setCompletion: (completion: TerminalInputCompletion | null) => void;
  completionSpec: () => CompletionSpec | null;
  inputLine?: InputLine;
  installConventions: (
    send: (data: string) => void,
    paste: (text: string) => void
  ) => void;
  recordConventionInput?: (data: string) => void;
  focus: () => void;
}

export interface TerminalInputController {
  sendKeys: (data: string | Uint8Array) => void;
  inputLine: InputLine;
}

/**
 * Installs every path by which keyboard-shaped input reaches a terminal.
 * The host supplies the current pane and broadcast destinations; this
 * controller guarantees they receive the same bytes and share paste rules.
 */
export function installTerminalInputController(
  ports: TerminalInputControllerPorts
): TerminalInputController {
  const inputLine = ports.inputLine ?? new InputLine();
  const sendKeys = (data: string | Uint8Array) => {
    ports.write(data);
    ports.broadcast(data);
  };

  const pastePorts: PasteGuardPorts = {
    sendKeys: (data) => sendKeys(data),
    plainPaste: ports.plainPaste,
    ask: ports.askPaste,
    enabled: ports.pasteGuardEnabled,
  };
  ports.setPastePorts(pastePorts);
  ports.setTyping((data) => sendKeys(data));

  ports.installConventions(
    (data) => {
      ports.recordConventionInput?.(data);
      sendKeys(data);
    },
    (text) => guardPaste(text, pastePorts)
  );

  ports.onData((data) => {
    if (data.includes(BRACKETED_PASTE_START)) {
      inputLine.reset();
      ports.setCompletion(null);
    } else {
      const line = inputLine.push(data);
      const offer = completionFor(line, ports.completionSpec());
      ports.setCompletion(offer === null ? null : { offer, sel: 0 });
    }
    sendKeys(data);
  });

  ports.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index++) {
      bytes[index] = data.charCodeAt(index) & 0xff;
    }
    sendKeys(bytes);
  });
  ports.onResize(({ cols, rows }) => ports.resize(cols, rows));
  ports.focus();

  return { sendKeys, inputLine };
}
