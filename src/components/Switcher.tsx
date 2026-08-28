import { useEffect, useMemo, useRef, useState } from "react";
import { subsequenceScore as score, tabHaystack } from "../commandBar";
import { groupColor, useStore } from "../state/store";
import { TAB_ICONS } from "./icons";
import { STR } from "../strings";
import { formatKeys, HINT_KEYS } from "../strings/formatKeys";


export function Switcher() {
  const open = useStore((s) => s.switcherOpen);
  const tabs = useStore((s) => s.tabs);
  const groups = useStore((s) => s.groups);
  // groupColor reads the resolved theme; repaint group tints on a switch.
  useStore((s) => s.resolvedTheme);
  const setSwitcher = useStore((s) => s.setSwitcher);
  const activateTab = useStore((s) => s.activateTab);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useMemo(() => {
    const scored = tabs
      .filter((t) => t.peek !== true)
      .map((t) => {
        const group = groups.find((g) => g.id === t.groupId);
        return { tab: t, group, s: score(q, tabHaystack(t, group)) };
      })
      .filter((r) => r.s !== null) as {
      tab: (typeof tabs)[number];
      group: (typeof groups)[number] | undefined;
      s: number;
    }[];
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 12);
  }, [tabs, groups, q]);

  if (!open) return null;

  const pick = (i: number) => {
    const r = results[i];
    if (r) activateTab(r.tab.id);
    setSwitcher(false);
  };

  return (
    <div className="overlay" onMouseDown={() => setSwitcher(false)}>
      <div className="switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="switcher-input"
          placeholder={STR.common.switcher.placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          {...{ writingsuggestions: "false" }}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            // A third-party input method still owns the arrows while it is
            // composing; ⌘↑/⌘↓ are never taken by one, so the list stays
            // reachable whatever the input source is doing.
            const cmdArrow = e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp");
            if (e.nativeEvent.isComposing && !cmdArrow) return;
            if (cmdArrow) {
              e.preventDefault();
              setSel((i) =>
                e.key === "ArrowDown"
                  ? Math.min(i + 1, results.length - 1)
                  : Math.max(i - 1, 0)
              );
              e.stopPropagation();
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(sel);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setSwitcher(false);
            }
            e.stopPropagation();
          }}
        />
        <div className="switcher-list">
          {results.length === 0 && (
            <div className="switcher-empty">{STR.common.switcher.empty}</div>
          )}
          {results.map((r, i) => {
            const Icon = TAB_ICONS[r.tab.type];
            return (
              <button
                key={r.tab.id}
                className={`switcher-row${i === sel ? " sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(i)}
              >
                {/* The row's accessible name comes from its title span. */}
                <Icon size={14} />
                <span className="switcher-title">{r.tab.title}</span>
                {r.group && (
                  <span
                    className="switcher-group"
                    style={{ color: groupColor(r.group) }}
                  >
                    {r.group.name}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {/* Named because the alternate is not guessable: with a composing
            input method the plain arrows belong to its candidate window. */}
        <div className="switcher-hints">
          <span>
            {STR.common.switcher.hintChoose({
              arrows: formatKeys(HINT_KEYS.upDown),
              cmdArrows: formatKeys(HINT_KEYS.cmdUpDown),
            })}
          </span>
          <span>
            {STR.common.hints.open({ keys: formatKeys(HINT_KEYS.enter) })}
          </span>
          <span>
            {STR.common.hints.close({ keys: formatKeys(HINT_KEYS.escape) })}
          </span>
        </div>
      </div>
    </div>
  );
}
