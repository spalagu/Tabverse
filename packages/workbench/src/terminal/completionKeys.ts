import {
  InputLine,
  type CompletionOffer,
} from "./completion";

export interface CompletionSelection {
  offer: CompletionOffer;
  sel: number;
}

export interface CompletionKeyPorts {
  current: () => CompletionSelection | null;
  update: (selection: CompletionSelection | null) => void;
  inputLine: InputLine;
  type: (data: string) => void;
}

/** Handle one capture-phase key while a terminal completion popup is open. */
export function handleTerminalCompletionKey(
  event: KeyboardEvent,
  ports: CompletionKeyPorts
): boolean {
  const current = ports.current();
  if (current === null) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    consume(event);
    const size =
      current.offer.kind === "flags" ? current.offer.items.length : 0;
    if (size === 0) return true;
    const next =
      event.key === "ArrowDown"
        ? (current.sel + 1) % size
        : (current.sel - 1 + size) % size;
    ports.update({ offer: current.offer, sel: next });
    return true;
  }
  if (event.key === "Escape") {
    consume(event);
    ports.update(null);
    return true;
  }
  if (event.key !== "Tab" && event.key !== "Enter") return false;

  consume(event);
  if (current.offer.kind !== "flags") {
    ports.update(null);
    return true;
  }
  const item = current.offer.items[current.sel];
  if (item === undefined) return true;
  const word = current.offer.word;
  const suffix = `${item.startsWith(word) ? item.slice(word.length) : item} `;
  ports.inputLine.push(suffix);
  ports.type(suffix);
  ports.update(null);
  return true;
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}
