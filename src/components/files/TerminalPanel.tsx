import { backend } from "../../backend";
import { coreLog } from "../../errlog";
import { useStore } from "../../state/store";
import {
  TerminalPanel as WorkbenchTerminalPanel,
  type TerminalPanelProps,
  type TerminalPanelRuntime,
} from "@tabverse/workbench/files/terminal-panel";

const terminalPanelRuntime: TerminalPanelRuntime = {
  createTerminal: (options) => backend.createTerminal(options),
  reportDiagnostic: coreLog,
};

type Props = Omit<TerminalPanelProps, "runtime" | "theme">;

export function TerminalPanel(props: Props) {
  const theme = useStore((state) => state.resolvedTheme);
  return (
    <WorkbenchTerminalPanel
      {...props}
      runtime={terminalPanelRuntime}
      theme={theme}
    />
  );
}
