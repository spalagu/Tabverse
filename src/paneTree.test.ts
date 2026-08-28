import { describe, expect, it } from "vitest";
import {
  PANE_MIN_SHARE,
  isLeaf,
  layout,
  leaves,
  neighbor,
  paneTakingOver,
  paneTreeSnapshot,
  readPaneTree,
  removePane,
  resizePane,
  setPaneBoundary,
  splitPane,
  type PaneDir,
  type PaneId,
  type PaneNode,
  type PaneSplit,
} from "./paneTree";


// ------------------------------------------------------------- fixtures

const split = (
  id: string,
  vertical: boolean,
  ratios: number[],
  children: PaneNode[]
): PaneSplit => ({ kind: "split", id, vertical, ratios, children });

const pane = (id: string): PaneNode => ({ kind: "leaf", id });

/**
 * Figure 5's tree: a full-height column on the left, one pane top right, and
 * two side-by-side panes under it. Three levels, asymmetric on purpose.
 *
 *   ┌──────┬─────────────┐
 *   │      │      B      │
 *   │  A   ├──────┬──────┤
 *   │      │  C   │  D   │
 *   └──────┴──────┴──────┘
 *
 * B is given the taller share deliberately. With the halves even, "A's right
 * neighbour" is a TIE between B and C that only the tie-break settles, and a
 * criterion decided by a tie-break is a criterion that proves nothing.
 */
function figureFive(): PaneNode {
  return split("root", false, [0.4, 0.6], [
    pane("A"),
    split("mid", true, [0.7, 0.3], [
      pane("B"),
      split("bottom", false, [0.5, 0.5], [pane("C"), pane("D")]),
    ]),
  ]);
}

/**
 * The second shape, and the one that does the discriminating.
 *
 *   ┌─────────┬─────────┐
 *   │    A    │         │
 *   ├─────────┤    C    │
 *   │         │         │
 *   │    B    ├────┬────┤
 *   │         │ D  │ E  │
 *   └─────────┴────┴────┘
 *
 * Two facts about it are what figure 5's tree cannot show. B's right-hand
 * neighbour is D and not C, even though C is the first leaf of the subtree
 * beside B's; and C's left-hand neighbour is B and not A, even though A is
 * the first leaf of the subtree beside C's. An implementation that answers
 * "the sibling subtree's first pane" gets both of those backwards while
 * still passing every assertion made against figure 5's tree.
 */
function stackedPairs(): PaneNode {
  return split("root", false, [0.5, 0.5], [
    split("left", true, [0.2, 0.8], [pane("A"), pane("B")]),
    split("right", true, [0.5, 0.5], [
      pane("C"),
      split("rightBottom", false, [0.5, 0.5], [pane("D"), pane("E")]),
    ]),
  ]);
}

/** How many levels of split stand above the deepest leaf. */
function depth(node: PaneNode): number {
  if (isLeaf(node)) return 0;
  return 1 + Math.max(...node.children.map(depth));
}

/** The rectangle one pane occupies, for an assertion about the screen. */
function rectOf(tree: PaneNode, id: PaneId) {
  const r = layout(tree).find((x) => x.id === id);
  if (r === undefined) throw new Error(`no pane ${id}`);
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

/** A split node by id, so a shape assertion can name what it is looking at. */
function nodeOf(tree: PaneNode, id: PaneId): PaneNode {
  const walk = (n: PaneNode): PaneNode | null => {
    if (n.id === id) return n;
    if (isLeaf(n)) return null;
    for (const c of n.children) {
      const hit = walk(c);
      if (hit !== null) return hit;
    }
    return null;
  };
  const hit = walk(tree);
  if (hit === null) throw new Error(`no node ${id}`);
  return hit;
}

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);


