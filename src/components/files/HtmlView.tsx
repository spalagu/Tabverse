import {
  HtmlView as SharedHtmlView,
  type HtmlViewProps as SharedHtmlViewProps,
} from "@tabverse/workbench/files/html-view";
import { fsApi } from "../../backend/fs";

export { absolutize } from "@tabverse/workbench/files/html-view";

export type HtmlViewProps = Omit<SharedHtmlViewProps, "urlForPath">;

export function HtmlView(props: HtmlViewProps) {
  return <SharedHtmlView {...props} urlForPath={fsApi.url} />;
}
