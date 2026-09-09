# ADR-0015：平台机制留在 adapter，功能完整优先

## 状态
已接受。

## 需求与上下文
V3 要跨平台交付现有核心能力，同时避免为假设性威胁、插件或通用 manager 延迟功能闭环。

## 决策
OS API、WebView 回调、SecretStore、默认应用和进程 transport 留在 `src-tauri` target adapter。Core 只持有跨平台语义。先完成可运行功能、迁移和验收，再依据测量处理性能与安全加固。

## 备选与拒绝原因
- 在 Core 中散布 `cfg` 平台机制：污染领域边界。
- 预先构建 Plugin Kernel、通用 Worker 或 NetworkManager：没有当前用户需求。
- 用未验证 hardening 代替功能：不能证明产品可用。

## 跨平台影响
每个平台必须实际构建和验收；macOS 结果不能替代 Windows/Linux。

## Remote 带宽影响
平台 adapter 不改变最小语义传输规则；优化必须有数据。

## 迁移影响与可逆性
adapter 可逐个平台替换。任何新的架构层或功能降级必须单独审查，不能借平台差异引入。
