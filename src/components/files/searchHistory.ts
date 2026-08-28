import {
  SEARCH_HISTORY_SCOPE,
  createSearchHistoryController,
} from "@tabverse/workbench/files/search-history";
import { deleteState, loadState, saveState } from "../../persist";
import { isFreshRun } from "../../state/store";

export {
  SEARCH_HISTORY_MAX,
  SEARCH_HISTORY_SCOPE,
  mergeSearchHistory,
  sameSearchParams,
  searchHistoryStep as historyStep,
  type SearchParams,
} from "@tabverse/workbench/files/search-history";

const controller = createSearchHistoryController({
  load: () => loadState<unknown>(SEARCH_HISTORY_SCOPE),
  save: (value) => saveState(SEARCH_HISTORY_SCOPE, value),
  remove: () => deleteState(SEARCH_HISTORY_SCOPE),
  isFreshRun,
});

export const searchHistory = controller.load;
export const recordSearch = controller.record;
export const clearSearchHistory = controller.clear;
