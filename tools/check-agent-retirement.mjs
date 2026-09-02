import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const dependencyFiles = files.filter((path) =>
  /(^|\/)(?:Cargo\.toml|Cargo\.lock|package\.json|package-lock\.json)$/.test(path),
);
const dependencyPattern = /tabverse-agent|tabverse_agent|agent-tools/gi;
const dependencyHits = dependencyFiles.flatMap((path) => {
  const text = readFileSync(resolve(root, path), "utf8");
  return [...text.matchAll(dependencyPattern)].map((match) => ({
    path,
    line: text.slice(0, match.index).split("\n").length,
  }));
});

const codeFiles = files.filter((path) =>
  /\.(?:rs|ts|tsx|js|jsx|mjs|json)$/.test(path) &&
  /^(?:apps|crates|packages|src|src-tauri)\//.test(path),
);
const httpAgentPath = new Set([
  "src-tauri/src/completions.rs",
  "src-tauri/src/favicon.rs",
  "src-tauri/src/http.rs",
  "src-tauri/src/lib.rs",
  "src-tauri/src/remote_proxy.rs",
  "src-tauri/src/userscripts.rs",
]);
const cfgTestStarts = new Map(
  codeFiles.map((path) => {
    const lines = readFileSync(resolve(root, path), "utf8").split("\n");
    const marker = lines.findIndex((line) => line.trim() === "#[cfg(test)]");
    return [path, marker < 0 ? null : marker + 1];
  }),
);

function classify(path, line, lineNumber) {
  if (/\.(?:test|spec)\.[^.]+$/.test(path) || /\/tests?\//.test(path)) return "test-fixture";
  const cfgTestStart = cfgTestStarts.get(path);
  if (cfgTestStart !== null && lineNumber > cfgTestStart) return "test-fixture";
  if (
    path === "crates/tabverse-fs/src/session_migration.rs" &&
    /legacy Agent tab session shape|pre-agent-removal|removed_agent_tabs|kind == "agent"/i.test(line)
  ) return "retirement-migration-or-decode-only";
  if (
    path === "crates/tabverse-proto/src/lib.rs" &&
    /serde\(rename = "agent(?:Prompt|Answer|Cancel)"/i.test(line)
  ) return "retirement-migration-or-decode-only";
  if (path === "src/persist.ts" && /removedAgentTabs/.test(line)) {
    return "retirement-migration-or-decode-only";
  }
  if (path === "src/state/mirrorActions.ts" && /v !== "agent"/.test(line)) {
    return "retirement-migration-or-decode-only";
  }
  if (path === "src/state/store.ts" && /tab\.type === "agent"/.test(line)) {
    return "retirement-migration-or-decode-only";
  }
  if (
    path === "src-tauri/src/share_commands.rs" &&
    cfgTestStart !== null &&
    lineNumber > cfgTestStart
  ) return "cfg-test-private-boundary";
  if (httpAgentPath.has(path) && /user[-_ ]?agent|BROWSER_UA/i.test(line)) return "http-user-agent";
  if (path === "apps/join/src/App.tsx" && /navigator\.userAgent/.test(line)) return "browser-user-agent";
  if (path === "crates/tabverse-resident/src/platform.rs" && /LaunchAgents/.test(line)) return "macos-launch-agent";
  if (/^packages\/workbench\/src\/theme\//.test(path) && /magenta/i.test(line)) return "color-magenta";
  return null;
}

const matches = [];
for (const path of codeFiles) {
  const lines = readFileSync(resolve(root, path), "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!/agent/i.test(line)) return;
    matches.push({
      path,
      line: index + 1,
      category: classify(path, line, index + 1),
    });
  });
}

const forbiddenPaths = files.filter((path) =>
  /(^|\/)(?:tabverse-agent|tabverse_agent|agent-tools)(?:\/|$)/i.test(path),
);
const unclassified = matches.filter((match) => match.category === null);
const categories = Object.fromEntries(
  [...new Set(matches.map((match) => match.category).filter(Boolean))]
    .sort()
    .map((category) => [category, matches.filter((match) => match.category === category).length]),
);
const result = {
  schema: "tabverse-agent-retirement-scan/v1",
  node: process.version,
  dependencyHits,
  forbiddenPaths,
  classifiedMatches: matches.length - unclassified.length,
  categories,
  unclassified,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (dependencyHits.length > 0 || forbiddenPaths.length > 0 || unclassified.length > 0) {
  process.exitCode = 1;
}
