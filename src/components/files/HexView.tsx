import {
  HexView as SharedHexView,
  type HexViewRuntime,
} from "@tabverse/workbench/files/hex-view";
import { b64decode } from "../../backend/b64";
import { fsApi, type FileMeta } from "../../backend/fs";

const runtime: HexViewRuntime = {
  readRange: fsApi.readRange,
  decodeBase64: b64decode,
  reveal: fsApi.reveal,
};

export function HexView({ meta }: { meta: FileMeta }) {
  return <SharedHexView meta={meta} runtime={runtime} />;
}
