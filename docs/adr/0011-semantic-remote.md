# ADR-0011：Remote 优先传输语义和数据，不传像素

## 状态
已接受。

## 需求与上下文
Remote 要在低带宽下操作 Host 工作，同时保留功能自身的状态边界。

## 决策
Terminal carries PTY bytes, Agent carries semantic events, Files carries metadata and requested raw content, and Workbench carries snapshots/actions. Browser is local-only and unavailable on Join.

## 备选与拒绝原因
- 默认截图或视频流：带宽高，丢失结构化交互。
- 完整 DOM/本地状态同步：扩大隐私面并耦合 engine 内部状态。

## 跨平台影响
语义协议跨平台；Host 只提供能力 adapter。

## Remote 带宽影响
控制流只传小帧，大正文使用独立 QUIC 流；普通浏览不得持续发送 frame。

## 迁移影响与可逆性
旧像素或 ProxyReq/ProxyRes 路径不迁入。特定像素 fallback 必须另立 ADR。
