
export type PaneId = string;

export interface PaneLeaf {
  kind: "leaf";
  id: PaneId;
  termId?: string;
  /** Detached resident helper session to attach when this pane mounts. */
  attachSessionId?: string;
  cwd?: string;
  /** The profile this pane opens under; absent falls back to the tab's. */
  profile?: string;
  /** One command this pane asks the core to run when its shell starts. */
  runOnStart?: string;
}

/**
 * A row or a column of panes.
 *
 * `vertical` names the AXIS THE CHILDREN ARE STACKED ALONG, the same word
 * with the same meaning as `SplitGroup.vertical` in the store: true means
 * the children run top to bottom, false means left to right. It does NOT
 * mean "the divider looks vertical" — iTerm2's ⌘D ("Split Vertically")
 * produces panes side by side, which is `vertical: false` here, and the two
 * readings are the reason this comment exists.
 *
 * `ratios` runs parallel to `children` and sums to 1.
 */
export interface PaneSplit {
  kind: "split";
  id: PaneId;
  vertical: boolean;
  ratios: number[];
  children: PaneNode[];
}

export type PaneNode = PaneLeaf | PaneSplit;

/** Which way a jump or a resize goes. */
export type PaneDir = "left" | "right" | "up" | "down";

/** Where one pane sits, normalized to the tab's content rectangle (0–1). */
export interface PaneRect {
  id: PaneId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The least share one pane may keep when a divider moves — the same figure
 * the outer layer uses (`SPLIT_MIN_SHARE`), restated rather than imported
 * because this module depends on nothing. A pane below this is a pane whose
 * grid has no room for a prompt.
 */
export const PANE_MIN_SHARE = 0.1;

/** How much one press of the resize key moves a boundary. */
export const PANE_RESIZE_STEP = 0.05;

/**
 * Rectangles tile exactly, so "these two edges touch" and "these two
 * rectangles overlap" are exact comparisons up to the error of dividing by
 * a sum. This is that error's ceiling, not a tolerance for sloppy geometry.
 */
const EPS = 1e-6;

// ------------------------------------------------------------------ shape

export function isLeaf(node: PaneNode): node is PaneLeaf {
  return node.kind === "leaf";
}

/** A fresh leaf. Ids come from the caller so tests can name their panes. */
export function leaf(id: PaneId, cwd?: string): PaneLeaf {
  return cwd === undefined ? { kind: "leaf", id } : { kind: "leaf", id, cwd };
}

/** The directory one pane should open in, or undefined for the tab's own. */
export function paneCwd(tree: PaneNode, id: PaneId): string | undefined {
  return findLeaf(tree, id)?.cwd;
}

/** Even shares for n children — what a fresh split and every insert take. */
function evenRatios(n: number): number[] {
  return n > 0 ? new Array(n).fill(1 / n) : [];
}

/**
 * Ratios coerced to a usable distribution: right length, all positive,
 * summing to 1. A tree read back from a session file goes through this, so a
 * corrupt ratio can never make a pane vanish or overflow its axis.
 */
function normalize(ratios: number[] | undefined, n: number): number[] {
  if (n <= 0) return [];
  const usable =
    ratios !== undefined &&
    ratios.length === n &&
    ratios.every((r) => Number.isFinite(r) && r > 0);
  const raw = usable ? ratios.slice() : evenRatios(n);
  const sum = raw.reduce((a, b) => a + b, 0);
  return sum > 0 ? raw.map((r) => r / sum) : evenRatios(n);
}

/** Every leaf id, in the order the children run — the reading order. */
export function leaves(tree: PaneNode): PaneId[] {
  if (isLeaf(tree)) return [tree.id];
  const out: PaneId[] = [];
  for (const child of tree.children) out.push(...leaves(child));
  return out;
}

/** How many leaves the tree holds. */
export function paneCount(tree: PaneNode): number {
  return leaves(tree).length;
}

/** The leaf with this id, or null. */
export function findLeaf(tree: PaneNode, id: PaneId): PaneLeaf | null {
  if (isLeaf(tree)) return tree.id === id ? tree : null;
  for (const child of tree.children) {
    const hit = findLeaf(child, id);
    if (hit !== null) return hit;
  }
  return null;
}

/** The first leaf in reading order — where focus goes when it has nowhere else. */
export function firstLeaf(tree: PaneNode): PaneId {
  return leaves(tree)[0];
}

/** The tree with one leaf replaced by `next`; the same object when it is absent. */
export function replaceLeaf(
  tree: PaneNode,
  id: PaneId,
  next: PaneNode
): PaneNode {
  if (isLeaf(tree)) return tree.id === id ? next : tree;
  let changed = false;
  const children = tree.children.map((child) => {
    const swapped = replaceLeaf(child, id, next);
    if (swapped !== child) changed = true;
    return swapped;
  });
  return changed ? { ...tree, children } : tree;
}

/** One leaf's fields updated in place — how a pane records its PTY id. */
export function updateLeaf(
  tree: PaneNode,
  id: PaneId,
  patch: Partial<Omit<PaneLeaf, "kind" | "id">>
): PaneNode {
  const target = findLeaf(tree, id);
  if (target === null) return tree;
  return replaceLeaf(tree, id, { ...target, ...patch });
}

// ------------------------------------------------------------------ split

/**
 * Split `targetLeafId` in two: the pane it was, and `newLeafId` beside it.
 *
 * THE PART THAT IS NOT OBVIOUS. When the target already sits in a split
 * running the SAME way, the new pane joins that split as a sibling and the
 * shares are re-evened — it does not get wrapped in a nested split of its
 * own. Nesting is what every naive implementation does, and it is wrong in a
 * way the user sees immediately: three presses of ⌘D would build three
 * levels of two, so the second press would halve one half and the third
 * would halve one quarter, where every terminal anyone has used gives four
 * equal columns. The tree stays as flat as the screen looks.
 *
 * Returns the tree unchanged when the target is not a leaf of it.
 */
export function splitPane(
  tree: PaneNode,
  targetLeafId: PaneId,
  vertical: boolean,
  newLeafId: PaneId,
  newCwd?: string
): PaneNode {
  if (findLeaf(tree, targetLeafId) === null) return tree;

  const insert = (node: PaneNode): PaneNode | null => {
    if (isLeaf(node)) return null;
    const at = node.children.findIndex(
      (c) => isLeaf(c) && c.id === targetLeafId
    );
    if (at >= 0 && node.vertical === vertical) {
      const children = [
        ...node.children.slice(0, at + 1),
        leaf(newLeafId, newCwd),
        ...node.children.slice(at + 1),
      ];
      return { ...node, children, ratios: evenRatios(children.length) };
    }
    let changed = false;
    const children = node.children.map((child) => {
      if (changed) return child;
      const done = insert(child);
      if (done === null) return child;
      changed = true;
      return done;
    });
    return changed ? { ...node, children } : null;
  };

  const joined = insert(tree);
  if (joined !== null) return joined;

  // No parent running this way: the leaf becomes a split of two halves.
  const target = findLeaf(tree, targetLeafId) as PaneLeaf;
  const wrapper: PaneSplit = {
    kind: "split",
    // The split takes an id of its own; a divider has to be addressable.
    id: `${targetLeafId}/${newLeafId}`,
    vertical,
    ratios: [0.5, 0.5],
    children: [target, leaf(newLeafId, newCwd)],
  };
  return replaceLeaf(tree, targetLeafId, wrapper);
}

// ----------------------------------------------------------------- remove

export function removePane(tree: PaneNode, leafId: PaneId): PaneNode {
  if (findLeaf(tree, leafId) === null) return tree;
  if (isLeaf(tree)) return tree;

  const prune = (node: PaneSplit): PaneNode => {
    const at = node.children.findIndex((c) => isLeaf(c) && c.id === leafId);
    if (at >= 0) {
      const children = node.children.filter((_, i) => i !== at);
      const kept = node.ratios.filter((_, i) => i !== at);
      // One child left: the split is a wrapper around nothing and goes.
      if (children.length === 1) return children[0];
      return { ...node, children, ratios: normalize(kept, children.length) };
    }
    let changed = false;
    const children = node.children.map((child) => {
      if (changed || isLeaf(child)) return child;
      if (findLeaf(child, leafId) === null) return child;
      changed = true;
      return prune(child);
    });
    return changed ? { ...node, children } : node;
  };

  return prune(tree);
}

// ----------------------------------------------------------------- layout

/**
 * The tree flattened to rectangles, normalized to the tab's content area.
 *
 * The one place shape becomes geometry, and everything that has to answer a
 * question about the SCREEN — which pane is to the right, where a divider
 * sits, which pane a click landed in — asks this rather than the tree.
 */
export function layout(tree: PaneNode): PaneRect[] {
  const out: PaneRect[] = [];
  const walk = (node: PaneNode, x: number, y: number, w: number, h: number) => {
    if (isLeaf(node)) {
      out.push({ id: node.id, x, y, w, h });
      return;
    }
    const ratios = normalize(node.ratios, node.children.length);
    let along = 0;
    node.children.forEach((child, i) => {
      const share = ratios[i];
      if (node.vertical) {
        walk(child, x, y + along * h, w, share * h);
      } else {
        walk(child, x + along * w, y, share * w, h);
      }
      along += share;
    });
  };
  walk(tree, 0, 0, 1, 1);
  return out;
}

/** Every split node's rectangle, for placing the dividers inside it. */
export function splitRects(
  tree: PaneNode
): { node: PaneSplit; rect: Omit<PaneRect, "id"> }[] {
  const out: { node: PaneSplit; rect: Omit<PaneRect, "id"> }[] = [];
  const walk = (node: PaneNode, x: number, y: number, w: number, h: number) => {
    if (isLeaf(node)) return;
    out.push({ node, rect: { x, y, w, h } });
    const ratios = normalize(node.ratios, node.children.length);
    let along = 0;
    node.children.forEach((child, i) => {
      const share = ratios[i];
      if (node.vertical) walk(child, x, y + along * h, w, share * h);
      else walk(child, x + along * w, y, share * w, h);
      along += share;
    });
  };
  walk(tree, 0, 0, 1, 1);
  return out;
}

// --------------------------------------------------------------- neighbour

export function neighbor(
  tree: PaneNode,
  fromLeafId: PaneId,
  dir: PaneDir
): PaneId | null {
  const rects = layout(tree);
  const from = rects.find((r) => r.id === fromLeafId);
  if (from === undefined) return null;

  const touches = (r: PaneRect): boolean => {
    switch (dir) {
      case "right":
        return Math.abs(r.x - (from.x + from.w)) <= EPS;
      case "left":
        return Math.abs(r.x + r.w - from.x) <= EPS;
      case "down":
        return Math.abs(r.y - (from.y + from.h)) <= EPS;
      case "up":
        return Math.abs(r.y + r.h - from.y) <= EPS;
    }
  };
  const overlap = (r: PaneRect): number =>
    dir === "left" || dir === "right"
      ? Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y)
      : Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);

  let best: PaneId | null = null;
  let bestOverlap = 0;
  for (const r of rects) {
    if (r.id === fromLeafId || !touches(r)) continue;
    const share = overlap(r);
    if (share <= EPS) continue;
    // Strictly larger BY MORE THAN THE ROUNDING, so that a genuine tie —
    // two panes facing equal halves of this one — is settled by reading
    // order and not by which of two equal shares came out a bit-width
    // heavier from dividing by a sum. Two panes stacked beside one, all
    // even, is the commonest layout there is; deciding it by float noise
    // would make the same key jump to different panes on different tabs.
    if (best === null || share > bestOverlap + EPS) {
      bestOverlap = share;
      best = r.id;
    }
  }
  return best;
}

