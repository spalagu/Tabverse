# ADR-0006：Desktop Browser 只使用 Wry

## 状态
已接受。

## 需求与上下文
Desktop Browser 需要使用各平台原生 WebView，同时避免 CEF、双 Runtime 和自定义 Tauri fork。

## 决策
使用官方 Tauri + Wry：macOS 使用 WKWebView，Windows 使用 WebView2，Linux 使用 WebKitGTK。平台事件只在 `src-tauri` adapter 内处理。

## 备选与拒绝原因
- CEF：增加第二套运行时、打包链和安全更新责任。
- 自定义 Tauri fork：扩大长期维护面，现有能力不需要。

## 跨平台影响
产品语义相同；WebView 事件接线允许按平台实现。

## Remote 带宽影响
The local Browser engine does not enter the Remote data plane. Browser tabs are unavailable on Join.

## 迁移影响与可逆性
V3 不迁入 CEF 状态或 helper。未来更换 engine 属于新的架构决策，不能在现有 adapter 内暗中增加第二套 runtime。
