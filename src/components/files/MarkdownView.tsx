import {
  MarkdownView as SharedMarkdownView,
  type MarkdownViewProps as SharedMarkdownViewProps,
} from "@tabverse/workbench/files/markdown-view";
import { fsApi } from "../../backend/fs";

export type MarkdownViewProps = Omit<SharedMarkdownViewProps, "urlForPath">;

export function MarkdownView(props: MarkdownViewProps) {
  return <SharedMarkdownView {...props} urlForPath={fsApi.url} />;
}
