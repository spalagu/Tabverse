import { readFile } from "node:fs/promises";

const cargo = await readFile(
  new URL("../src-tauri/Cargo.toml", import.meta.url),
  "utf8",
);
const rootCargo = await readFile(
  new URL("../Cargo.toml", import.meta.url),
  "utf8",
);
const main = await readFile(
  new URL("../src-tauri/src/main.rs", import.meta.url),
  "utf8",
);
const lib = await readFile(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
const release = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const browserPort = await readFile(
  new URL("../packages/runtime-desktop/src/browser.ts", import.meta.url),
  "utf8",
);
const browserView = await readFile(
  new URL("../src/components/BrowserView.tsx", import.meta.url),
  "utf8",
);
const forkRevisions = [
  ...rootCargo.matchAll(
    /(?:tauri|tauri-build) = \{ git = "https:\/\/github\.com\/spalagu\/tauri\.git", rev = "([0-9a-f]{40})" \}/g,
  ),
].map((match) => match[1]);
const runtimeCefRevision = cargo.match(
  /tauri-runtime-cef = \{ git = "https:\/\/github\.com\/spalagu\/tauri\.git", rev = "([0-9a-f]{40})", optional = true \}/,
)?.[1];

const checks = [
  [
    cargo.includes('default = ["runtime-wry"]'),
    "Wry must remain the default Cargo runtime",
  ],
  [
    cargo.includes('runtime-wry = ["tauri/wry"]'),
    "runtime-wry provider feature is missing",
  ],
  [
    cargo.includes('runtime-cef = ["tauri/cef", "dep:tauri-runtime-cef"]'),
    "runtime-cef provider feature is missing",
  ],
  [
    forkRevisions.length === 2 &&
      new Set(forkRevisions).size === 1 &&
      runtimeCefRevision === forkRevisions[0],
    "tauri, tauri-build and tauri-runtime-cef must share one immutable public fork revision",
  ],
  [
    main.includes(
      '#[cfg_attr(feature = "runtime-cef", tauri::cef_entry_point)]',
    ),
    "CEF build is missing the CEF multi-process entry point",
  ],
  [
    lib.includes('all(feature = "runtime-wry", feature = "runtime-cef")') &&
      lib.includes("cannot be enabled in the same Tabverse binary"),
    "Wry/CEF same-binary exclusion guard is missing",
  ],
  [
    release.includes("asset_suffix: aarch64.dmg") &&
      release.includes(
        'asset="Tabverse_${version}_${{ matrix.asset_suffix }}"',
      ),
    "default Wry ARM64 asset naming changed",
  ],
  [
    release.includes('asset="Tabverse_${version}_aarch64-cef.dmg"') &&
      release.includes("--features runtime-cef") &&
      release.includes("-- --no-default-features"),
    "macOS ARM64 CEF asset or exclusive build arguments are missing",
  ],
  [
    release.includes("needs: [build, build-cef]") &&
      release.includes("pattern: release-*"),
    "GitHub Release does not wait for both Wry and CEF artifacts",
  ],
  [
    browserPort.includes('"browser_session_ensure"') &&
      browserPort.includes('"browser_session_command"') &&
      browserPort.includes('"browser_close"'),
    "Desktop BrowserSessionPort is not wired to the native lifecycle commands",
  ],
  [
    !browserView.includes('invoke("browser_create"') &&
      browserView.includes("session.ensureSession") &&
      browserView.includes("session.attachSurface") &&
      browserView.includes("session.closeSession"),
    "BrowserView bypasses the runtime-owned BrowserSessionPort",
  ],
  [
    lib.includes(".on_browser_closed(move ||") &&
      lib.includes("confirm_browser_closed") &&
      lib.includes("browser close confirmation timed out"),
    "CEF BrowserClosed acknowledgement is not the close completion boundary",
  ],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) console.error(`runtime-contract: ${failure}`);
  process.exit(1);
}

console.log(
  "runtime-contract: default Wry, opt-in CEF, exclusivity, and artifact naming are locked",
);
