import { useState } from "react";
import { useStore } from "../state/store";
import { STR } from "../strings";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function JoinDialog() {
  const open = useStore((s) => s.joinDialogOpen);
  const setJoinDialog = useStore((s) => s.setJoinDialog);
  const addTab = useStore((s) => s.addTab);
  const [value, setValue] = useState("");
  const [joining, setJoining] = useState(false);

  if (!open) return null;
  const close = () => {
    setJoinDialog(false);
    setValue("");
    setJoining(false);
  };

  const join = () => {
    const ticket = value.trim();
    if (!ticket || joining) return;
    setJoining(true);
    addTab({ type: "remote", joinTicket: ticket });
    setValue("");
    setJoining(false);
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{STR.share.joinTitle}</div>
        <p className="dialog-text">{STR.share.joinBlurb}</p>
        {!isTauri && (
          <p className="dialog-warn">{STR.share.joinDemoWarn}</p>
        )}
        <textarea
          className="ticket-area"
          placeholder={STR.share.ticketPlaceholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={5}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) join();
          }}
        />
        <div className="dialog-actions">
          <button className="btn" onClick={close}>
            {STR.common.cancel}
          </button>
          <button
            className="btn primary"
            onClick={join}
            disabled={!value.trim() || joining}
          >
            {joining ? STR.share.joining : STR.share.join}
          </button>
        </div>
      </div>
    </div>
  );
}
