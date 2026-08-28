import type { SearchAddon } from "@xterm/addon-search";
import { TerminalSearchBar } from "@tabverse/workbench/terminal/search-bar";
import { useStore } from "../../state/store";
import { formatKeys, HINT_KEYS } from "../../strings/formatKeys";

interface Props {
  readonly search: SearchAddon;
  readonly onClose: () => void;
}

/** Desktop theme and shortcut adapter for the shared terminal search bar. */
export function SearchBar({ search, onClose }: Props) {
  const theme = useStore((state) => state.resolvedTheme);
  return (
    <TerminalSearchBar
      search={search}
      theme={theme}
      hints={{
        history: formatKeys(HINT_KEYS.up),
        previous: formatKeys(HINT_KEYS.shiftEnter),
        next: formatKeys(HINT_KEYS.enter),
        close: formatKeys(HINT_KEYS.escape),
        previousGlyph: HINT_KEYS.up,
        nextGlyph: HINT_KEYS.down,
      }}
      onClose={onClose}
    />
  );
}
