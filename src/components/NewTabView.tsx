import { useRef } from "react";
import { BrowserNewTabPane } from "@tabverse/workbench/browser-new-tab-pane";
import { SEARCH_ENGINES } from "../search";
import { useStore } from "../state/store";
import { useBarEntry } from "./CommandBar";
import { STR } from "../strings";
import { formatKeys, HINT_KEYS } from "../strings/formatKeys";

interface Props {
  readonly active: boolean;
  readonly onNavigate: (input: string) => void;
}

/** Desktop controller for the Workbench empty-browser-tab presentation. */
export function NewTabView({ active, onNavigate }: Props) {
  const entry = useBarEntry({
    mode: "newtab",
    active: true,
    openUrl: onNavigate,
    close: () => entryReset.current(),
  });
  const entryReset = useRef(entry.reset);
  entryReset.current = entry.reset;

  const engine = useStore((state) => state.searchEngine);
  const engineName =
    engine === null || engine === "custom"
      ? STR.common.bar.yourSearchEngine
      : SEARCH_ENGINES[engine].label;
  const fallback = entry.sections.fallback;
  const fallbackLabel =
    fallback === null
      ? null
      : fallback.url !== null
        ? STR.common.bar.openUrl({ url: fallback.url })
        : STR.common.bar.searchFor({
            engine: engineName,
            query: fallback.input,
          });

  return (
    <BrowserNewTabPane
      active={active}
      query={entry.query}
      ghost={entry.ghost?.rest ?? ""}
      selectedIndex={entry.sel}
      fallbackLabel={fallbackLabel}
      sites={entry.sections.sites.map((row) => ({
        title: row.site.title,
        host: row.site.host,
      }))}
      hints={{
        go: formatKeys(HINT_KEYS.enter),
        pick: formatKeys(HINT_KEYS.upDown),
        complete: formatKeys(HINT_KEYS.rightOrTab),
        clear: formatKeys(HINT_KEYS.escape),
      }}
      onQueryChange={entry.setInput}
      onInputKeyDown={entry.onKeyDown}
      onSelect={entry.setSel}
      onRun={(index) => entry.run(entry.rows[index])}
    />
  );
}
