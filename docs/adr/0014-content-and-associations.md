# ADR-0014：常见内容和文件关联属于 One-App 核心

## 状态
已接受。

## 需求与上下文
Markdown、代码、表格、图片、PDF、归档、SQLite、Office 和媒体内容需要统一打开语义及系统关联。

## 决策
`resources/content-types.json` 是内容类型单一目录；生成 runtime registry、Tauri bundle associations 和检查。所有入口归一为 `OpenIntent`，再由 ContentHandler 路由或安全 fallback。

## 备选与拒绝原因
- 各平台手写扩展名：目录会漂移。
- 在 React 组件散落 suffix 判断：无法覆盖 OS ingress。
- 静默抢占默认应用：违背用户控制。

## 跨平台影响
内容目录共享；Launch Services、Windows ProgId 和 XDG 注册由 adapter 生成。

## Remote 带宽影响
Files Remote 只传请求的元数据、预览和内容，不镜像文件系统。

## 迁移影响与可逆性
旧分散关联不作为权威源。关联声明可重新生成，默认应用变更由系统 UX 管理。
