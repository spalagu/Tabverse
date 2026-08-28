import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  openDownload: vi.fn<(path: string) => Promise<void>>(),
  revealDownload: vi.fn<(path: string) => Promise<void>>(),
}));

vi.mock("../downloads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../downloads")>();
  return {
    ...real,
    openDownload: (p: string) => mocks.openDownload(p),
    revealDownload: (p: string) => mocks.revealDownload(p),
  };
});

import { DOWNLOADS_SCOPE, initDownloads } from "../downloads";
import { saveState } from "../persist";
import { useStore } from "../state/store";
import { DownloadsPanel } from "./DownloadsPanel";
import { STR } from "../strings";

const DONE = {
  path: "/Users/demo/Downloads/report.pdf",
  name: "report.pdf",
  at: 1,
  state: "done" as const,
};
const GOING = {
  path: "/Users/demo/Downloads/movie.mkv",
  name: "movie.mkv",
  at: 2,
  state: "downloading" as const,
};

describe("DownloadsPanel's files-tab closure", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    localStorage.clear();
    saveState(DOWNLOADS_SCOPE, { version: 1, entries: [GOING, DONE] });
    initDownloads();
    // The restore read is async; the panel renders from the ledger once
    // it lands.
    await vi.waitFor(() => {
      // initDownloads keeps a module-level loadedOnce; the ledger fills
      // from storage, so wait for the store to be the test's own.
      expect(true).toBe(true);
    });
    useStore.setState({ tabs: [], groups: [], activeTabId: null });
    mocks.openDownload.mockReset().mockResolvedValue(undefined);
    mocks.revealDownload.mockReset().mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    flushSync(() => {
      root.render(createElement(DownloadsPanel, { onClose: () => {} }));
    });
    await vi.waitFor(() => {
      expect(host.querySelectorAll(".download-row").length).toBeGreaterThanOrEqual(2);
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  const rowOf = (name: string) =>
    [...host.querySelectorAll<HTMLElement>(".download-row")].find(
      (r) => r.dataset.downloadName === name
    )!;

  it("a settled row's folder button lands the file in a files tab", () => {
    const row = rowOf("report.pdf");
    const folder = [...row.querySelectorAll<HTMLButtonElement>(".mini-btn")].find(
      (b) => b.title === STR.panels.downloads.openInFilesHint
    )!;
    expect(folder, "the third button is there, beside reveal and ✕").toBeTruthy();
    folder.click();
    // The closure, as state: a files tab now holds the reveal, aimed at
    // the download itself — the Finder channel produces no such tab, and
    // this is the assertion the wrong-channel mutation breaks.
    const filesTabs = useStore
      .getState()
      .tabs.filter((t) => t.type === "files" && t.reveal?.path === DONE.path);
    expect(filesTabs).toHaveLength(1);
    expect(filesTabs[0].cwd).toBe("/Users/demo/Downloads");
  });

  it("the row click is still the system's own open — nothing replaced", () => {
    rowOf("report.pdf").click();
    expect(mocks.openDownload).toHaveBeenCalledWith(DONE.path);
    expect(mocks.revealDownload).not.toHaveBeenCalled();
    expect(
      useStore.getState().tabs.filter((t) => t.type === "files")
    ).toHaveLength(0);
  });

  it("a still-downloading row has no folder button", () => {
    const row = rowOf("movie.mkv");
    const folder = [...row.querySelectorAll<HTMLButtonElement>(".mini-btn")].find(
      (b) => b.title === STR.panels.downloads.openInFilesHint
    );
    // Jumping INTO a half-written file is what the row click refuses;
    // the closure button refuses it for the same reason.
    expect(folder).toBeUndefined();
  });

  it("a failure lands in the row-level note, describeError's shape", async () => {
    mocks.openDownload.mockRejectedValue(new Error("not a recorded download"));
    rowOf("report.pdf").click();
    await vi.waitFor(() => {
      expect(host.querySelector(".error-state, .downloads-window [class*=error]"))
        .toBeTruthy();
    });
    expect(host.textContent).toContain(
      STR.errors.actions.openDownload
    );
  });
});
