import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const SOURCE_FILE = /\.(?:ts|tsx|mts|mjs)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;
const IMPORT_SPECIFIER = /(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g;
const PACKAGES_ROOT = join(ROOT, "packages");

const NEW_BOUNDARIES = {
  "packages/tab-contracts": new Set(),
  "packages/plugin-kernel": new Set(["@tabverse/tab-contracts"]),
  "packages/plugin-composition": new Set([
    "@tabverse/plugin-kernel",
    "@tabverse/remote-protocol",
    "@tabverse/tab-contracts",
  ]),
  "packages/remote-protocol": new Set(["@tabverse/tab-contracts"]),
  "packages/tab-browser": new Set(["@tabverse/tab-contracts"]),
  "packages/tab-files": new Set(["@tabverse/tab-contracts"]),
  "packages/tab-remote": new Set(["@tabverse/tab-contracts"]),
  "packages/tab-settings": new Set(["@tabverse/tab-contracts"]),
  "packages/tab-terminal": new Set(["@tabverse/tab-contracts"]),
};

const CORE_KIND_FILES = [
  "packages/runtime-contracts/src/index.ts",
  "packages/workbench/src/tabs.ts",
  "packages/runtime-remote/src/appMirror.ts",
  "src/components/NewTabMenu.tsx",
  "src/components/TabContent.tsx",
];

const RETIRED_PATHS = [
  "packages/tab-legacy/package.json",
  "packages/workbench/src/tabView.tsx",
  "packages/workbench/src/remoteTabView.tsx",
  "packages/workbench/src/runtime.tsx",
];

const RETIRED_SYMBOLS = [
  "TAB_TYPES",
  "TAB_REQUIREMENTS",
  "TAB_DEFINITIONS",
  "DESKTOP_TAB_RENDERERS",
  "REMOTE_TAB_RENDERERS",
  "REMOTE_TAB_TYPES",
  "RemoteWorkbenchTabType",
  "defineTabViewRenderers",
  "@tabverse/workbench/runtime",
];

const COMPOSITION_ROOTS = [
  {
    path: "src/pluginComposition.ts",
    required: [
      "@tabverse/plugin-composition",
      "@tabverse/runtime-desktop",
      "@tabverse/tab-browser",
      "@tabverse/tab-files",
      "@tabverse/tab-remote",
      "@tabverse/tab-settings",
      "@tabverse/tab-terminal",
    ],
    starter: "apps/desktop/src/main.tsx",
    startCall: "startDesktopPluginComposition",
  },
  {
    path: "apps/join/src/pluginComposition.ts",
    required: [
      "@tabverse/plugin-composition",
      "@tabverse/runtime-remote",
      "@tabverse/tab-browser",
      "@tabverse/tab-files",
      "@tabverse/tab-terminal",
    ],
    starter: "apps/join/src/main.tsx",
    startCall: "startJoinPluginComposition",
  },
];

const APPLICATION_BOUNDARIES = [
  {
    root: "packages/workbench/src",
    forbidden: [
      /^@tauri-apps\//,
      /^@tabverse\/runtime-(?:desktop|remote)(?:\/|$)/,
      /^node:/,
      /(?:^|\/)src\//,
      /(?:^|\/)(?:web|apps)\//,
    ],
  },
  {
    root: "apps/join/src",
    forbidden: [/(?:^|\/)src\//],
  },
  {
    root: "packages/runtime-desktop/src",
    forbidden: [/(?:^|\/)(?:src|apps)\//],
  },
];

function sourceFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [child] : [];
  });
}

function workspaceName(specifier) {
  const match = /^(@tabverse\/[^/]+)/.exec(specifier);
  return match?.[1] ?? null;
}

function workspacePackages() {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = join(PACKAGES_ROOT, entry.name, "package.json");
      if (!existsSync(manifestPath)) return null;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return { path: `packages/${entry.name}`, manifest };
    })
    .filter((entry) => entry !== null);
}

