import { useRef } from "react";

/** §5.P2: a cancelled/composing key must never fall through to blur-save. */
export function SidebarRenameInput({ value, label, onSave, onDone }: {
  value: string; label: string; onSave(value: string): void; onDone(restoreFocus: boolean): void;
}) {
  const finished = useRef(false);
  const restoreFocus = useRef(false);
  return <input className="tab-rename" aria-label={label} autoFocus defaultValue={value}
    onFocus={(e) => e.currentTarget.select()}
    onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
    onBlur={(e) => {
      if (finished.current) return;
      finished.current = true;
      const next = e.currentTarget.value.trim();
      if (next && next !== value) onSave(next);
      onDone(restoreFocus.current);
    }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") { e.preventDefault(); restoreFocus.current = true; e.currentTarget.blur(); }
      if (e.key === "Escape") { e.preventDefault(); finished.current = true; onDone(true); }
    }} />;
}
