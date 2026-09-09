# ADR-0009：Runtime 使用平台本地 IPC

## 状态
已接受。

## 需求与上下文
GUI 与 Runtime Supervisor 需要认证、可流式传输且不暴露网络端口的 IPC。

## 决策
Unix 使用 owner-only Unix domain socket，Windows 使用 Named Pipe。握手 token 不进入后续 wire payload；frame 大小有上限。

## 备选与拒绝原因
- localhost TCP：增加端口发现、防火墙和本机其他用户探测面。
- 文件轮询：不能承载实时终端和 Agent event。

## 跨平台影响
transport 分平台，frame、认证、generation 和错误语义共享。

## Remote 带宽影响
IPC 只在 Host 本机；Remote 仍走 iroh。

## 迁移影响与可逆性
不读取旧 TCP endpoint。transport adapter 可单独替换，不改变 runtime protocol。
