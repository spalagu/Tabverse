import { useEffect, useState } from "react";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR, plural } from "../strings";
import { ErrorState } from "../state/ErrorState";

export interface SqliteViewMeta {
  path: string;
  name: string;
  size: number;
  mime: string;
}

export interface SqliteInspection {
  type: string;
  tables?: TableInfo[];
}

export interface SqliteViewRuntime {
  inspect: (path: string) => Promise<SqliteInspection>;
  rows: (
    path: string,
    table: string,
    limit: number,
    offset: number
  ) => Promise<{ columns: string[]; rows: string[][]; total: number }>;
  reveal: (path: string) => Promise<void>;
  formatSize: (bytes: number) => string;
}

export interface SqliteViewProps<Meta extends SqliteViewMeta = SqliteViewMeta> {
  meta: Meta;
  runtime: SqliteViewRuntime;
}


const PAGE = 100;

type TableInfo = { name: string; rows: number; columns: string[] };

type ListState =
  | { phase: "loading" }
  | { phase: "ready"; tables: TableInfo[] }
  | { phase: "error"; message: string | ErrorDescription };

type RowsState =
  | { phase: "loading" }
  | { phase: "ready"; columns: string[]; rows: string[][]; total: number }
  | { phase: "error"; message: string | ErrorDescription };

export function SqliteView<Meta extends SqliteViewMeta>({
  meta,
  runtime,
}: SqliteViewProps<Meta>) {
  const [list, setList] = useState<ListState>({ phase: "loading" });
  const [table, setTable] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<RowsState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setList({ phase: "loading" });
    setTable(null);
    setOffset(0);
    // Also drop any rows from a previously previewed database, so nothing
    // stale can flash while the new file's first table loads.
    setRows({ phase: "loading" });

    (async () => {
      try {
        const data = await runtime.inspect(meta.path);
        if (cancelled) return;
        if (data.type !== "sqlite") {
          setList({
            phase: "error",
            message: STR.files.sqlite.notDatabase,
          });
          return;
        }
        const tables = data.tables ?? [];
        setList({ phase: "ready", tables });
        if (tables.length > 0) setTable(tables[0].name);
      } catch (e) {
        if (!cancelled)
          setList({
            phase: "error",
            message: describeError(e, STR.errors.actions.openDatabase),
          });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meta.path]);

  useEffect(() => {
    if (table === null) return;
    let cancelled = false;
    setRows({ phase: "loading" });

    (async () => {
      try {
        const page = await runtime.rows(meta.path, table, PAGE, offset);
        if (!cancelled) setRows({ phase: "ready", ...page });
      } catch (e) {
        if (!cancelled)
          setRows({
            phase: "error",
            message: describeError(e, STR.errors.actions.readTable),
          });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meta.path, table, offset]);

  if (list.phase === "loading") {
    return (
      <div className="preview-center">
        {STR.files.viewers.inspecting({ name: meta.name })}
      </div>
    );
  }
  if (list.phase === "error") {
    return (
      <div className="preview-center column">
        {typeof list.message === "string" ? (
          <div className="preview-note">{list.message}</div>
        ) : (
          <ErrorState inline error={list.message} />
        )}
        <div className="preview-sub">
          {meta.name} · {runtime.formatSize(meta.size)} · {meta.mime}
        </div>
        <button className="btn" onClick={() => void runtime.reveal(meta.path)}>
          {STR.files.tree.revealInFinder}
        </button>
      </div>
    );
  }
  if (list.tables.length === 0) {
    return (
      <div className="preview-center">
        <div className="preview-note">{STR.files.sqlite.emptyDatabase}</div>
      </div>
    );
  }

  return (
    <div className="sqlite-view">
      <div className="sqlite-tables">
        {list.tables.map((t) => (
          <button
            key={t.name}
            className={`sqlite-table-item${t.name === table ? " active" : ""}`}
            onClick={() => {
              setTable(t.name);
              setOffset(0);
            }}
          >
            {/* The row's accessible name comes from its name span. */}
            <span className="sqlite-table-name">{t.name}</span>
            <span className="sqlite-table-rows">
              {plural(t.rows, "row")}
            </span>
          </button>
        ))}
      </div>
      <div className="sqlite-main">
        {rows.phase === "loading" ? (
          <div className="preview-center">
            {STR.files.viewers.reading({ name: table ?? "" })}
          </div>
        ) : rows.phase === "error" ? (
          <div className="preview-center column">
            {typeof rows.message === "string" ? (
              <div className="preview-note">{rows.message}</div>
            ) : (
              <ErrorState inline error={rows.message} />
            )}
          </div>
        ) : (
          <TablePage
            columns={rows.columns}
            rows={rows.rows}
            total={rows.total}
            offset={offset}
            onPage={setOffset}
          />
        )}
      </div>
    </div>
  );
}

function TablePage({
  columns,
  rows,
  total,
  offset,
  onPage,
}: {
  columns: string[];
  rows: string[][];
  total: number;
  offset: number;
  onPage: (offset: number) => void;
}) {
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + rows.length;

  return (
    <>
      <div className="sqlite-pager">
        <button
          className="btn"
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - PAGE))}
        >
          ‹
        </button>
        <span className="sqlite-pager-range">
          {STR.files.sqlite.pagerRange({ first, last, total })}
        </span>
        <button
          className="btn"
          disabled={offset + PAGE >= total}
          onClick={() => onPage(offset + PAGE)}
        >
          ›
        </button>
      </div>
      <div className="sqlite-scroll">
        <table className="sqlite-table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={`${c}-${i}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {columns.map((_, c) => (
                  <td key={c}>{row[c] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
