import {
  SearchPanel as WorkbenchSearchPanel,
  type FileSearchRuntime,
} from "@tabverse/workbench/files/search-panel";
import type { SearchHistoryPort } from "@tabverse/workbench/files/search-history";
import { fsApi } from "../../backend/fs";
import { ReplacePreviewPane } from "./ReplacePreview";
import { recordSearch, searchHistory } from "./searchHistory";

export {
  globGhost,
  joinExcludeList,
  nameAbsPaths,
  splitExcludeList,
} from "@tabverse/workbench/files/search-panel";

export interface SearchPanelProps {
  root: string;
  includeHidden: boolean;
  onOpen: (path: string, line: number) => void;
  onSelectPaths: (relativePaths: string[]) => void;
}

const runtime: FileSearchRuntime = fsApi;
const historyPort: SearchHistoryPort = {
  load: searchHistory,
  record: recordSearch,
};

/** Desktop adapter for the shared file search panel. */
export function SearchPanel(props: SearchPanelProps) {
  return (
    <WorkbenchSearchPanel
      {...props}
      runtime={runtime}
      historyPort={historyPort}
      ReplacePreviewComponent={ReplacePreviewPane}
    />
  );
}
