import {
  SqliteView as SharedSqliteView,
  type SqliteViewRuntime,
} from "@tabverse/workbench/files/sqlite-view";
import { fsApi, formatSize, type FileMeta } from "../../backend/fs";

const runtime: SqliteViewRuntime = {
  inspect: fsApi.inspect,
  rows: fsApi.sqliteRows,
  reveal: fsApi.reveal,
  formatSize,
};

export function SqliteView({ meta }: { meta: FileMeta }) {
  return <SharedSqliteView meta={meta} runtime={runtime} />;
}
