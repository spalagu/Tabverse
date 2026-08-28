import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const WORKBENCH = join(ROOT, "packages", "workbench", "src");
const RUNTIME_DESKTOP = join(ROOT, "packages", "runtime-desktop", "src");
const JOIN_APP = join(ROOT, "apps", "join", "src");
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;
const IMPORT_SPECIFIER = /(?:from\s*|import\s*)["']([^"']+)["']/g;
const FORBIDDEN = [
  /^@tauri-apps\//,
  /^@tabverse\/runtime-(?:desktop|remote)(?:\/|$)/,
  /^node:/,
  /(?:^|\/)src\//,
  /(?:^|\/)(?:web|apps)\//,
];
const JOIN_FORBIDDEN = [/(?:^|\/)src\//];
const RUNTIME_DESKTOP_FORBIDDEN = [/(?:^|\/)(?:src|apps)\//];

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

const violations = [];
for (const path of sourceFiles(WORKBENCH)) {
  const text = readFileSync(path, "utf8");
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (FORBIDDEN.some((rule) => rule.test(specifier))) {
      violations.push(`${relative(ROOT, path)} imports forbidden dependency ${JSON.stringify(specifier)}`);
    }
  }
}

for (const path of sourceFiles(JOIN_APP)) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (JOIN_FORBIDDEN.some((rule) => rule.test(specifier))) {
      violations.push(`${relative(ROOT, path)} imports desktop source ${JSON.stringify(specifier)}`);
    }
  }
}

for (const path of sourceFiles(RUNTIME_DESKTOP)) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (RUNTIME_DESKTOP_FORBIDDEN.some((rule) => rule.test(specifier))) {
      violations.push(
        `${relative(ROOT, path)} imports application source ${JSON.stringify(specifier)}`
      );
    }
  }
}

if (violations.length > 0) {
  console.error("application boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("application boundary check passed");
