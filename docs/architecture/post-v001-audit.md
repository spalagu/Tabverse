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
| Tab state versioning/migration | REIMPLEMENT | Good requirement; keep explicit state versions and non-destructive migration. |
| Remote semantic snapshot/action evolution | PORT/REIMPLEMENT selectively | Fits V3 low-bandwidth Remote philosophy. |
| Remote Browser ProxyReq/ProxyRes | REIMPLEMENT | Correct host-network direction; old HTTP/base64/body-limit implementation is only a prototype. |
| CEF / runtime-cef / custom Tauri fork | DROP | Product testing preferred Wry; dual runtime complexity has no V3 value. |
| CEF packaging/helper/release fixes | DROP | Only serve abandoned CEF architecture. |
| Generic browser network broker / custom DNS/DoH | DROP unless independently required | V3 uses native Wry networking locally and HostNetworkGateway for Remote. |
| Credential persistence requirement | PORT requirement, REIMPLEMENT mechanism | Password save/fill is core; V3 uses CredentialVault + OS-backed master key. |
| Broad file association coverage | PORT product intent, REIMPLEMENT source of truth | One-App capability is core; generate associations from ContentTypeCatalog. |
| FS/session migration and race fixes | REVIEW individually | Likely correctness value independent from abandoned architecture. |
| Remote sanitization/security correctness fixes | REVIEW and PORT when still relevant | Concrete correctness/security fixes survive architecture changes. |
| CI portability and quality fixes | REVIEW and PORT when applicable | Do not port CEF-specific gates; retain generally useful CI improvements. |

## Known later commits already classified

- `7ff273978f78b5195bc8d7579a3aec41f934a9b7` — large Plugin Kernel + Resident architecture change: **REIMPLEMENT/SUPERSEDE**, do not cherry-pick wholesale.
- `da097e13bca675e792a85f5f7305cddf9b24866d` — CEF helper installation fix: **DROP** because CEF is dropped.
- `8150b32bda59e8d7d062afe1cc5789dff422ad71` — portable release performance parser: **REVIEW/PORT** if still relevant to the Wry-only release pipeline.
- `6b9f46affbc8c7ef8c7b4cc0723c36ed75be0ab8` — simplified GitHub CI gates: **REVIEW/PORT** after V3 CI shape is established.

The remaining commits between `v0.0.1` and `main` must be added to this table before later-history migration work is considered complete.

## Rule for forward-porting

Do not cherry-pick a later commit merely because it contains a useful fix. Reproduce the underlying issue against V3, add a V3-native test, then implement the fix inside the V3 boundaries. This prevents obsolete Plugin/Resident/CEF dependencies from leaking back into the new branch.