describe(" — a direction jump lands on the geometric neighbour", () => {
  describe("figure 5's tree (column | stacked pair over a row)", () => {
    const tree = figureFive();

    it("goes right from the tall left column to the pane it faces most", () => {
      // B and C both touch A's right edge; B shares 0.7 of A's height and C
      // only 0.3, so the answer is B — and it is B for a reason the tree
      // cannot state, since A's sibling is an internal node and not a pane.
      expect(neighbor(tree, "A", "right")).toBe("B");
    });

    it("goes left out of a nested pane and lands on the column", () => {
      expect(neighbor(tree, "C", "left")).toBe("A");
    });

    it("goes up out of the bottom row into the pane above it", () => {
      expect(neighbor(tree, "C", "up")).toBe("B");
    });

    it("answers nothing at the window's edge", () => {
      expect(neighbor(tree, "D", "right")).toBeNull();
      expect(neighbor(tree, "A", "left")).toBeNull();
      expect(neighbor(tree, "B", "up")).toBeNull();
      expect(neighbor(tree, "D", "down")).toBeNull();
    });

    it("moves between the two panes of the bottom row", () => {
      expect(neighbor(tree, "C", "right")).toBe("D");
      expect(neighbor(tree, "D", "left")).toBe("C");
    });

    it("settles a genuine tie by reading order, not by rounding", () => {
      // B spans both panes below it, exactly half each. The answer has to be
      // the same on every tab with this shape, so the comparison carries the
      // rounding's width and the earlier pane keeps the tie — which is C.
      expect(neighbor(tree, "B", "down")).toBe("C");
    });
  });

  describe("a second three-level shape (two stacks, one of them nested)", () => {
    const tree = stackedPairs();

    it("crosses to the pane it actually faces, not the subtree's first", () => {
      // C is the first pane of the subtree to B's right and is NOT the
      // answer: B faces 0.3 of C and 0.5 of D. A tree walk says C here.
      expect(neighbor(tree, "B", "right")).toBe("D");
    });

    it("does the same going the other way", () => {
      // A is the first pane of the subtree to C's left and is NOT the
      // answer: C faces 0.2 of A and 0.3 of B. A tree walk says A here.
      expect(neighbor(tree, "C", "left")).toBe("B");
    });

    it("still gets the unambiguous ones right", () => {
      expect(neighbor(tree, "A", "right")).toBe("C");
      expect(neighbor(tree, "A", "down")).toBe("B");
      expect(neighbor(tree, "B", "up")).toBe("A");
      expect(neighbor(tree, "E", "up")).toBe("C");
      expect(neighbor(tree, "E", "left")).toBe("D");
      expect(neighbor(tree, "D", "right")).toBe("E");
      expect(neighbor(tree, "E", "right")).toBeNull();
      expect(neighbor(tree, "C", "up")).toBeNull();
    });

    it("knows nothing about a pane that is not in the tree", () => {
      expect(neighbor(tree, "Z", "left")).toBeNull();
    });
  });
});


