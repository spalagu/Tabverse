import {
  MillerView as WorkbenchMillerView,
  type MillerViewProps,
} from "@tabverse/workbench/files/miller-view";
import { fsApi, gitBadge } from "../../backend/fs";
import { useStore } from "../../state/store";

type Props = Omit<MillerViewProps, "runtime" | "badgeFor">;

const runtime = {
  listDirectory: fsApi.list,
};

export function MillerView(props: Props) {
  const resolvedTheme = useStore((state) => state.resolvedTheme);

  return (
    <WorkbenchMillerView
      {...props}
      runtime={runtime}
      badgeFor={(status) => gitBadge(status, resolvedTheme)}
    />
  );
}
