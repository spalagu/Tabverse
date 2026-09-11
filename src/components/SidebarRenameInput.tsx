import { useRef } from "react";

/** Enter accepts, Escape cancels, blur accepts. Composition keystrokes belong
 * to the IME, never to the surrounding sidebar or application shortcuts. */
export function SidebarRenameInput({ value, label, onSave, onDone }: {
  value: string;
  label: string;
  onSave: (value: string) => void;
  onDone: (restoreFocus: boolean) => void;
}) {
  const finished = useRef(false);
  const restoreFocus = useRef(false);
  return (
    <input
      className="tab-rename"
      aria-label={label}
      autoFocus
      defaultValue={value}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (finished.current) return;
        finished.current = true;
        const name = event.currentTarget.value.trim();
        if (name && name !== value) onSave(name);
        onDone(restoreFocus.current);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          restoreFocus.current = true;
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          finished.current = true;
          onDone(true);
        }
      }}
    />
  );
}
