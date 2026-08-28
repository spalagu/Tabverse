import {
  PreviewFind as WorkbenchPreviewFind,
} from "@tabverse/workbench/files/preview-find";
import { HINT_KEYS } from "../../strings/formatKeys";
import type { ComponentProps } from "react";

type Props = Omit<
  ComponentProps<typeof WorkbenchPreviewFind>,
  "previousHint" | "nextHint"
>;

export function PreviewFind(props: Props) {
  return (
    <WorkbenchPreviewFind
      {...props}
      previousHint={HINT_KEYS.up}
      nextHint={HINT_KEYS.down}
    />
  );
}
