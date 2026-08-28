import {
  Preview as WorkbenchPreview,
  type FilePreviewRenderers,
  type FilePreviewRuntime,
} from "@tabverse/workbench/files/preview";
import { fsApi, formatSize, type FileMeta } from "../../backend/fs";
import { FontView } from "./FontView";
import { HexView } from "./HexView";
import { InspectView } from "./InspectView";
import { SqliteView } from "./SqliteView";

const runtime: FilePreviewRuntime = {
  url: (path) => fsApi.url(path),
  inspectImage: async (path) => {
    const result = await fsApi.inspect(path);
    return result.type === "image"
      ? { width: result.width, height: result.height }
      : null;
  },
  reveal: async (path) => {
    await fsApi.reveal(path);
  },
  formatSize,
};

const renderers: FilePreviewRenderers<FileMeta> = {
  InspectView,
  SqliteView,
  FontView,
  HexView,
};

export function Preview({ meta }: { meta: FileMeta }) {
  return (
    <WorkbenchPreview<FileMeta>
      meta={meta}
      runtime={runtime}
      renderers={renderers}
    />
  );
}
