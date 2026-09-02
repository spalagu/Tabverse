import { readFile } from "node:fs/promises";
import { expectedReleaseAssets } from "./release-manifest.mjs";

const cargo = await readFile(
  new URL("../src-tauri/Cargo.toml", import.meta.url),
  "utf8",
);
const rootCargo = await readFile(
  new URL("../Cargo.toml", import.meta.url),
  "utf8",
);
const cargoLock = await readFile(
  new URL("../Cargo.lock", import.meta.url),
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
const networkBroker = await readFile(
  new URL("../src-tauri/src/network_broker/mod.rs", import.meta.url),
  "utf8",
);
const pageProxy = await readFile(
  new URL("../src-tauri/src/page_proxy.rs", import.meta.url),
  "utf8",
);
const remoteProxy = await readFile(
  new URL("../src-tauri/src/remote_proxy.rs", import.meta.url),
  "utf8",
);
const remoteDocument = await readFile(
  new URL("../packages/workbench/src/remoteDocument.ts", import.meta.url),
  "utf8",
);
const remoteBrowserPane = await readFile(
  new URL("../packages/workbench/src/BrowserPane.tsx", import.meta.url),
  "utf8",
);
const remoteClient = await readFile(
  new URL("../packages/remote-client/src/proxyFetch.ts", import.meta.url),
  "utf8",
);
const joinApp = await readFile(
  new URL("../apps/join/src/App.tsx", import.meta.url),
  "utf8",
);
const releaseEnvironment = await readFile(
  new URL("./check-release-environment.mjs", import.meta.url),
  "utf8",
);
const macosReleaseVerifier = await readFile(
  new URL("./verify-macos-release.mjs", import.meta.url),
  "utf8",
);
const cefReleasePreparation = await readFile(
  new URL("./prepare-cef-release.mjs", import.meta.url),
  "utf8",
);
const runtimeRollbackVerifier = await readFile(
  new URL("./verify-runtime-rollback.mjs", import.meta.url),
  "utf8",
);
const rcPerformanceRunner = await readFile(
  new URL("./run-rc-performance-sample.sh", import.meta.url),
  "utf8",
);
const rcPerformanceVerifier = await readFile(
  new URL("./check-rc-performance.mjs", import.meta.url),
  "utf8",
);
const releaseAssets = expectedReleaseAssets("0.0.0");
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
    cargoLock.includes('name = "cef"\nversion = "151.1.0+151.3.12"') &&
      cargoLock.includes(
        'name = "cef-dll-sys"\nversion = "151.1.0+151.3.12"',
      ) &&
      cargoLock.includes('name = "download-cef"\nversion = "2.3.2"'),
    "CEF Rust bindings, binary distribution, or downloader lock drifted",
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
    release.includes("cargo install tauri-cli") &&
      release.includes("--git https://github.com/spalagu/tauri.git") &&
      release.includes("--rev a639cadd9df0949ae20cbf8b29da66fc0cbf8d14") &&
      release.includes("cargo tauri build") &&
      release.includes("--config target/cef-release-config.json") &&
      release.includes("tools/prepare-cef-release.mjs") &&
      cefReleasePreparation.includes("CEF-CREDITS.html.gz"),
    "CEF release must build and bundle with the pinned CEF-aware Tauri CLI",
  ],
  [
    release.includes("needs: [build, build-cef, sbom, macos-arm64-gate]") &&
      release.includes("pattern: release-*"),
    "GitHub Release does not wait for Wry, CEF, SBOM, and rollback gates",
  ],
  [
    releaseAssets.filter(
      (asset) => asset.kind === "installer" && asset.runtime === "wry",
    ).length === 6 &&
      releaseAssets.filter(
        (asset) => asset.kind === "installer" && asset.runtime === "cef",
      ).length === 1 &&
      releaseAssets
        .filter((asset) => asset.runtime === "cef")
        .every((asset) => asset.name.includes("-cef")),
    "release manifest does not preserve the six default Wry assets and one macOS ARM64 CEF asset",
  ],
  [
    releaseEnvironment.includes('"APPLE_CERTIFICATE"') &&
      releaseEnvironment.includes('"APPLE_SIGNING_IDENTITY"') &&
      releaseEnvironment.includes('"APPLE_TEAM_ID"') &&
      release.includes("verify-macos-release.mjs") &&
      macosReleaseVerifier.includes('"stapler", "validate"') &&
      macosReleaseVerifier.includes("Chromium Embedded Framework.framework") &&
      macosReleaseVerifier.includes("CEF-CREDITS.html.gz"),
    "release signing and notarization must be secret-gated and artifact-verified",
  ],
  [
    release.includes("macos-arm64-gate:") &&
      release.includes("tools/verify-runtime-rollback.mjs") &&
      release.includes("--max-cef-delta-mib 325") &&
      runtimeRollbackVerifier.includes("sequence: observed") &&
      runtimeRollbackVerifier.includes("cefProfilePreserved: true"),
    "macOS ARM64 release must preserve state and CEF profile across Wry/CEF replacement",
  ],
  [
    release.includes("tools/run-rc-performance-sample.sh") &&
      release.includes("for tabs in 1 2 20") &&
      release.includes("for sample in $(seq -w 1 10)") &&
      release.includes("tools/check-rc-performance.mjs") &&
      rcPerformanceRunner.includes("TABVERSE_RUNTIME_PERFORMANCE_ACCEPTANCE=1") &&
      rcPerformanceRunner.includes("TABVERSE_CEF_POC_TRACE_SHUTDOWN=1") &&
      rcPerformanceVerifier.includes('schema: "tabverse-rc-performance/v1"') &&
      rcPerformanceVerifier.includes("count !== 10"),
    "macOS ARM64 CEF release must run the hidden 30-sample performance and clean-shutdown gate",
  ],
  [
    release.includes("cargo-cyclonedx --version 0.5.9 --locked") &&
      release.includes("--features runtime-wry") &&
      release.includes("--features runtime-cef") &&
      release.includes("npm sbom --sbom-format cyclonedx") &&
      release.includes(
        "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
      ) &&
      release.includes("tools/release-manifest.mjs"),
    "release SBOM or same-commit provenance gate is missing",
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
  [
    networkBroker.includes("pub struct DnsCache") &&
      networkBroker.includes("pub fn approve_addresses") &&
      networkBroker.includes("pub fn connect_happy_eyeballs"),
    "NetworkBroker does not own DNS cache, address policy and connection racing",
  ],
  [
    pageProxy.includes("DnsCache") &&
      pageProxy.includes("TargetPolicy::LocalNavigation") &&
      pageProxy.includes("network_broker::connect_happy_eyeballs") &&
      !pageProxy.includes("fn connect_first"),
    "CEF/Wry page proxy bypasses the shared NetworkBroker",
  ],
  [
    remoteProxy.includes("TargetPolicy::RemoteGrant") &&
      remoteProxy.includes("network_broker::approve_addresses") &&
      remoteProxy.includes("network_broker::connect_happy_eyeballs") &&
      !remoteProxy.includes("fn prohibited_address"),
    "Remote Browser router bypasses the shared NetworkBroker policy",
  ],
  [
    remoteDocument.includes("DOMPurify.sanitize") &&
      remoteDocument.includes("Content-Security-Policy") &&
      remoteDocument.includes('"form"') &&
      remoteDocument.includes('"script"') &&
      remoteBrowserPane.includes('sandbox=""') &&
      !remoteBrowserPane.includes("dangerouslySetInnerHTML"),
    "Remote Browser renderer is not locked to a sanitized static sandbox",
  ],
  [
    remoteClient.includes("MAX_BROWSER_REQUEST_BYTES") &&
      remoteClient.includes("boundedRequestBody") &&
      joinApp.includes(
        'remoteTabSupportsPrivateStream(activeMirrorTab.type, "browser.http")',
      ) &&
      joinApp.includes("browserStream.requestViaHost(activeMirrorTab.id, url)"),
    "Remote Browser mode, private routing or request-body budget is not locked",
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
