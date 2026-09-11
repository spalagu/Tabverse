# V3 平台边界

## Core 与适配器

跨平台语义位于 `packages/runtime-contracts`、`packages/workbench` 和 `crates/tabverse-*`。Tauri、WebView、Keychain/Credential Manager/Secret Service、Launch Services、Windows Registry 和 Linux desktop integration 只位于外层适配器。

`tools/check-workbench-boundary.mjs` 禁止 Core Rust crate 依赖 Tauri，并检查 Workbench、contracts、Desktop runtime 和 Join 的反向依赖。

## Browser

- Desktop 使用官方 Tauri + Wry。
- macOS 使用 WKWebView；Windows 使用 WebView2；Linux 使用 WebKitGTK。
- 不包含 CEF、custom Tauri fork 或双 Runtime。
- Browser is local-only. Join does not render Browser content or proxy Browser traffic through the Host.

## 凭据

凭据记录加密后保存到 `app.db`。机器 master-key bundle 由 macOS Keychain、Windows Credential Manager 或 Linux Secret Service 保护。凭据不写入明文配置或迁移包。

## Runtime IPC

Unix 使用本地 socket，Windows 使用 Named Pipe；不得改成 localhost TCP 服务。Host health、lease 和 generation 语义保持跨平台，平台代码只负责 transport 与系统集成。

## 系统集成

- macOS：Launch Services。
- Windows：当前用户 ProgId/capabilities 与系统默认应用界面。
- Linux：XDG desktop/mime 工具。

OS-specific 实现必须留在 `src-tauri` adapter 或明确的 target module；产品规则、路由、状态 schema 和 Remote 权限不得按 OS 分叉。

## 验收边界

本地开发必须通过 TypeScript、Vitest、Rust fmt/clippy/test、架构检查和当前平台进程级测试。Windows/Linux 的真实 WebView、凭据库、默认应用和 Runtime Host health 只能由对应 runner 或设备证明，不能用 macOS 单测替代。