describe(" — a pane leaving collapses what it empties", () => {
  it("replaces the emptied split with its survivor and merges the share up", () => {
    const before = figureFive();
    const after = removePane(before, "D");

    // Shape, not picture: a split left wrapping a single child fills its
    // parent's slot exactly, so every rectangle is the same either way and
    // only the nodes tell a collapse from a deletion.
    const mid = nodeOf(after, "mid") as PaneSplit;
    expect(mid.children.map((c) => c.kind)).toEqual(["leaf", "leaf"]);
    expect(mid.children[1].id).toBe("C");
    expect(isLeaf(mid.children[1])).toBe(true);

    // The share the collapsed split held is the survivor's now — the
    // grandparent's own distribution is untouched.
    expect(mid.ratios).toEqual([0.7, 0.3]);

    // One level shallower than it was, and "bottom" is gone entirely.
    expect(depth(before)).toBe(3);
    expect(depth(after)).toBe(2);
    expect(() => nodeOf(after, "bottom")).toThrow();

    expect(leaves(after)).toEqual(["A", "B", "C"]);
    // And C now occupies the whole slot the pair shared.
    expect(rectOf(after, "C")).toEqual({ x: 0.4, y: 0.7, w: 0.6, h: 0.3 });
  });

  it("keeps the other panes' proportions when a split loses one of three", () => {
    const tree = split("root", false, [0.5, 0.25, 0.25], [
      pane("A"),
      pane("B"),
      pane("C"),
    ]) as PaneNode;
    const after = removePane(tree, "B") as PaneSplit;
    expect(after.kind).toBe("split");
    expect(after.children.map((c) => c.id)).toEqual(["A", "C"]);
    // 0.5 : 0.25 kept as a proportion, re-normalized to sum to 1.
    close(after.ratios[0], 2 / 3);
    close(after.ratios[1], 1 / 3);
  });

  it("hands the whole tab back to the survivor of a two-pane split", () => {
    const tree = split("root", false, [0.5, 0.5], [pane("A"), pane("B")]);
    const after = removePane(tree, "B");
    expect(isLeaf(after)).toBe(true);
    expect(after.id).toBe("A");
  });

  it("never removes the last pane, and says so by identity", () => {
    const only = pane("A");
    // The same object, not merely an equal one: "nothing happened" is what
    // keeps a single-terminal tab on the pre-existing exit path — the
    // `Process exited` line written in place, the tab left open.
    expect(removePane(only, "A")).toBe(only);
  });

  it("leaves a tree alone when the pane is not in it", () => {
    const tree = figureFive();
    expect(removePane(tree, "Z")).toBe(tree);
  });

  it("names the survivor that took the room, not the first direction tried", () => {
    // A column on the left, and a pane closing on the right under another:
    // the room D gives up goes to C, which is beside it — while "look left
    // first" would hand the caret across the whole window to A, and "look
    // up first" would answer B. The rule is the space, so it is neither.
    const before = figureFive();
    expect(paneTakingOver(before, removePane(before, "D"), "D")).toBe("C");

    const stacked = split("root", false, [0.5, 0.5], [
      pane("A"),
      split("right", true, [0.5, 0.5], [pane("B"), pane("C")]),
    ]);
    expect(paneTakingOver(stacked, removePane(stacked, "C"), "C")).toBe("B");

    // Nothing to hand it to: the last pane never leaves, so the tree is
    // unchanged and the pane is still in it.
    const only = pane("A");
    expect(paneTakingOver(only, removePane(only, "A"), "A")).toBeNull();
    expect(paneTakingOver(before, before, "Z")).toBeNull();
  });
});

// ---------------------------------------------------------------- splits

