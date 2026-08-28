import { type TerminalLink } from "@tabverse/workbench/terminal/links";
import { useStore } from "../state/store";

export * from "@tabverse/workbench/terminal/links";

/** Desktop Store adapter for terminal link landing behavior. */
export function openTerminalLink(
  link: TerminalLink,
  metaKey: boolean,
  shiftKey: boolean
): void {
  const st = useStore.getState();
  const from = st.activeTabId;
  const fromTab = from !== null ? st.tabs.find((tab) => tab.id === from) : undefined;

  if (metaKey) {
    openFresh(link);
    return;
  }

  if (shiftKey && (link.kind === "url" || link.kind === "path")) {
    if (link.kind === "url") {
      st.openPeek({ type: "browser", url: link.url });
    } else {
      st.openPeek({ type: "files", openPath: link.path });
    }
    return;
  }

  const neighbour =
    from !== null &&
    fromTab !== undefined &&
    st.split !== null &&
    st.split.ids.includes(from)
      ? st.split.ids
          .map((id) => st.tabs.find((tab) => tab.id === id))
          .find(
            (tab) =>
              tab !== undefined &&
              tab.id !== from &&
              tab.type === targetKind(link)
          )
      : undefined;
  if (neighbour !== undefined) {
    navigate(neighbour.id, link);
    useStore.setState({ activeTabId: neighbour.id });
    return;
  }

  const created = openFresh(link);
  if (fromTab?.type === "terminal" && from !== null) {
    useStore.getState().splitOnTab(created, from, "right");
  }
}

function targetKind(link: TerminalLink): "browser" | "files" {
  return link.kind === "url" ? "browser" : "files";
}

function openFresh(link: TerminalLink): string {
  if (link.kind === "url") {
    return useStore.getState().addTab({ type: "browser", url: link.url });
  }
  if (link.kind === "dir") {
    return useStore.getState().addTab({ type: "files", cwd: link.path });
  }
  return useStore.getState().revealPath(link.path, link.line);
}

function navigate(tabId: string, link: TerminalLink): void {
  const st = useStore.getState();
  if (link.kind === "url") {
    st.setTabUrl(tabId, link.url);
    return;
  }
  if (link.kind === "dir") {
    st.setTabCwd(tabId, link.path);
    return;
  }
  const tab = st.tabs.find((candidate) => candidate.id === tabId);
  st.setTabReveal(tabId, {
    path: link.path,
    ...(link.line !== undefined ? { line: link.line } : {}),
    nonce: (tab?.reveal?.nonce ?? 0) + 1,
  });
}

export function openDirectoryInFilesPane(cwd: string | undefined): void {
  if (cwd === undefined || cwd === "") return;
  openTerminalLink({ kind: "dir", path: cwd }, false, false);
}