function findCycles(graph) {
  const cycles = [];
  const visiting = [];
  const visited = new Set();
  const visit = (node) => {
    const at = visiting.indexOf(node);
    if (at >= 0) {
      cycles.push([...visiting.slice(at), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    visiting.pop();
    visited.add(node);
  };
  for (const node of [...graph.keys()].sort()) visit(node);
  return cycles;
}

const violations = [];
for (const path of RETIRED_PATHS) {
  if (existsSync(join(ROOT, path))) violations.push(`retired path still exists: ${path}`);
}

for (const root of ["src", "apps", "packages"]) {
  for (const file of sourceFiles(join(ROOT, root))) {
    const source = readFileSync(file, "utf8");
    for (const symbol of RETIRED_SYMBOLS) {
      if (source.includes(symbol)) {
        violations.push(`${relative(ROOT, file)} still references retired symbol ${symbol}`);
      }
    }
  }
}
const workspaces = workspacePackages();
const workspaceNames = new Set(workspaces.map(({ manifest }) => manifest.name));
const graph = new Map();
const edges = [];
for (const { manifest } of workspaces) {
  const declared = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  const dependencies = Object.keys(declared)
    .filter((name) => workspaceNames.has(name))
    .sort();
  graph.set(manifest.name, dependencies);
  for (const dependency of dependencies) edges.push(`${manifest.name}->${dependency}`);
}
const cycles = findCycles(graph);
for (const cycle of cycles) violations.push(`workspace dependency cycle: ${cycle.join(" -> ")}`);

for (const [workspacePath, allowed] of Object.entries(NEW_BOUNDARIES)) {
  const sourceRoot = join(ROOT, workspacePath, "src");
  if (!existsSync(sourceRoot)) {
    violations.push(`${workspacePath}/src is missing`);
    continue;
  }
  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      const workspace = workspaceName(specifier);
      if (workspace !== null && !allowed.has(workspace)) {
        violations.push(
          `${relative(ROOT, file)} imports disallowed workspace ${JSON.stringify(workspace)}`,
        );
      }
      if (/^@tauri-apps\//.test(specifier) || specifier === "react" || specifier === "react-dom") {
        violations.push(
          `${relative(ROOT, file)} imports environment dependency ${JSON.stringify(specifier)}`,
        );
      }
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(`${sourceRoot}/`) && target !== sourceRoot) {
          violations.push(
            `${relative(ROOT, file)} crosses its package boundary via ${JSON.stringify(specifier)}`,
          );
        }
      }
    }
  }
}

for (const { path, manifest } of workspaces) {
  if (!manifest.name.startsWith("@tabverse/tab-") || manifest.name === "@tabverse/tab-contracts") {
    continue;
  }
  for (const dependency of graph.get(manifest.name) ?? []) {
    if (dependency !== "@tabverse/tab-contracts") {
      violations.push(`${path} product Tab plugin bypasses facade via ${dependency}`);
    }
  }
}

for (const root of COMPOSITION_ROOTS) {
  const source = readFileSync(join(ROOT, root.path), "utf8");
  for (const specifier of root.required) {
    if (!source.includes(specifier)) {
      violations.push(`${root.path} does not compose required boundary ${specifier}`);
    }
  }
  const starter = readFileSync(join(ROOT, root.starter), "utf8");
  if (!starter.includes(root.startCall)) {
    violations.push(`${root.starter} does not start ${root.startCall}`);
  }
}

for (const boundary of APPLICATION_BOUNDARIES) {
  for (const file of sourceFiles(join(ROOT, boundary.root))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      if (boundary.forbidden.some((rule) => rule.test(specifier))) {
        violations.push(
          `${relative(ROOT, file)} crosses the ${boundary.root} application boundary via ${JSON.stringify(specifier)}`,
        );
      }
    }
  }
}

for (const path of CORE_KIND_FILES) {
  const source = readFileSync(join(ROOT, path), "utf8");
  if (source.includes("fixture.reference")) {
    violations.push(`${path} contains the test-only fixture kind`);
  }
}

if (violations.length > 0) {
  console.error("plugin architecture boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(JSON.stringify({
  schema: "tabverse-plugin-boundary-result/v1",
  status: "passed",
  checkedPackages: Object.keys(NEW_BOUNDARIES).sort(),
  checkedCoreKindFiles: [...CORE_KIND_FILES].sort(),
  retiredPaths: RETIRED_PATHS,
  retiredSymbols: RETIRED_SYMBOLS,
  compositionRoots: COMPOSITION_ROOTS.map(({ path }) => path).sort(),
  applicationBoundaries: APPLICATION_BOUNDARIES.map(({ root }) => root).sort(),
  workspaceEdges: edges.sort(),
  cycles,
  violations: [],
}));
