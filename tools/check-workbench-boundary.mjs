import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const WORKBENCH = join(ROOT, "packages", "workbench", "src");
const RUNTIME_CONTRACTS = join(ROOT, "packages", "runtime-contracts", "src");
const RUNTIME_DESKTOP = join(ROOT, "packages", "runtime-desktop", "src");
const JOIN_APP = join(ROOT, "apps", "join", "src");
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;
const IMPORT_SPECIFIER = /(?:from\s*|import\s*)["']([^"']+)["']/g;

const WORKBENCH_FORBIDDEN = [
  /^@tauri-apps\//,
  /^@tabverse\/runtime-(?:desktop|remote)(?:\/|$)/,
  /^node:/,
  /(?:^|\/)src\//,
  /(?:^|\/)(?:web|apps)\//,
];

const CONTRACTS_FORBIDDEN = [
  /^@tauri-apps\//,
  /^@tabverse\/runtime-(?:desktop|remote)(?:\/|$)/,
  /^@tabverse\/workbench(?:\/|$)/,
  /^react(?:\/|$)/,
  /^node:/,
  /(?:^|\/)src\//,
  /(?:^|\/)apps\//,
];

const JOIN_FORBIDDEN = [/(?:^|\/)src\//];
const RUNTIME_DESKTOP_FORBIDDEN = [
  /^@tabverse\/workbench(?:\/|$)/,
  /(?:^|\/)(?:src|apps)\//,
];

const CORE_RUST_MANIFESTS = [
  "crates/tabverse-proto/Cargo.toml",
  "crates/tabverse-term/Cargo.toml",
  "crates/tabverse-remote/Cargo.toml",
  "crates/tabverse-network/Cargo.toml",
  "crates/tabverse-state/Cargo.toml",
  "crates/tabverse-runtime/Cargo.toml",
  "crates/tabverse-fs/Cargo.toml",
  "crates/tabverse-web/Cargo.toml",
  "crates/tabverse-agent-tools/Cargo.toml",
  "crates/tabverse-agent/Cargo.toml",
];

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

function checkImports(dir, rules, description, violations) {
  if (!existsSync(dir)) return;
  for (const path of sourceFiles(dir)) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      if (rules.some((rule) => rule.test(specifier))) {
        violations.push(
          `${relative(ROOT, path)} violates ${description}: ${JSON.stringify(specifier)}`,
        );
      }
    }
  }
}

const violations = [];

// Runtime V3 local IPC must not regress to a localhost TCP service. The
// helper protocol is local-socket bytes (UDS on Unix, Named Pipe on Windows).
for (const sourcePath of [
  "crates/tabverse-term/src/helper.rs",
  "crates/tabverse-term/src/transport.rs",
  "src-tauri/src/terminal_helper.rs",
]) {
  const source = readFileSync(join(ROOT, sourcePath), "utf8");
  if (/\bTcp(?:Listener|Stream)\b|127\.0\.0\.1/.test(source)) {
    violations.push(`${sourcePath} reintroduces localhost TCP for Runtime IPC`);
  }
}

// The Workbench is shared product UI. Desktop/remote implementations adapt to
// it; the Workbench must not learn about Tauri or a concrete runtime.
checkImports(WORKBENCH, WORKBENCH_FORBIDDEN, "the Workbench boundary", violations);

// Renderer/runtime contracts are portable facts. Keep framework/UI/runtime
// implementations out so both Desktop and Join can depend on them safely.
checkImports(
  RUNTIME_CONTRACTS,
  CONTRACTS_FORBIDDEN,
  "the portable contracts boundary",
  violations,
);

// Join is a remote application entry and must not reach into Desktop source.
checkImports(JOIN_APP, JOIN_FORBIDDEN, "the Join/Desktop boundary", violations);

// Desktop runtime adapters must not depend back on application/UI code.
checkImports(
  RUNTIME_DESKTOP,
  RUNTIME_DESKTOP_FORBIDDEN,
  "the runtime adapter boundary",
  violations,
);

// Core Rust engines must remain reusable outside the Tauri application shell.
for (const manifestPath of CORE_RUST_MANIFESTS) {
  const path = join(ROOT, manifestPath);
  if (!existsSync(path)) continue;
  const manifest = readFileSync(path, "utf8");
  if (/^\s*tauri(?:-[\w-]+)?\s*=/m.test(manifest)) {
    violations.push(`${manifestPath} depends directly on Tauri; move the dependency to src-tauri/adapters`);
  }
}

// V3 deliberately returns to official Tauri + Wry. Prevent an accidental
// resurrection of the abandoned CEF/custom-runtime architecture.
for (const manifestPath of ["Cargo.toml", "src-tauri/Cargo.toml"]) {
  const path = join(ROOT, manifestPath);
  if (!existsSync(path)) continue;
  const manifest = readFileSync(path, "utf8");
  if (manifest.includes("github.com/spalagu/tauri") || /runtime-cef|\bcef\b/i.test(manifest)) {
    violations.push(`${manifestPath} reintroduces the abandoned CEF/custom-Tauri runtime path`);
  }
}

// Thin Tauri: Files IPC belongs to its adapter, never back in the composition
// root. The qualified handler list is allowed; function definitions are not.
const tauriComposition = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
if (/\b(?:async\s+)?fn\s+fs_[a-z0-9_]+\s*\(/.test(tauriComposition)) {
  violations.push("src-tauri/src/lib.rs defines a Files command; move it to fs_commands.rs");
}
if (/\b(?:async\s+)?fn\s+(?:state|config)_(?:save|load|delete|list|get|set|reset)\s*\(/.test(tauriComposition)) {
  violations.push("src-tauri/src/lib.rs defines an app.db command; move it to state_commands.rs");
}

if (violations.length > 0) {
  console.error("V3 architecture boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("V3 architecture boundary check passed");