describe("splitting", () => {
  it("halves the pane it is given", () => {
    const after = splitPane(pane("A"), "A", false, "B") as PaneSplit;
    expect(after.kind).toBe("split");
    expect(after.vertical).toBe(false);
    expect(after.ratios).toEqual([0.5, 0.5]);
    expect(leaves(after)).toEqual(["A", "B"]);
    expect(rectOf(after, "A")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(rectOf(after, "B")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it("three presses of the same key give four panes on ONE level", () => {
    // The nesting bug's signature: a naive implementation wraps every split
    // in another split, so the same three presses give 1/2, 1/4, 1/8, 1/8
    // down three levels instead of four equal columns.
    let tree: PaneNode = pane("A");
    tree = splitPane(tree, "A", false, "B");
    expect(leaves(tree)).toEqual(["A", "B"]);
    tree = splitPane(tree, "B", false, "C");
    expect(leaves(tree)).toEqual(["A", "B", "C"]);
    expect(depth(tree)).toBe(1);
    (tree as PaneSplit).ratios.forEach((r) => close(r, 1 / 3));

    tree = splitPane(tree, "C", false, "D");
    expect(leaves(tree)).toEqual(["A", "B", "C", "D"]);
    expect(depth(tree)).toBe(1);
    (tree as PaneSplit).ratios.forEach((r) => close(r, 0.25));
    expect(rectOf(tree, "C").x).toBeCloseTo(0.5, 9);
  });

  it("nests when the new split runs the other way", () => {
    let tree: PaneNode = pane("A");
    tree = splitPane(tree, "A", false, "B");
    tree = splitPane(tree, "B", true, "C");
    expect(depth(tree)).toBe(2);
    expect(leaves(tree)).toEqual(["A", "B", "C"]);
    expect(rectOf(tree, "B")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(rectOf(tree, "C")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("puts the new pane immediately after the one it came from", () => {
    let tree: PaneNode = pane("A");
    tree = splitPane(tree, "A", false, "B");
    tree = splitPane(tree, "B", false, "C");
    // Splitting A again puts the newcomer between A and B, not at the end.
    tree = splitPane(tree, "A", false, "D");
    expect(leaves(tree)).toEqual(["A", "D", "B", "C"]);
  });

  it("has no ceiling — the outer layer's four is not this layer's", () => {
    let tree: PaneNode = pane("p0");
    for (let i = 1; i < 12; i += 1) {
      tree = splitPane(tree, `p${i - 1}`, i % 2 === 0, `p${i}`);
    }
    expect(leaves(tree)).toHaveLength(12);
  });

  it("leaves the tree alone when the target is not one of its panes", () => {
    const tree = figureFive();
    expect(splitPane(tree, "Z", false, "N")).toBe(tree);
  });
});

// ---------------------------------------------------------------- layout

describe("layout", () => {
  it("tiles the whole area exactly once", () => {
    const rects = layout(figureFive());
    expect(rects.map((r) => r.id)).toEqual(["A", "B", "C", "D"]);
    close(
      rects.reduce((sum, r) => sum + r.w * r.h, 0),
      1
    );
    expect(rectOf(figureFive(), "D")).toEqual({
      x: 0.7,
      y: 0.7,
      w: 0.3,
      h: 0.3,
    });
  });

  it("falls back to even shares for a distribution that cannot be used", () => {
    const broken = split("root", false, [Number.NaN, 3], [pane("A"), pane("B")]);
    expect(rectOf(broken, "A").w).toBeCloseTo(0.5, 9);
  });
});

// ---------------------------------------------------------------- resize

describe("resizing", () => {
  it("moves the seam between the pane and its neighbour that way", () => {
    const tree = splitPane(pane("A"), "A", false, "B");
    const wider = resizePane(tree, "A", "right", 0.1) as PaneSplit;
    close(wider.ratios[0], 0.6);
    close(wider.ratios[1], 0.4);
    // Nothing outside the pair moves: the two shares still sum to what they
    // summed to before.
    close(wider.ratios[0] + wider.ratios[1], 1);
  });

  it("shrinks the pane when the direction points the other way", () => {
    const tree = splitPane(pane("A"), "A", false, "B");
    const narrower = resizePane(tree, "B", "left", 0.1) as PaneSplit;
    // B is the second child, so growing it leftward takes from A.
    close(narrower.ratios[0], 0.4);
    close(narrower.ratios[1], 0.6);
  });

  it("finds the seam on an ancestor when the parent runs the other way", () => {
    const tree = figureFive();
    // C's parent is the bottom row (side by side); "up" has to travel to
    // `mid`, whose boundary is the one C leans against.
    const after = resizePane(tree, "C", "up", 0.1);
    const mid = nodeOf(after, "mid") as PaneSplit;
    close(mid.ratios[0], 0.6);
    close(mid.ratios[1], 0.4);
  });

  it("stops at the minimum share instead of squeezing a pane out", () => {
    let tree: PaneNode = splitPane(pane("A"), "A", false, "B");
    for (let i = 0; i < 40; i += 1) tree = resizePane(tree, "A", "right", 0.1);
    const root = tree as PaneSplit;
    close(root.ratios[1], PANE_MIN_SHARE);
    close(root.ratios[0], 1 - PANE_MIN_SHARE);
  });

  it("does nothing at the window edge, and says so by identity", () => {
    const tree = figureFive();
    expect(resizePane(tree, "D", "right", 0.1)).toBe(tree);
    expect(resizePane(tree, "A", "left", 0.1)).toBe(tree);
    expect(resizePane(tree, "Z", "left", 0.1)).toBe(tree);
  });

  it("puts a dragged divider where it was dropped, pair-local", () => {
    const tree = split("root", false, [0.25, 0.25, 0.5], [
      pane("A"),
      pane("B"),
      pane("C"),
    ]) as PaneNode;
    const after = setPaneBoundary(tree, "root", 0, 0.4) as PaneSplit;
    close(after.ratios[0], 0.4);
    close(after.ratios[1], 0.1);
    // The third pane is untouched — a drag moves one seam, not the layout.
    close(after.ratios[2], 0.5);
  });

  it("clamps a divider dragged past the minimum", () => {
    const tree = splitPane(pane("A"), "A", false, "B");
    const after = setPaneBoundary(tree, tree.id, 0, 0.99) as PaneSplit;
    close(after.ratios[1], PANE_MIN_SHARE);
  });
});

// ------------------------------------------------------------ persistence

describe("what survives a restart", () => {
  it("keeps the shape and the directories, and drops the sessions", () => {
    const tree = split("root", false, [0.5, 0.5], [
      { kind: "leaf", id: "A", termId: "pty-1", cwd: "/one" },
      { kind: "leaf", id: "B", termId: "pty-2", cwd: "/two" },
    ]);
    const saved = paneTreeSnapshot(tree);
    expect(leaves(saved)).toEqual(["A", "B"]);
    // The shell died with the app; where it stood is what comes back.
    expect((saved as PaneSplit).children.every((c) => !("termId" in c))).toBe(true);
    expect((saved as PaneSplit).children.map((c) => (c as { cwd?: string }).cwd))
      .toEqual(["/one", "/two"]);
  });

  it("refuses to read a dead session id back out of a file", () => {
    const read = readPaneTree(
      split("root", false, [0.5, 0.5], [
        { kind: "leaf", id: "A", termId: "pty-1", cwd: "/one" },
        { kind: "leaf", id: "B" },
      ])
    ) as PaneSplit;
    expect(read.children[0]).toEqual({ kind: "leaf", id: "A", cwd: "/one" });
  });

  it("reads a stored tree back, and refuses one that is not a tree", () => {
    const stored = JSON.parse(JSON.stringify(figureFive()));
    const read = readPaneTree(stored);
    expect(read).not.toBeNull();
    expect(leaves(read as PaneNode)).toEqual(["A", "B", "C", "D"]);

    expect(readPaneTree(null)).toBeNull();
    expect(readPaneTree(undefined)).toBeNull();
    expect(readPaneTree({ kind: "split", id: "r", children: [] })).toBeNull();
    expect(readPaneTree({ kind: "leaf" })).toBeNull();
    // One leaf IS a tree here: it is what every pane but one exiting leaves
    // behind, and refusing it would file that pane's directory and screen
    // under a name nothing looks for after a restart.
    expect(readPaneTree({ kind: "leaf", id: "A", cwd: "/one" })).toEqual({
      kind: "leaf",
      id: "A",
      cwd: "/one",
    });
    // Two panes on one id would share a screen-memory file and a registry
    // entry; a hand-edited file must degrade to a single terminal instead.
    expect(
      readPaneTree(
        split("root", false, [0.5, 0.5], [pane("A"), pane("A")])
      )
    ).toBeNull();
  });
});

// --------------------------------------------------------- exhaustiveness

describe("every direction is answered by the same rule", () => {
  const DIRS: PaneDir[] = ["left", "right", "up", "down"];

  it("agrees with itself: the neighbour's neighbour comes back", () => {
    const opposite: Record<PaneDir, PaneDir> = {
      left: "right",
      right: "left",
      up: "down",
      down: "up",
    };
    for (const tree of [figureFive(), stackedPairs()]) {
      for (const id of leaves(tree)) {
        for (const dir of DIRS) {
          const there = neighbor(tree, id, dir);
          if (there === null) continue;
          // Not always the pane we started from — the facing pane may be
          // wider — but always a pane that touches it back.
          const back = neighbor(tree, there, opposite[dir]);
          expect(back, `${id} → ${dir} → ${there} → ${opposite[dir]}`).not.toBeNull();
        }
      }
    }
  });
});
