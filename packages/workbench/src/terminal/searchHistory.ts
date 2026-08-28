export const SEARCH_HISTORY_LIMIT = 20;

const entries: string[] = [];

export function rememberTerminalSearch(query: string): void {
  const trimmed = query.trim();
  if (trimmed === "") return;
  const existing = entries.lastIndexOf(trimmed);
  if (existing !== -1) entries.splice(existing, 1);
  entries.push(trimmed);
  if (entries.length > SEARCH_HISTORY_LIMIT) entries.shift();
}

export function terminalSearchHistory(): readonly string[] {
  return [...entries];
}

export function resetTerminalSearchHistoryForTest(): void {
  entries.length = 0;
}

export {
  rememberTerminalSearch as rememberSearch,
  terminalSearchHistory as searchHistory,
  resetTerminalSearchHistoryForTest as resetSearchHistoryForTest,
};
