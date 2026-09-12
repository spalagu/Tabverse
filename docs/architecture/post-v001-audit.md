# Post-v0.0.1 audit

V3 starts from tag `v0.0.1` (`a2501d142d55669219967c8c1117023dd3394944`). Later history is a **knowledge source**, not the code foundation.

Every meaningful change after `v0.0.1` must be classified before it is forward-ported:

- **PORT** — behavior/correctness fix remains valid and can be carried over mostly unchanged.
- **REIMPLEMENT** — the requirement is valid, but the old mechanism conflicts with V3.
- **DROP** — tied to an abandoned architecture or no longer a product requirement.
- **SUPERSEDED** — V3 solves the underlying problem in a different way.

## Architecture epochs

| Change/area | V3 decision | Reason |
| --- | --- | --- |
| Plugin Kernel / dynamic built-in plugin lifecycle | DROP / REIMPLEMENT as Feature Modules | Built-in modularity is required; runtime package-manager semantics are not. |
| Resident Runtime V1 | SUPERSEDED by Runtime V3 | Keep GUI-independent task lifetime requirement; replace process/service/lifecycle model. |
| Tab state versioning/migration | SUPERSEDED | V3 accepts only its current session and Feature Module state formats. SQLite may use forward-only schema evolution, but the product contains no old-format importer. |
| Remote semantic snapshot/action evolution | PORT/REIMPLEMENT selectively | Fits V3 low-bandwidth Remote philosophy. |
| Remote Browser and ProxyReq/ProxyRes | DROP | Browser is local-only; Join does not render or proxy Browser tabs. |
| CEF / runtime-cef / custom Tauri fork | DROP | Product testing preferred Wry; dual runtime complexity has no V3 value. |
| CEF packaging/helper/release fixes | DROP | Only serve abandoned CEF architecture. |
| Generic remote browser network broker | DROP | Local Browser networking remains in the Wry adapter; Remote has no Browser network path. |
| Credential persistence requirement | PORT requirement, REIMPLEMENT mechanism | Password save/fill is core; V3 uses CredentialVault + OS-backed master key. |
| Broad file association coverage | PORT product intent, REIMPLEMENT source of truth | One-App capability is core; generate associations from ContentTypeCatalog. |
| FS/session migration and race fixes | REVIEW individually | Port only current-format correctness fixes. Do not port format conversion or compatibility code. |
| Remote sanitization/security correctness fixes | REVIEW and PORT when still relevant | Concrete correctness/security fixes survive architecture changes. |
| CI portability and quality fixes | REVIEW and PORT when applicable | Do not port CEF-specific gates; retain generally useful CI improvements. |

## Known later commits already classified

- `7ff273978f78b5195bc8d7579a3aec41f934a9b7` — large Plugin Kernel + Resident architecture change: **REIMPLEMENT/SUPERSEDE**, do not cherry-pick wholesale.
- `58ad06d090ce54b13ef8f11c0fcc5e45d18b1be8` — `v0.0.2` versioning, Resident acceptance, and related release changes: **DROP/SUPERSEDED**. V3 establishes a new baseline from `v0.0.1` and does not inherit the Resident delivery model. The general release-source check is reimplemented for the final V3 release pipeline.
- `f6eeb2b2852128a2bdeaa2e9ee3d26f00b2e32a1` mixed Wry/CEF runtimes, a network broker, Remote Browser, and RC verification. **DROP CEF, dual runtimes, and Remote Browser; REVIEW/PORT only generally useful release verification.** Never cherry-pick the commit wholesale.
- `7c09ccfbc366c907b75b4ba0f91face043b75bf8` — safe cold-start ordering for CEF release mutation: **SUPERSEDED**. CEF and the legacy runtime contract are removed. Any equivalent mutation in the final V3 release flow must be proved again against current build artifacts.
- `da097e13bca675e792a85f5f7305cddf9b24866d` — CEF helper installation fix: **DROP** because CEF is dropped.
- `8150b32bda59e8d7d062afe1cc5789dff422ad71` — portable release performance parser: **REVIEW/PORT** if still relevant to the Wry-only release pipeline.
- `6b9f46affbc8c7ef8c7b4cc0723c36ed75be0ab8` — simplified GitHub CI gates: **REVIEW/PORT** after V3 CI shape is established.
- `0763e7e1010d8ad29f830277167d99247869a8ca` — npm audit fix: **PORT REQUIREMENT / REIMPLEMENT DEPENDENCY SET**. Do not copy the lockfile. V3 meets the same security goal with Vitest `4.1.11`, `@xmldom/xmldom` `0.8.15`, and the restored Security gate.
- `ac02d7852ce920683e63fb5745fe9e66f914b584` — manual macOS Apple Silicon/Intel acceptance artifacts: **REIMPLEMENT**. Keep the requirement, but regenerate the workflow for a stable V3 codebase, Wry-only builds, and the current acceptance checklist instead of copying files from the old branch.
- `4225d38288c3fbef17693a4f0d27e7ae404b2adc` — macOS acceptance artifact checksum-path fix: **PORT REQUIREMENT**. The final V3 workflow must generate and verify checksums for the actual uploaded paths; rebuild it together with `ac02d78`.
- `b20809bffde24694669a92134f30f41a97c9c4d6` — register the manual V3 macOS acceptance workflow on the default branch: **PORT**. The commit provides only the GitHub `workflow_dispatch` entry point and acceptance instructions. Keep the same workflow for V3 release candidates without carrying forward legacy architecture.

All eleven commits listed in the then-current GitHub `v0.0.1..main` range are classified. Refresh `main` from GitHub before creating the final PR and append audit decisions for any new commits.

## Rule for forward-porting

Do not cherry-pick a later commit merely because it contains a useful fix. Reproduce the underlying issue against V3, add a V3-native test, then implement the fix inside the V3 boundaries. This prevents obsolete Plugin/Resident/CEF dependencies from leaking back into the new branch.