export function paneTakingOver(
  before: PaneNode,
  after: PaneNode,
  leafId: PaneId
): PaneId | null {
  const gone = layout(before).find((r) => r.id === leafId);
  if (gone === undefined) return null;
  let best: PaneId | null = null;
  let bestArea = 0;
  for (const r of layout(after)) {
    if (r.id === leafId) continue;
    const w = Math.min(gone.x + gone.w, r.x + r.w) - Math.max(gone.x, r.x);
    const h = Math.min(gone.y + gone.h, r.y + r.h) - Math.max(gone.y, r.y);
    if (w <= EPS || h <= EPS) continue;
    const area = w * h;
    // The same tolerance and the same tie-break as `neighbor`: reading
    // order settles two panes that took equal halves of the space.
    if (best === null || area > bestArea + EPS) {
      bestArea = area;
      best = r.id;
    }
  }
  return best;
}

// ----------------------------------------------------------------- resize

/** Which axis a direction runs along, in the same word the tree uses. */
function axisIsVertical(dir: PaneDir): boolean {
  return dir === "up" || dir === "down";
}

/** Whether a direction moves toward a later child or an earlier one. */
function dirStep(dir: PaneDir): 1 | -1 {
  return dir === "right" || dir === "down" ? 1 : -1;
}

/** Root-to-leaf path as (split, index of the child taken) pairs. */
function pathTo(
  tree: PaneNode,
  id: PaneId
): { node: PaneSplit; index: number }[] | null {
  if (isLeaf(tree)) return tree.id === id ? [] : null;
  for (let i = 0; i < tree.children.length; i += 1) {
    const below = pathTo(tree.children[i], id);
    if (below !== null) return [{ node: tree, index: i }, ...below];
  }
  return null;
}

