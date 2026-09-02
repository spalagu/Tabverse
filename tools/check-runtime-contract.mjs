import { readFile } from "node:fs/promises";

const cargo = await readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const rootCargo = await readFile(new URL("../Cargo.toml", import.meta.url), "utf8");
const main = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const lib = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

const checks = [
  [cargo.includes('default = ["runtime-wry"]'), "Wry must remain the default Cargo runtime"],
  [cargo.includes('runtime-wry = ["tauri/wry"]'), "runtime-wry provider feature is missing"],
  [cargo.includes('runtime-cef = ["tauri/cef"]'), "runtime-cef provider feature is missing"],
  [
    rootCargo.match(/tag = "tauri-cef-v3\.0\.0-alpha\.25"/g)?.length === 2,
    "tauri and tauri-build must share the public Alpha.25 tag",
  ],
  [
    main.includes('#[cfg_attr(feature = "runtime-cef", tauri::cef_entry_point)]'),
    "CEF build is missing the CEF multi-process entry point",
  ],
  [
    lib.includes('all(feature = "runtime-wry", feature = "runtime-cef")') &&
      lib.includes("cannot be enabled in the same Tabverse binary"),
    "Wry/CEF same-binary exclusion guard is missing",
  ],
  [
    release.includes("asset_suffix: aarch64.dmg") &&
      release.includes('asset="Tabverse_${version}_${{ matrix.asset_suffix }}"'),
    "default Wry ARM64 asset naming changed",
  ],
  [
    release.includes("asset=\"Tabverse_${version}_aarch64-cef.dmg\"") &&
      release.includes("--features runtime-cef") &&
      release.includes("-- --no-default-features"),
    "macOS ARM64 CEF asset or exclusive build arguments are missing",
  ],
  [
    release.includes("needs: [build, build-cef]") &&
      release.includes("pattern: release-*"),
    "GitHub Release does not wait for both Wry and CEF artifacts",
  ],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) console.error(`runtime-contract: ${failure}`);
  process.exit(1);
}

console.log("runtime-contract: default Wry, opt-in CEF, exclusivity, and artifact naming are locked");
