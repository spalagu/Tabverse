import { describe, expect, it } from "vitest";
import type { PaneNode } from "./paneTree";
import {
  captureTemplate,
  instantiateTemplate,
  templateLeaves,
  updateTemplateLeaf,
  type ConfigTemplate,
} from "./terminalTemplates";

const DECLARED: ConfigTemplate = {
  name: "work",
  tree: {
    kind: "split",
    vertical: false,
    ratios: [0.6, 0.4],
    children: [
      { kind: "leaf", profile: "code", cwd: "/work/app" },
      {
        kind: "split",
        vertical: true,
        children: [
          { kind: "leaf", cwd: "/work/logs" },
          {
            kind: "leaf",
            profile: "ops",
            cwd: "/work",
            run_on_start: "make watch",
          },
        ],
      },
    ],
  },
};

function ids() {
  let next = 0;
  return () => `fresh-${++next}`;
}

describe("instantiating a layout template", () => {
  it("keeps the declared shape and gives every live node an identity", () => {
    const tree = instantiateTemplate(DECLARED.tree, "tab-1", ids());
    expect(tree).toEqual({
      kind: "split",
      id: "fresh-4",
      vertical: false,
      ratios: [0.6, 0.4],
      children: [
        {
          kind: "leaf",
          id: "tab-1",
          profile: "code",
          cwd: "/work/app",
        },
        {
          kind: "split",
          id: "fresh-3",
          vertical: true,
          ratios: [0.5, 0.5],
          children: [
            { kind: "leaf", id: "fresh-1", cwd: "/work/logs" },
            {
              kind: "leaf",
              id: "fresh-2",
              profile: "ops",
              cwd: "/work",
              runOnStart: "make watch",
            },
          ],
        },
      ],
    });
  });

  it("normalizes declared ratios rather than changing the shape", () => {
    const tree = instantiateTemplate(
      {
        kind: "split",
        vertical: true,
        ratios: [2, 1],
        children: [{ kind: "leaf" }, { kind: "leaf" }],
      },
      "tab-1",
      ids()
    );
    expect(tree.kind).toBe("split");
    if (tree.kind === "split") expect(tree.ratios).toEqual([2 / 3, 1 / 3]);
  });
});

describe("capturing a live layout", () => {
  it("keeps shape, cwd and profile but leaves every command blank", () => {
    const live: PaneNode = {
      kind: "split",
      id: "split-live",
      vertical: true,
      ratios: [0.5, 0.5],
      children: [
        {
          kind: "leaf",
          id: "tab-1",
          cwd: "/one",
          profile: "code",
          runOnStart: "must not be guessed",
          termId: "pty-1",
        },
        {
          kind: "leaf",
          id: "pane-2",
          cwd: "/two",
          termId: "pty-2",
        },
      ],
    };
    const saved = captureTemplate("saved", live, { profile: "fallback" });
    expect(saved).toEqual({
      name: "saved",
      tree: {
        kind: "split",
        vertical: true,
        ratios: [5000, 5000],
        children: [
          { kind: "leaf", profile: "code", cwd: "/one" },
          { kind: "leaf", profile: "fallback", cwd: "/two" },
        ],
      },
    });
    expect(templateLeaves(saved.tree).every(({ leaf }) => leaf.run_on_start === undefined)).toBe(
      true
    );
  });
});

describe("editing one template leaf", () => {
  it("changes its launch fields without flattening the tree", () => {
    const leaves = templateLeaves(DECLARED.tree);
    expect(leaves.map(({ path }) => path)).toEqual([[0], [1, 0], [1, 1]]);
    const changed = updateTemplateLeaf(DECLARED.tree, leaves[1].path, {
      profile: "logs",
      run_on_start: "tail -f app.log",
    });
    expect(changed.kind).toBe("split");
    expect(templateLeaves(changed)[1].leaf).toEqual({
      kind: "leaf",
      cwd: "/work/logs",
      profile: "logs",
      run_on_start: "tail -f app.log",
    });
    expect(templateLeaves(changed)[0].leaf).toBe(leaves[0].leaf);
  });
});