/** The tree with `node` (by id) replaced. Splits only; leaves use replaceLeaf. */
function replaceNode(tree: PaneNode, id: PaneId, next: PaneNode): PaneNode {
  if (tree.id === id) return next;
  if (isLeaf(tree)) return tree;
  let changed = false;
  const children = tree.children.map((child) => {
    const swapped = replaceNode(child, id, next);
    if (swapped !== child) changed = true;
    return swapped;
  });
  return changed ? { ...tree, children } : tree;
}

/**
 * Move the boundary between `leafId` and the pane on its `dir` side.
 *
 * The boundary is the one belonging to the DEEPEST ancestor that runs along
 * this direction's axis and has somewhere to go on that side — which is the
 * seam the pane actually leans against. `step` is a share of that ancestor's
 * own extent, positive meaning the pane grows; both sides are held above
 * PANE_MIN_SHARE, and a press that would go under it simply stops there
 * rather than being refused.
 *
 * Returns the tree unchanged when the pane has no seam that way (it is
 * against the window edge, or its only ancestors run the other way).
 */
export function resizePane(
  tree: PaneNode,
  leafId: PaneId,
  dir: PaneDir,
  step: number = PANE_RESIZE_STEP
): PaneNode {
  const path = pathTo(tree, leafId);
  if (path === null) return tree;
  const wantVertical = axisIsVertical(dir);
  const sign = dirStep(dir);

  for (let d = path.length - 1; d >= 0; d -= 1) {
    const { node, index } = path[d];
    if (node.vertical !== wantVertical) continue;
    const other = index + sign;
    if (other < 0 || other >= node.children.length) continue;

    const ratios = normalize(node.ratios, node.children.length).slice();
    const pairSum = ratios[index] + ratios[other];
    const grown = Math.min(
      pairSum - PANE_MIN_SHARE,
      Math.max(PANE_MIN_SHARE, ratios[index] + step)
    );
    if (Math.abs(grown - ratios[index]) <= EPS) return tree;
    ratios[index] = grown;
    ratios[other] = pairSum - grown;
    return replaceNode(tree, node.id, { ...node, ratios });
  }
  return tree;
}

