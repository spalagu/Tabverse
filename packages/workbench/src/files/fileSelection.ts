export interface FileSelectionState {
  selectedPaths: string[];
  selectionAnchor: string | null;
}

export function selectionToggled<T extends FileSelectionState>(
  state: T,
  path: string
): T {
  return {
    ...state,
    selectedPaths: state.selectedPaths.includes(path)
      ? state.selectedPaths.filter((selected) => selected !== path)
      : [...state.selectedPaths, path],
    selectionAnchor: path,
  };
}

export function selectionExtended<T extends FileSelectionState>(
  state: T,
  path: string,
  visible: readonly string[]
): T {
  const from = visible.indexOf(state.selectionAnchor ?? path);
  const to = visible.indexOf(path);
  if (from < 0 || to < 0) {
    return { ...state, selectedPaths: [path], selectionAnchor: path };
  }
  const [start, end] = from <= to ? [from, to] : [to, from];
  return { ...state, selectedPaths: visible.slice(start, end + 1) };
}

export function selectionAll<T extends FileSelectionState>(
  state: T,
  visible: readonly string[]
): T {
  return {
    ...state,
    selectedPaths: [...visible],
    selectionAnchor: visible[0] ?? null,
  };
}

export function selectionCleared<T extends FileSelectionState>(state: T): T {
  if (state.selectedPaths.length === 0 && state.selectionAnchor === null) {
    return state;
  }
  return { ...state, selectedPaths: [], selectionAnchor: null };
}

export function selectionLanded<T extends FileSelectionState>(
  state: T,
  landed: readonly string[]
): T {
  return {
    ...state,
    selectedPaths: [...landed],
    selectionAnchor: landed[landed.length - 1] ?? null,
  };
}
