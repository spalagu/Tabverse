import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const patterns = [
  ["github-classic", /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g],
  ["github-fine-grained", /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]{16,})?/g],
  ["url-credentials", /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/g],
];

function matches(path, bytes) {
  if (bytes.includes(0)) return [];
  const text = bytes.toString("utf8");
  return patterns.flatMap(([kind, pattern]) => {
    pattern.lastIndex = 0;
    return [...text.matchAll(pattern)].map((match) => ({
      path,
      kind,
      line: text.slice(0, match.index).split("\n").length,
    }));
  });
}

const artifactNames = ["dist", "dist-web", "dist-pages", "dist-pages-test"];
const requiredArtifacts = process.argv.flatMap((arg, index, args) =>
  arg === "--require-artifact" && args[index + 1] ? [args[index + 1]] : [],
);
const artifactCounts = {};

function generatedFiles() {
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  for (const name of artifactNames) {
    const path = resolve(root, name);
    const before = files.length;
    try {
      if (statSync(path).isDirectory()) visit(path);
    } catch {
      // Source-only scans are valid; callers that own a build pass
      // --require-artifact and turn absence into a failure below.
    }
    artifactCounts[name] = files.length - before;
  }
  return files;
}

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .map((path) => resolve(root, path));
const paths = [...new Set([...tracked, ...generatedFiles()])].sort();

const fixtureCorpus = [
  ["github-classic", ["ghp_", "A".repeat(40)].join("")],
  ["github-fine-grained", ["github_pat_", "B".repeat(44)].join("")],
  ["aws-access-key", ["AKIA", "C".repeat(16)].join("")],
  ["private-key", ["-----BEGIN ", "PRIVATE KEY-----"].join("")],
  ["bearer-token", ["Bearer ", "D".repeat(40)].join("")],
  ["url-credentials", ["https://user:", "password@example.invalid/"].join("")],
];
const fixtureMisses = fixtureCorpus
  .filter(([kind, value]) => !matches("<fixture>", Buffer.from(value)).some((hit) => hit.kind === kind))
  .map(([kind]) => kind);

let bytes = 0;
const findings = [];
for (const path of paths) {
  const content = readFileSync(path);
  bytes += content.length;
  findings.push(...matches(relative(root, path), content));
}

const result = {
  schema: "tabverse-secret-scan/v1",
  node: process.version,
  files: paths.length,
  bytes,
  fixtureCorpus: fixtureCorpus.length,
  fixtureMisses,
  artifactCounts,
  requiredArtifacts,
  findings,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (
  fixtureMisses.length > 0 ||
  findings.length > 0 ||
  requiredArtifacts.some((name) => !artifactNames.includes(name) || artifactCounts[name] === 0)
) process.exitCode = 1;
