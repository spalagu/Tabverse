# Tabverse 变更记录

## 0.1.0 — V3

### 工作区与持久化

- 以 Workspace 和 Tab 为统一工作上下文。
- 使用 `app.db` 持久化 Workspace、Tab、设置和内容偏好，并对历史状态执行事务性、可重试迁移。
- 长任务由按需 Runtime Supervisor 管理；Terminal 和 Agent 任务可跨 GUI 重启继续运行。

### One-App 内容能力

- 内置 Terminal、Agent、Files、Browser 和 Settings Feature Modules，不引入 Plugin Kernel。
- 统一 OpenIntent、ContentRegistry 和文件关联目录。
- 常见技术文件可在 Tabverse 内预览；自然适合编辑的文本内容支持编辑与保存。

### Remote

- Retains end-to-end encrypted iroh transport and separates semantic control from raw file data.
- Terminal carries terminal bytes and control semantics, Agent carries structured events, and Files transfers requested raw bytes.
- File streams require an authenticated connection and a current App-share viewer.
- Browser is local-only. Join displays Browser rows as unavailable and carries no Browser pixels, state, or network traffic.

### 架构清理

- 不包含 CEF、自定义 Tauri fork、Resident Runtime、Plugin Kernel 或旧 ProxyReq/ProxyRes。
- Remote Browser document rewriting, HostNetworkGateway, and HTTP data streams are removed.
- macOS、Windows 和 Linux 产品语义保持一致，平台机制留在窄 adapter。

### 分发

- 版本升级到 `0.1.0`。
- Release Candidate 可以手动构建，不创建 tag 或 GitHub Release。
- macOS 提供 Apple Silicon 和 Intel DMG，使用 ad-hoc 签名，不使用 Apple Developer ID，也不提交 notarization。
- 所有平台均不依赖付费代码签名服务；发布产物提供 SHA-256 和构建来源信息。
