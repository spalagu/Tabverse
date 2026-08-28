import { describe, expect, it } from "vitest";
import {
  DOWNLOADS_MAX,
  mergeDownloadFinish,
  mergeDownloadStart,
  type DownloadEntry,
} from "./downloads";


const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);

describe("mergeDownloadStart", () => {
  it("prepends a downloading row with the file's name", () => {
    const one = mergeDownloadStart([], "/dl/report.pdf", "report.pdf", NOW);
    expect(one).toEqual([
      { path: "/dl/report.pdf", name: "report.pdf", at: NOW, state: "downloading" },
    ]);
    const two = mergeDownloadStart(one, "/dl/next.zip", "next.zip", NOW + 1);
    expect(two.map((e) => e.name)).toEqual(["next.zip", "report.pdf"]);
  });

  it("falls back to the path's last segment when no name came along", () => {
    const [e] = mergeDownloadStart([], "/dl/archive.tar.gz", "", NOW);
    expect(e.name).toBe("archive.tar.gz");
  });

  it("records nothing for an empty path", () => {
    const list: DownloadEntry[] = [];
    expect(mergeDownloadStart(list, "", "x", NOW)).toBe(list);
  });

  it("caps the ledger by dropping the oldest records", () => {
    let ledger: DownloadEntry[] = [];
    for (let i = 0; i < DOWNLOADS_MAX + 3; i++) {
      ledger = mergeDownloadStart(ledger, `/dl/f${i}`, `f${i}`, NOW + i);
    }
    expect(ledger).toHaveLength(DOWNLOADS_MAX);
    expect(ledger[0].name).toBe(`f${DOWNLOADS_MAX + 2}`);
    expect(ledger.some((e) => e.name === "f0")).toBe(false);
  });
});

describe("mergeDownloadFinish", () => {
  it("settles the running row for that path, in place", () => {
    const started = mergeDownloadStart([], "/dl/a.bin", "a.bin", NOW);
    const done = mergeDownloadFinish(started, "/dl/a.bin", true, NOW + 500);
    expect(done).toEqual([
      { path: "/dl/a.bin", name: "a.bin", at: NOW, state: "done" },
    ]);
  });

  it("marks a failure as failed, never as done", () => {
    const started = mergeDownloadStart([], "/dl/a.bin", "a.bin", NOW);
    const failed = mergeDownloadFinish(started, "/dl/a.bin", false, NOW + 500);
    expect(failed[0].state).toBe("failed");
  });

  it("settles only the matching path, leaving parallel downloads running", () => {
    let ledger = mergeDownloadStart([], "/dl/a.bin", "a.bin", NOW);
    ledger = mergeDownloadStart(ledger, "/dl/b.bin", "b.bin", NOW + 1);
    const settled = mergeDownloadFinish(ledger, "/dl/a.bin", true, NOW + 500);
    expect(settled.find((e) => e.path === "/dl/a.bin")?.state).toBe("done");
    expect(settled.find((e) => e.path === "/dl/b.bin")?.state).toBe(
      "downloading"
    );
  });

  it("does not resurrect an already-settled row for the same path", () => {
    const started = mergeDownloadStart([], "/dl/a.bin", "a.bin", NOW);
    const done = mergeDownloadFinish(started, "/dl/a.bin", true, NOW + 500);
    // A second finish for the same path (an engine echo) finds no running
    // row; it lands as its own settled record instead of flipping the first.
    const echoed = mergeDownloadFinish(done, "/dl/a.bin", false, NOW + 600);
    expect(echoed.find((e) => e.at === NOW)?.state).toBe("done");
  });

  it("records an unmatched finish rather than dropping it", () => {
    const settled = mergeDownloadFinish([], "/dl/lost.bin", true, NOW);
    expect(settled).toEqual([
      { path: "/dl/lost.bin", name: "lost.bin", at: NOW, state: "done" },
    ]);
  });

  it("leaves the input untouched (callers compare by identity)", () => {
    const started = mergeDownloadStart([], "/dl/a.bin", "a.bin", NOW);
    mergeDownloadFinish(started, "/dl/a.bin", true, NOW + 500);
    expect(started[0].state).toBe("downloading");
  });
});
