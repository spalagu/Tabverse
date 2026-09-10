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
- `58ad06d090ce54b13ef8f11c0fcc5e45d18b1be8` — `v0.0.2` 版本号、Resident 验收和对应发布调整：**DROP/SUPERSEDED**。V3 从 `v0.0.1` 建立新基线，不继承 Resident 交付模型；通用发布源检查在最终 V3 发布流水线中按现状重新实现。
- `f6eeb2b2852128a2bdeaa2e9ee3d26f00b2e32a1` — Wry/CEF 双 Runtime、Network Broker、Remote Browser 和 RC 验证的大型混合提交：**DROP CEF 与双 Runtime；REIMPLEMENT Remote Browser；REVIEW/PORT 通用发布验证**。不得整体 cherry-pick；V3 已用 Wry、HostNetworkGateway、独立数据流和隔离 Remote Browser renderer 重建有效需求。
- `7c09ccfbc366c907b75b4ba0f91face043b75bf8` — CEF Release 安全 mutation 冷启动顺序：**SUPERSEDED**。CEF 与旧 runtime contract 已移除；若 V3 最终发布流程存在同类 mutation，只通过当前构建产物测试重新证明。
- `da097e13bca675e792a85f5f7305cddf9b24866d` — CEF helper installation fix: **DROP** because CEF is dropped.
- `8150b32bda59e8d7d062afe1cc5789dff422ad71` — portable release performance parser: **REVIEW/PORT** if still relevant to the Wry-only release pipeline.
- `6b9f46affbc8c7ef8c7b4cc0723c36ed75be0ab8` — simplified GitHub CI gates: **REVIEW/PORT** after V3 CI shape is established.
- `0763e7e1010d8ad29f830277167d99247869a8ca` — npm audit 修复：**PORT REQUIREMENT / REIMPLEMENT DEPENDENCY SET**。不复制锁文件；V3 已通过 Vitest `4.1.11`、`@xmldom/xmldom` `0.8.15` 和恢复后的 Security gate 满足相同安全目标。
- `ac02d7852ce920683e63fb5745fe9e66f914b584` — macOS Apple Silicon/Intel 手动验收 artifact：**REIMPLEMENT**。需求保留，但 workflow 必须在 V3 代码稳定后按 Wry-only 构建和当前验收清单重新生成，不复制旧分支文件。
- `4225d38288c3fbef17693a4f0d27e7ae404b2adc` — macOS 验收 artifact checksum 路径修复：**PORT REQUIREMENT**。最终 V3 workflow 必须对实际上传路径生成和验证 checksum；实现随 `ac02d78` 一起重建。
- `b20809bffde24694669a92134f30f41a97c9c4d6` — 在默认分支注册 V3 macOS 手动验收 workflow：**PORT**。该提交只提供 GitHub `workflow_dispatch` 入口和验收说明；V3 Release Candidate 保留同一 workflow，不带入旧架构实现。

GitHub `main` 当前列出的 `v0.0.1..main` 十一个提交已全部分类。创建最终 PR 前仍需从 GitHub 刷新 `main`，若出现新增提交，必须先追加审计决定。

## Rule for forward-porting

Do not cherry-pick a later commit merely because it contains a useful fix. Reproduce the underlying issue against V3, add a V3-native test, then implement the fix inside the V3 boundaries. This prevents obsolete Plugin/Resident/CEF dependencies from leaking back into the new branch.
