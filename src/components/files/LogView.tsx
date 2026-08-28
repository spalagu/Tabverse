import {
  LogView as SharedLogView,
  type LogViewRuntime,
} from "@tabverse/workbench/files/log-view";
import { b64decode } from "../../backend/b64";
import { fsApi, type FileMeta } from "../../backend/fs";

const runtime: LogViewRuntime = {
  readRange: fsApi.readRange,
  decodeBase64: b64decode,
};

export function LogView({ meta }: { meta: FileMeta }) {
  return <SharedLogView meta={meta} runtime={runtime} />;
}