/**
 * Put one split's boundary `index` (between children i and i+1) at
 * `position` — a share of that split's own extent, measured from its start.
 * What a dragged divider commits; the two panes it divides keep their
 * combined share, so nothing outside the pair moves.
 */
export function setPaneBoundary(
  tree: PaneNode,
  splitId: PaneId,
  index: number,
  position: number
): PaneNode {
  const target = splitRects(tree).find((s) => s.node.id === splitId);
  if (target === undefined) return tree;
  const node = target.node;
  if (index < 0 || index >= node.children.length - 1) return tree;

  const ratios = normalize(node.ratios, node.children.length).slice();
  const before = ratios.slice(0, index).reduce((a, b) => a + b, 0);
  const pairSum = ratios[index] + ratios[index + 1];
  const first = Math.min(
    pairSum - PANE_MIN_SHARE,
    Math.max(PANE_MIN_SHARE, position - before)
  );
  ratios[index] = first;
  ratios[index + 1] = pairSum - first;
  return replaceNode(tree, node.id, { ...node, ratios });
}

// ------------------------------------------------------------- validation

/**
 * A tree as read back from a session file, or null when it is not one.
 *
 * A stored layout is data somebody could have hand-edited, and a malformed
 * one must degrade to "no tree" — which is a single terminal, the behaviour
 * that predates all of this — rather than to a pane the user cannot reach.
 * Duplicate ids are refused for the same reason: two panes sharing an id
 * share a screen memory file and a registry entry.
 */
export function readPaneTree(raw: unknown): PaneNode | null {
  const seen = new Set<PaneId>();
  const read = (value: unknown): PaneNode | null => {
    if (typeof value !== "object" || value === null) return null;
    const v = value as Partial<PaneSplit> & Partial<PaneLeaf>;
    if (typeof v.id !== "string" || v.id.length === 0) return null;
    if (seen.has(v.id)) return null;
    seen.add(v.id);
    if (v.kind === "leaf") {
      // A stored PTY id is deliberately not read back: the shell it named
      // died with the app, and a leaf carrying a dead session id would look
      // to every reader like a pane whose terminal is already up.
      return typeof v.cwd === "string" && v.cwd.length > 0
        ? leaf(v.id, v.cwd)
        : leaf(v.id);
    }
    if (v.kind !== "split" || !Array.isArray(v.children)) return null;
    const children: PaneNode[] = [];
    for (const child of v.children) {
      const node = read(child);
      if (node === null) return null;
      children.push(node);
    }
    if (children.length === 0) return null;
    // A split of one is the shape `removePane` collapses; accepting it from
    // a file would reintroduce exactly what collapsing exists to remove.
    if (children.length === 1) return children[0];

    return {
      kind: "split",
      id: v.id,
      vertical: v.vertical === true,
      ratios: normalize(Array.isArray(v.ratios) ? v.ratios : undefined, children.length),
      children,
    };
  };
  return read(raw);
}

/**
 * What a tree becomes on disk: the shape without the live PTY ids, which
 * never survive a restart (the shell dies with the app). The layout is
 * restored; the sessions inside it are new.
 */
export function paneTreeSnapshot(tree: PaneNode): PaneNode {
  if (isLeaf(tree)) return leaf(tree.id, tree.cwd);
  return {
    kind: "split",
    id: tree.id,
    vertical: tree.vertical,
    ratios: tree.ratios.slice(),
    children: tree.children.map(paneTreeSnapshot),
  };
}
