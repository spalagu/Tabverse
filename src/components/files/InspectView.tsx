import {
  InspectView as SharedInspectView,
  type InspectViewRuntime,
} from "@tabverse/workbench/files/inspect-view";
import { fsApi, formatSize, type FileMeta } from "../../backend/fs";

const runtime: InspectViewRuntime = {
  inspect: fsApi.inspect,
  reveal: fsApi.reveal,
  extract: fsApi.extract,
  chooseDirectory: async (title) => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title,
    });
    return typeof picked === "string" ? picked : null;
  },
  formatSize,
};

export function InspectView({ meta }: { meta: FileMeta }) {
  return <SharedInspectView meta={meta} runtime={runtime} />;
}
