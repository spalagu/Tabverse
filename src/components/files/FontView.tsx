import {
  FontView as SharedFontView,
  type FontMeta,
  type FontViewRuntime,
} from "@tabverse/workbench/files/font-view";
import { fsApi, formatSize, type FileMeta } from "../../backend/fs";

const runtime: FontViewRuntime = {
  url: fsApi.url,
  inspectFont: async (path): Promise<FontMeta | null> => {
    const inspection = await fsApi.inspect(path);
    return inspection.type === "font" ? inspection : null;
  },
  reveal: fsApi.reveal,
  formatSize,
};

export function FontView({ meta }: { meta: FileMeta }) {
  return <SharedFontView meta={meta} runtime={runtime} />;
}
