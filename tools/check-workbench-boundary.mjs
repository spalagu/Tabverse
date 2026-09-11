import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const WORKBENCH = join(ROOT, "packages", "workbench", "src");
const RUNTIME_CONTRACTS = join(ROOT, "packages", "runtime-contracts", "src");
const RUNTIME_DESKTOP = join(ROOT, "packages", "runtime-desktop", "src");
const JOIN_APP = join(ROOT, "apps", "join", "src");
const SOURCE_FILE = /\.(?:rs|ts|tsx)$/;
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

for (const adr of [
  "0001-v3-baseline.md",
  "0002-remote-capability-placement.md",
  "0003-built-in-feature-modules.md",
  "0004-host-network-gateway.md",
  "0005-remote-data-streams.md",
  "0006-wry-only-browser.md",
  "0007-sqlite-durable-state.md",
  "0008-on-demand-runtime-sidecar.md",
  "0009-runtime-local-ipc.md",
  "0010-runtime-identity.md",
  "0011-semantic-remote.md",
  "0012-remote-browser-context.md",
  "0013-browser-credentials.md",
  "0014-content-and-associations.md",
  "0015-platform-adapters-and-completeness.md",
  "0017-remove-remote-browser.md",
]) {
  if (!existsSync(join(ROOT, "docs", "adr", adr))) {
    violations.push(`docs/adr/${adr} is required by the V3 architecture record`);
  }
}

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

for (const legacyPath of [
  "crates/runtime-cef",
  "crates/plugin-kernel",
  "crates/resident-runtime",
  "src-tauri/src/cef",
]) {
  if (existsSync(join(ROOT, legacyPath))) {
    violations.push(`${legacyPath} resurrects an architecture explicitly dropped by V3`);
  }
}

for (const sourceRoot of ["apps", "packages", "src", "src-tauri/src", "crates"]) {
  const root = join(ROOT, sourceRoot);
  if (!existsSync(root)) continue;
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, "utf8");
    if (/\bProxy(?:Req|Res)\b/.test(source)) {
      violations.push(`${relative(ROOT, path)} reintroduces legacy ProxyReq/ProxyRes control frames`);
    }
    if (/HostNetworkGateway|RemoteHttpStream|openHttpStream|open_http_stream|__tabverse_proxy/.test(source)) {
      violations.push(`${relative(ROOT, path)} reintroduces removed Remote Browser networking`);
    }
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
if (/\b(?:async\s+)?fn\s+term_[a-z0-9_]+\s*\(/.test(tauriComposition)) {
  violations.push("src-tauri/src/lib.rs defines a Terminal command; move it to terminal_commands.rs");
}
if (/\b(?:async\s+)?fn\s+remote_(?:join|input|agent_[a-z0-9_]+|viewport|ping|leave)\s*\(/.test(tauriComposition)) {
  violations.push("src-tauri/src/lib.rs defines a Remote Join command; move it to remote_commands.rs");
}
if (/\b(?:async\s+)?fn\s+agent_(?:start|prompt|cancel|answer|close|detach|login_[a-z0-9_]+|logout)\s*\(/.test(tauriComposition)) {
  violations.push("src-tauri/src/lib.rs defines an Agent command; move it to agent_commands.rs");
}
if (/\b(?:async\s+)?fn\s+(?:pw_|migrate_)(?:authorize_[a-z0-9_]+|reveal|forget_all|export|import|import_check|import_apply)\s*\(/.test(tauriComposition)) {
  violations.push("src-tauri/src/lib.rs defines a credential or migration command; move it to credential_commands.rs");
}
if (/\b(?:async\s+)?fn\s+(?:traffic_light_reapply|toggle_simple_fullscreen|set_theme|theme_pref_(?:save|load)|js_log)\s*\(/.test(tauriComposition)) {
  violations.push("src-tauri/src/lib.rs defines an appearance command; move it to appearance_commands.rs");
}
if (/\b(?:async\s+)?fn\s+(?:browser_[a-z0-9_]+|window_buttons|ui_plane_set|ui_focus)\s*\(/.test(tauriComposition)) {
  violations.push("src-tauri/src/lib.rs defines a Browser command; move it to browser_commands.rs");
}

if (violations.length > 0) {
  console.error("V3 architecture boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("V3 architecture boundary check passed");
