import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InputLine,
  completionFor,
  completionSpecSource,
  completionSpecVersion,
  loadCompletionSpec,
  parseSpec,
  resetCompletionSpecForTest,
  snapshotVersion,
} from "./completionSpec";
import { bracketedPaste } from "./pasteGuard";


vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const { invoke } = await import("@tauri-apps/api/core");
const invokeMock = vi.mocked(invoke);

const w = () => window as unknown as Record<string, unknown>;

/** A one-command spec, distinct from anything the snapshot ships. */
const stateSpecText = JSON.stringify({
  version: "2099-12-31",
  commands: [
    { name: "zzfancy", flags: [{ name: "--zz", takesValue: false }] },
  ],
  files: { patterns: ["~/"], extensions: [".zz"] },
});

beforeEach(() => {
  resetCompletionSpecForTest();
  delete w().__TAURI_INTERNALS__;
  invokeMock.mockReset();
});

describe("the load order: state directory over the shipped snapshot", () => {
  it("answers from the state copy when one exists", async () => {
    w().__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(stateSpecText);

    const spec = await loadCompletionSpec();

    expect(invokeMock).toHaveBeenCalledWith("completions_get");
    expect(completionSpecVersion(), "the directory's version").toBe("2099-12-31");
    expect(completionSpecSource()).toBe("state");
    expect(spec?.commands.map((c) => c.name)).toEqual(["zzfancy"]);
  });

  it("falls back to the bundled snapshot when no copy was ever written", async () => {
    w().__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(null);

    const spec = await loadCompletionSpec();

    expect(completionSpecSource()).toBe("snapshot");
    expect(completionSpecVersion()).toBe(snapshotVersion());
    // The real snapshot, not a stand-in: it knows real commands.
    expect(spec?.commands.some((c) => c.name === "git")).toBe(true);
  });

  it("falls THROUGH to the snapshot when the state copy cannot be parsed", async () => {
    w().__TAURI_INTERNALS__ = {};
    // Valid JSON, wrong shape — the shape gate must skip it, not crash.
    invokeMock.mockResolvedValue(JSON.stringify({ hello: "world" }));

    await loadCompletionSpec();

    expect(completionSpecSource()).toBe("snapshot");
  });

  it("a browser demo with no core at all runs on the snapshot", async () => {
    // No __TAURI_INTERNALS__: readStateSpec answers null before any invoke.
    const spec = await loadCompletionSpec();
    expect(completionSpecSource()).toBe("snapshot");
    expect(spec).not.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("the cache and its version comparison", () => {
  it("a forced re-read adopts a newer directory copy", async () => {
    w().__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(stateSpecText);
    await loadCompletionSpec();

    invokeMock.mockResolvedValue(
      JSON.stringify({ ...JSON.parse(stateSpecText), version: "2100-01-01" })
    );
    const spec = await loadCompletionSpec(true);

    expect(completionSpecVersion()).toBe("2100-01-01");
    expect(spec?.version).toBe("2100-01-01");
  });

  it("a forced re-read of the SAME version keeps the cached object", async () => {
    w().__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(stateSpecText);
    const first = await loadCompletionSpec();

    const again = await loadCompletionSpec(true);

    // Same version, same source: nothing worth re-adopting, and the
    // identity is the observable of that decision.
    expect(again).toBe(first);
  });
});

describe("parseSpec's shape bar", () => {
  it("refuses what it cannot ask anything of", () => {
    expect(parseSpec("nope")).toBeNull();
    expect(parseSpec(null)).toBeNull();
    expect(parseSpec({})).toBeNull();
    expect(parseSpec({ version: "" })).toBeNull();
    expect(parseSpec({ version: "1" })).toBeNull();
  });

  it("accepts a minimal document and keeps unknown leaves out", () => {
    const spec = parseSpec({
      version: "2026-08-17",
      commands: [
        { name: "one", flags: [{ name: "--x", takesValue: true, junk: 1 }] },
        "not a command",
      ],
      files: { patterns: ["~/"], extensions: [] },
    });
    expect(spec?.commands).toHaveLength(1);
    expect(spec?.commands[0].flags[0]).toEqual({
      name: "--x",
      takesValue: true,
    });
    expect(spec?.files.patterns).toEqual(["~/"]);
  });
});

describe("the typing model (InputLine)", () => {
  it("appends printables, drops on backspace, clears on Return", () => {
    const line = new InputLine();
    line.push("git ch");
    line.push("eck");
    expect(line.text).toBe("git check");
    line.push("\x7f\x7f");
    expect(line.text).toBe("git che");
    line.push("\r");
    expect(line.text).toBe("");
  });

  it("ignores control characters a line does not hold", () => {
    const line = new InputLine();
    line.push("gi");
    line.push("\x1b[A"); // an arrow key's escape sequence
    line.push("t");
    expect(line.text).toBe("git");
  });

  it("a bracketed paste resets the model — it is not typing", () => {
    const line = new InputLine();
    line.push("git che");
    const after = line.push(bracketedPaste("cargo build\ncargo test"));
    expect(after).toBe("");
    expect(line.text).toBe("");
  });
});

describe("the detection (completionFor)", () => {
  const spec = parseSpec(JSON.parse(stateSpecText))!;

  it("offers the command's flags when the first word names it", () => {
    expect(completionFor("zzfancy --", spec)).toEqual({
      kind: "flags",
      command: "zzfancy",
      word: "--",
      items: ["--zz"],
    });
    // A partial flag narrows the list to what starts with it.
    expect(completionFor("zzfancy --z", spec)?.kind).toBe("flags");
    expect(completionFor("zzfancy --q", spec)).toBeNull();
  });

  it("offers nothing for a command the spec never heard of", () => {
    expect(completionFor("notacommand --", spec)).toBeNull();
  });

  it("offers nothing for a plain word and for an empty one", () => {
    expect(completionFor("zzfancy check", spec)).toBeNull();
    expect(completionFor("", spec)).toBeNull();
  });

  it("keeps path-shaped words silent until file completion is implemented", () => {
    expect(completionFor("cat ~/Docum", spec)).toBeNull();
  });

  it("offers nothing without a spec at all", () => {
    expect(completionFor("git --", null)).toBeNull();
  });
});
