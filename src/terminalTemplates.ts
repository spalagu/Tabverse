import type { PaneLeaf, PaneNode, PaneSplit } from "./paneTree";

export interface TemplateLeaf {
  kind: "leaf";
  profile?: string;
  cwd?: string;
  run_on_start?: string;
}

/** A row or column in a saved layout. */
export interface TemplateSplit {
  kind: "split";
  vertical: boolean;
  ratios?: number[];
  children: TemplateNode[];
}

export type TemplateNode = TemplateLeaf | TemplateSplit;

/** One `[[terminal.templates]]` entry. */
export interface ConfigTemplate {
  name: string;
  tree: TemplateNode;
}

/** A leaf and the child indexes that reach it from the root. */
export interface TemplateLeafAt {
  path: number[];
  leaf: TemplateLeaf;
}

function evenRatios(count: number): number[] {
  return count > 0 ? new Array(count).fill(1 / count) : [];
}

/** Ratios made safe for the runtime tree; the core rejects bad declarations. */
function ratiosFor(node: TemplateSplit): number[] {
  const { ratios, children } = node;
  if (
    ratios === undefined ||
    ratios.length !== children.length ||
    ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)
  ) {
    return evenRatios(children.length);
  }
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);
  return ratios.map((ratio) => ratio / sum);
}

/** Every template leaf in reading order, with a stable structural path. */
export function templateLeaves(tree: TemplateNode): TemplateLeafAt[] {
  const out: TemplateLeafAt[] = [];
  const walk = (node: TemplateNode, path: number[]) => {
    if (node.kind === "leaf") {
      out.push({ path, leaf: node });
      return;
    }
    node.children.forEach((child, index) => walk(child, [...path, index]));
  };
  walk(tree, []);
  return out;
}

/** Replace one template leaf without changing the layout around it. */
export function updateTemplateLeaf(
  tree: TemplateNode,
  path: readonly number[],
  patch: Partial<Omit<TemplateLeaf, "kind">>
): TemplateNode {
  if (path.length === 0) {
    return tree.kind === "leaf" ? { ...tree, ...patch } : tree;
  }
  if (tree.kind === "leaf") return tree;
  const [at, ...rest] = path;
  if (at < 0 || at >= tree.children.length) return tree;
  return {
    ...tree,
    children: tree.children.map((child, index) =>
      index === at ? updateTemplateLeaf(child, rest, patch) : child
    ),
  };
}

/**
 * Turn a declared layout into a live pane tree.
 *
 * The first leaf wears the tab id, exactly as the first manual split does. It
 * keeps the registry key and screen-memory scope compatible with a terminal
 * that never had a tree; every other leaf and every divider gets a fresh id.
 */
export function instantiateTemplate(
  tree: TemplateNode,
  tabId: string,
  makeId: () => string = () => crypto.randomUUID()
): PaneNode {
  let first = true;
  const build = (node: TemplateNode): PaneNode => {
    if (node.kind === "leaf") {
      const id = first ? tabId : makeId();
      first = false;
      const leaf: PaneLeaf = { kind: "leaf", id };
      if (node.profile !== undefined) leaf.profile = node.profile;
      if (node.cwd !== undefined) leaf.cwd = node.cwd;
      if (node.run_on_start !== undefined) leaf.runOnStart = node.run_on_start;
      return leaf;
    }
    const children = node.children.map(build);
    const split: PaneSplit = {
      kind: "split",
      id: makeId(),
      vertical: node.vertical,
      ratios: ratiosFor(node),
      children,
    };
    return split;
  };
  return build(tree);
}

export function captureTemplate(
  name: string,
  tree: PaneNode,
  fallback: { profile?: string; cwd?: string } = {}
): ConfigTemplate {
  const capture = (node: PaneNode): TemplateNode => {
    if (node.kind === "leaf") {
      const leaf: TemplateLeaf = { kind: "leaf" };
      const profile = node.profile ?? fallback.profile;
      const cwd = node.cwd ?? fallback.cwd;
      if (profile !== undefined) leaf.profile = profile;
      if (cwd !== undefined) leaf.cwd = cwd;
      return leaf;
    }
    return {
      kind: "split",
      vertical: node.vertical,
      ratios: node.ratios.map((ratio) => Math.max(1, Math.round(ratio * 10_000))),
      children: node.children.map(capture),
    };
  };
  return { name, tree: capture(tree) };
}
