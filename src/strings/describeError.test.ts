import { describe, expect, it } from "vitest";
import {
  ERROR_PATTERNS,
  ansiErrorLines,
  describeError,
  describeSessionEnd,
  errorText,
} from "./errors";
import { STR } from "./index";

const ROW_SAMPLES: Array<{ id: string; sample: string; next: string }> = [
  {
    id: "permission",
    sample: "EACCES: permission denied, open '/etc/hosts'",
    next:
      "You don't have permission for this file or folder. Check its " +
      "ownership, or pick another location.",
  },
  {
    id: "missing",
    sample: "ENOENT: no such file or directory, stat '/tmp/gone'",
    next: "It may have been moved or deleted. Refresh and try again.",
  },
  {
    id: "exists",
    sample: "EEXIST: file already exists, mkdir '/tmp/dup'",
    next: "Something with this name already exists. Pick another name.",
  },
  {
    id: "no-space",
    sample: "ENOSPC: no space left on device, write",
    next: "The disk is full. Free up some space and try again.",
  },
  {
    id: "read-only",
    sample: "EROFS: read-only file system, unlink '/Volumes/dmg/a'",
    next: "This location is read-only. Save a copy somewhere else instead.",
  },
  {
    id: "busy",
    sample: "EBUSY: resource busy or locked, rmdir '/tmp/held'",
    next: "Another program is using it. Close that program and try again.",
  },
  {
    id: "timeout",
    sample: "connect ETIMEDOUT 203.0.113.9:443",
    next:
      "It took too long. Try again — if this keeps happening, check the " +
      "connection.",
  },
  {
    id: "refused",
    sample: "connect ECONNREFUSED 127.0.0.1:8443",
    next:
      "The connection was refused. Check the address, and whether the " +
      "service is running.",
  },
  {
    id: "offline",
    sample: "network is unreachable: relay dial failed",
    next: "This machine looks offline. Check the network connection.",
  },
  {
    id: "bad-regex",
    sample: "regex parse error:\n    (foo\n    ^\nerror: unclosed group",
    next:
      "The search pattern isn't a valid regular expression. Escape special " +
      "characters like ( or [.",
  },
];

describe("describeError mapping table", () => {
  it("covers every table row with a sample", () => {
    // A row added to the table without a sample here is a hole in the lock.
    expect(ROW_SAMPLES.map((r) => r.id)).toEqual(ERROR_PATTERNS.map((p) => p.id));
  });

  for (const row of ROW_SAMPLES) {
    it(`row ${row.id}: sample maps to its next step`, () => {
      const d = describeError(new Error(row.sample), STR.errors.actions.saveFile);
      expect(d.title).toBe("Couldn't save the file.");
      expect(d.next).toBe(row.next);
      expect(d.detail).toContain(row.sample.split("\n")[0]);
    });
  }

  it("keeps the raw string out of the title, always", () => {
    for (const row of ROW_SAMPLES) {
      const d = describeError(row.sample, STR.errors.actions.openFile);
      expect(d.title).toBe("Couldn't open the file.");
      expect(d.title).not.toContain(row.sample.slice(0, 12));
    }
  });

  it("matches first hit in table order", () => {
    // A message hitting both "permission" (row 1) and "missing" (row 2)
    // takes row 1 — the table is ordered, first match wins.
    const d = describeError(
      "permission denied: no such file",
      STR.errors.actions.openFile
    );
    expect(d.next).toBe(ROW_SAMPLES[0].next);
  });

  it("falls back to title + detail only, next omitted", () => {
    const d = describeError(
      "Something inscrutable happened",
      STR.errors.actions.startShell
    );
    expect(d.title).toBe("Couldn't start the shell.");
    expect(d.next).toBeUndefined();
    expect(d.detail).toBe("Something inscrutable happened");
  });
});

describe("describeSessionEnd", () => {
  it("maps the three deliberate host reasons to human lines", () => {
    expect(describeSessionEnd("host stopped sharing")).toEqual({
      line: STR.remote.endedStopped,
    });
    expect(describeSessionEnd("removed by host")).toEqual({
      line: STR.remote.endedKicked,
    });
    expect(describeSessionEnd("ticket expired")).toEqual({
      line: STR.remote.endedExpired,
    });
  });

  it("keeps an unmapped reason as detail under the generic line", () => {
    expect(describeSessionEnd("viewer fell too far behind")).toEqual({
      line: STR.remote.endedGeneric,
      detail: "viewer fell too far behind",
    });
  });
});

describe("terminal rendering and helpers", () => {
  it("ansiErrorLines: red title, plain next, dim detail", () => {
    const out = ansiErrorLines({
      title: "Couldn't start the shell.",
      next: "Check the shell in Settings.",
      detail: "spawn /bin/zzz ENOENT",
    });
    expect(out).toContain("\x1b[31mCouldn't start the shell.\x1b[0m");
    expect(out).toContain("\r\nCheck the shell in Settings.");
    expect(out).toContain("\x1b[90mspawn /bin/zzz ENOENT\x1b[0m");
    // The raw string never precedes the title.
    expect(out.indexOf("Couldn't")).toBeLessThan(out.indexOf("ENOENT"));
  });

  it("errorText stringifies like String(e)", () => {
    expect(errorText(new Error("boom"))).toBe("Error: boom");
    expect(errorText("plain")).toBe("plain");
  });
});
