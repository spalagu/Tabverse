import { describe, expect, it } from "vitest";
import type { FsEntry } from "../../backend/fs";
import {
  applyCompletion,
  completeDirs,
  normalizePath,
  resolveLocInput,
  segmentCandidates,
} from "./locInput";
import { RECENT_PATHS_MAX, mergeRecentPath } from "./recentPaths";


const e = (name: string, isDir: boolean): FsEntry => ({
  name,
  path: `/x/${name}`,
  isDir,
  isSymlink: false,
  size: 0,
  modified: 0,
  git: null,
  gitFromChildren: false,
});

describe("resolveLocInput", () => {
  it("resolves a relative name against the tree's root, dots and all", () => {
    expect(resolveLocInput("src", "/work/project")).toBe("/work/project/src");
    expect(resolveLocInput("./src", "/work/project")).toBe("/work/project/src");
    expect(resolveLocInput("src/../lib", "/work/project")).toBe(
      "/work/project/lib"
    );
    expect(resolveLocInput("src//deep", "/work/project")).toBe(
      "/work/project/src/deep"
    );
    expect(resolveLocInput("../other", "/work/project")).toBe("/work/other");
  });

  it("absolute inputs pass through untouched — the tree lists what it is given", () => {
    expect(resolveLocInput("/etc", "/work")).toBe("/etc");
    expect(resolveLocInput("//double//slash/", "/work")).toBe(
      "//double//slash/"
    );
  });

  it("a ~ input passes through for the backend to expand", () => {
    expect(resolveLocInput("~/Documents", "/work")).toBe("~/Documents");
    expect(resolveLocInput("~", "/work")).toBe("~");
  });

  it("an empty input stays empty — the caller decides what nothing means", () => {
    expect(resolveLocInput("", "/work")).toBe("");
    expect(resolveLocInput("   ", "/work")).toBe("");
  });
});

describe("normalizePath", () => {
  it("resolves dots and collapses slashes into a clean absolute path", () => {
    expect(normalizePath("/a/./b/../c")).toBe("/a/c");
    expect(normalizePath("//a//b")).toBe("/a/b");
    expect(normalizePath("/a/b/..")).toBe("/a");
    expect(normalizePath("..")).toBe("/");
  });
});

describe("segmentCandidates", () => {
  it("splits the typed value at its last slash, relative to the root", () => {
    expect(segmentCandidates("/work/pro", "/root")).toEqual({
      dir: "/work",
      partial: "pro",
    });
    expect(segmentCandidates("sr", "/work/project")).toEqual({
      dir: "/work/project",
      partial: "sr",
    });
  });

  it("an empty partial completes everything in the directory", () => {
    expect(segmentCandidates("/work/", "/root")).toEqual({
      dir: "/work",
      partial: "",
    });
  });
});

describe("completeDirs", () => {
  it("offers folders whose names continue the typing, case-blind", () => {
    const entries = [
      e("src", true),
      e("SRC-Backup", true),
      e("srv", true),
      e("sr.txt", false),
      e("other", true),
    ];
    const got = completeDirs(entries, "sr");
    expect(got.map((x) => x.name)).toEqual(["src", "SRC-Backup", "srv"]);
  });

  it("an empty partial offers every folder", () => {
    const entries = [e("a", true), e("b.txt", false), e("c", true)];
    expect(completeDirs(entries, "").map((x) => x.name)).toEqual(["a", "c"]);
  });
});

describe("applyCompletion", () => {
  it("writes the folder into the segment being completed, slash behind it", () => {
    expect(applyCompletion("/work/pro", "project", true)).toBe("/work/project/");
    expect(applyCompletion("/work/", "src", true)).toBe("/work/src/");
    expect(applyCompletion("~/Doc", "Documents", true)).toBe("~/Documents/");
    expect(applyCompletion("/work/fi", "file.txt", false)).toBe("/work/file.txt");
  });
});

describe("mergeRecentPath", () => {
  it("moves a repeat to the front and drops the oldest past the cap", () => {
    const many = Array.from({ length: RECENT_PATHS_MAX }, (_, i) => `/d${i}`);
    const jumped = mergeRecentPath(many, "/d0");
    expect(jumped[0]).toBe("/d0");
    // A repeat re-orders without growing or dropping anything.
    expect(jumped).toHaveLength(RECENT_PATHS_MAX);
    expect(jumped.filter((p) => p === "/d0")).toHaveLength(1);
    const fresh = mergeRecentPath(many, "/new");
    expect(fresh[0]).toBe("/new");
    expect(fresh).toHaveLength(RECENT_PATHS_MAX);
    // The oldest fell off to make room.
    expect(fresh).not.toContain("/d19");
  });

  it("ignores blank input without touching the list", () => {
    const list = ["/a", "/b"];
    expect(mergeRecentPath(list, "   ")).toEqual(list);
  });
});
