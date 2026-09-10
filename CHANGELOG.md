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

- 保留 iroh 端到端加密传输，控制流与大正文数据流分离。
- Terminal 传输终端字节与控制语义，Agent 传输语义事件，Files 按需传输原始文件字节。
- 每条数据流均要求已认证连接、有效 App share 和当前 Steer 权限。

### Remote Browser

- viewer 负责渲染，HTTP/HTTPS 请求经 HostNetworkGateway 从 Host 网络发出。
- 支持 Host localhost、LAN、VPN、内部 DNS、Host 信任链、重定向、相对资源和大响应流式传输。
- fetch、XMLHttpRequest 和 EventSource 使用独立 QUIC HTTP 数据流；正文不进入语义控制流，不使用 base64。
- 每条流和每次重定向重新检查权限；切换标签、AbortSignal 或连接关闭会取消请求。
- Remote Browser 使用独立 cookie jar，不同步 Host Browser 的 cookie、localStorage、DOM 或历史。

### 架构清理

- 不包含 CEF、自定义 Tauri fork、Resident Runtime、Plugin Kernel 或旧 ProxyReq/ProxyRes。
- macOS、Windows 和 Linux 产品语义保持一致，平台机制留在窄 adapter。

### 分发

- 版本升级到 `0.1.0`。
- Release Candidate 可以手动构建，不创建 tag 或 GitHub Release。
- macOS 提供 Apple Silicon 和 Intel DMG，使用 ad-hoc 签名，不使用 Apple Developer ID，也不提交 notarization。
- 所有平台均不依赖付费代码签名服务；发布产物提供 SHA-256 和构建来源信息。
