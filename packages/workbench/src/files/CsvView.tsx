import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  CSV_ROW_LIMIT,
  deleteCsvColumn,
  deleteCsvRow,
  insertCsvColumn,
  insertCsvRow,
  parseCsv,
  serializeCsv,
} from "./csv";
import { STR } from "../strings";

/** Cell being edited: header cells use row -1, data rows count from 0. */
interface EditingCell {
  row: number;
  col: number;
  /** Uncommitted input text; the grid itself keeps the committed value. */
  value: string;
}

interface GridMenu {
  kind: "row" | "col";
  /** Data-row index for rows, column index for columns. */
  at: number;
  x: number;
  y: number;
}

export function CsvView({
  text,
  delimiter,
  onEdit,
}: {
  text: string;
  delimiter: "," | "\t";
  /**
   * Enables click-to-edit cells. Honored only while the parse is complete:
   * rebuilding the file from a truncated grid would drop every record past
   * the row cap, so oversized files stay read-only here and are edited as
   * source instead.
   */
  onEdit?: (nextText: string) => void;
}) {
  const parsed = useMemo(() => parseCsv(text, delimiter), [text, delimiter]);
  const { header, rows, totalDataRows, truncated } = parsed;

  const [editing, setEditing] = useState<EditingCell | null>(null);
  /** True once Enter/Escape/Tab settled the cell, so the input's trailing
   *  blur (browser-dependent on unmount) cannot commit a second time. */
  const settledRef = useRef(true);
  const [menu, setMenu] = useState<GridMenu | null>(null);

  // The grid menu closes on outside press or Escape — the same contract
  // every context menu here carries.
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      if (!document.querySelector(".csv-grid-menu")?.contains(e.target as Node))
        setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", down, { capture: true });
    window.addEventListener("keydown", key, { capture: true });
    return () => {
      window.removeEventListener("mousedown", down, { capture: true });
      window.removeEventListener("keydown", key, { capture: true });
    };
  }, [menu]);

  const editable = onEdit !== undefined && !truncated;
  const blockedReason = truncated
    ? STR.files.csv.blockedTruncated
    : onEdit === undefined
      ? STR.files.csv.blockedNoEdit
      : null;

  if (header.length === 0) {
    return (
      <div className="preview-center">
        <div className="preview-note">{STR.files.csv.emptyFile}</div>
      </div>
    );
  }

  // Ragged files exist; size the grid to the widest record we kept so no
  // cell of any row is silently dropped.
  const cols = Math.max(header.length, ...rows.map((r) => r.length));

  /** Committed field text at a grid position; "" for ragged-row gaps. */
  const fieldAt = (row: number, col: number): string =>
    (row === -1 ? header[col] : rows[row]?.[col]) ?? "";

  const beginEdit = (row: number, col: number) => {
    if (!editable) return;
    // Clicks inside the live input bubble up to its cell; reseeding here
    // would wipe what the user has typed.
    if (editing && editing.row === row && editing.col === col) return;
    setEditing({ row, col, value: fieldAt(row, col) });
  };

  /** Commit the in-flight value, then move to `next` (null closes). */
  const commit = (next: EditingCell | null) => {
    if (!editing) return;
    // The grid re-derives from `text`; if the file changed under us (e.g. a
    // refresh shrank it) the edited position may be gone — drop the edit
    // rather than write into a record that no longer exists.
    if (editing.row >= rows.length) {
      setEditing(null);
      return;
    }
    if (editing.value !== fieldAt(editing.row, editing.col)) {
      const nextHeader = [...header];
      const nextRows = rows.map((r) => [...r]);
      const record = editing.row === -1 ? nextHeader : nextRows[editing.row];
      // Editing a ragged row's missing cell materializes it (and any gap
      // before it) as empty fields.
      while (record.length <= editing.col) record.push("");
      record[editing.col] = editing.value;
      onEdit?.(serializeCsv(nextHeader, nextRows, delimiter));
    }
    setEditing(next);
  };

  const focusInput = (el: HTMLInputElement | null) => {
    if (el && document.activeElement !== el) {
      // The cell was just clicked, so it is already in view; a plain focus()
      // could scroll-jump the sticky-header container to "reveal" it.
      el.focus({ preventScroll: true });
      el.select();
      settledRef.current = false;
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!editing) return;
    if (e.key === "Enter") {
      settledRef.current = true;
      commit(null);
    } else if (e.key === "Escape") {
      settledRef.current = true;
      setEditing(null);
    } else if (e.key === "Tab" && !e.shiftKey) {
      // Keep focus inside the grid: commit, then hop to the next cell of the
      // same row (last cell just closes).
      e.preventDefault();
      settledRef.current = true;
      const col = editing.col + 1;
      commit(
        col < cols
          ? { row: editing.row, col, value: fieldAt(editing.row, col) }
          : null
      );
    }
  };

  const onInputBlur = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    commit(null);
  };

  /** Cell body: plain text normally; while edited, an input overlaid on an
   *  invisible copy of the committed value so the column width cannot jump. */
  const cellContent = (row: number, col: number) => {
    if (!editing || editing.row !== row || editing.col !== col) {
      return fieldAt(row, col);
    }
    return (
      <>
        <span className="csv-ghost">{fieldAt(row, col)}</span>
        <input
          ref={focusInput}
          className="csv-cell-input"
          value={editing.value}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onKeyDown={onInputKeyDown}
          onBlur={onInputBlur}
        />
      </>
    );
  };

  const cellClass = (row: number, col: number) =>
    editing && editing.row === row && editing.col === col
      ? "csv-cell-editing"
      : undefined;

  const applyGridOp = (
    op: "insert-row" | "delete-row" | "insert-col" | "delete-col"
  ) => {
    const m = menu;
    setMenu(null);
    if (!m || !onEdit || blockedReason) return;
    const grid =
      m.kind === "row"
        ? op === "insert-row"
          ? insertCsvRow(header, rows, m.at)
          : deleteCsvRow(header, rows, m.at)
        : op === "insert-col"
          ? insertCsvColumn(header, rows, m.at)
          : deleteCsvColumn(header, rows, m.at);
    onEdit(serializeCsv(grid.header, grid.rows, delimiter));
  };

  const menuItems: {
    key: "insert-row" | "delete-row" | "insert-col" | "delete-col";
    label: string;
  }[] =
    menu?.kind === "col"
      ? [
          { key: "insert-col", label: STR.files.csv.insertColumn },
          { key: "delete-col", label: STR.files.csv.deleteColumn },
        ]
      : [
          { key: "insert-row", label: STR.files.csv.insertRow },
          { key: "delete-row", label: STR.files.csv.deleteRow },
        ];

  return (
    <div className="csv-view">
      <div className="csv-info">
        <span>{STR.files.csv.info({ rows: totalDataRows, cols })}</span>
        {truncated && (
          <span className="csv-truncation">
            {STR.files.csv.truncationNote({
              shown: CSV_ROW_LIMIT,
              total: totalDataRows,
            })}
          </span>
        )}
        {truncated && onEdit !== undefined && (
          <span>{STR.files.csv.editAsSourceNote}</span>
        )}
      </div>
      <div className="csv-scroll">
        <table className={editable ? "csv-table csv-editable" : "csv-table"}>
          <thead>
            <tr>
              <th className="csv-rowhead" aria-label={STR.files.csv.rowHead} />
              {Array.from({ length: cols }, (_, c) => (
                <th
                  key={c}
                  className={cellClass(-1, c)}
                  onClick={() => beginEdit(-1, c)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ kind: "col", at: c, x: e.clientX, y: e.clientY });
                  }}
                >
                  {cellContent(-1, c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((_, r) => (
              <tr key={r}>
                <td
                  className="csv-rowhead"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ kind: "row", at: r, x: e.clientX, y: e.clientY });
                  }}
                >
                  {r + 1}
                </td>
                {Array.from({ length: cols }, (_, c) => (
                  <td
                    key={c}
                    className={cellClass(r, c)}
                    onClick={() => beginEdit(r, c)}
                  >
                    {cellContent(r, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {menu && (
        <div
          className="ctx-menu csv-grid-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 220)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 130)),
          }}
        >
          <div className="ctx-title">
            {menu.kind === "row"
              ? STR.files.csv.rowTitle({ n: menu.at + 1 })
              : STR.files.csv.colTitle({
                  name: header[menu.at] ?? STR.files.csv.colNumber({ n: menu.at + 1 }),
                })}
          </div>
          {menuItems.map((item) => (
            <button
              key={item.key}
              className="ctx-item"
              disabled={!!blockedReason}
              title={blockedReason ?? undefined}
              onClick={() => applyGridOp(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
