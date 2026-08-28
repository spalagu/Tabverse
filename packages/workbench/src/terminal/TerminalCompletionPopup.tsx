import { useEffect, useRef } from "react";
import { STR } from "../strings";

export type TerminalCompletionOffer =
  | {
      readonly kind: "flags";
      readonly command: string;
      readonly word: string;
      readonly items: readonly string[];
    }
  | { readonly kind: "files"; readonly word: string };

export interface TerminalCompletionPopupProps {
  readonly offer: TerminalCompletionOffer;
  readonly selected: number;
  readonly onPick: (item: string) => void;
}

/** Runtime-independent command completion list drawn over a terminal pane. */
export function TerminalCompletionPopup({
  offer,
  selected,
  onPick,
}: TerminalCompletionPopupProps) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelectorAll("li")
      .item(selected)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (offer.kind === "files") return null;

  return (
    <div className="term-completion-popup">
      <p className="term-completion-hint">
        {STR.term.completionFlagsTitle({ command: offer.command })}
      </p>
      <ul className="term-completion-list" ref={listRef}>
        {offer.items.map((item, index) => (
          <li
            key={item}
            className={index === selected ? " selected" : ""}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPick(item);
            }}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
