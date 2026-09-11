# ADR-0012：Remote Browser 在 Remote 渲染并使用 Host 网络

## Status
Superseded by ADR-0017. The implementation described below has been removed.

## 需求与上下文
Remote 设备需要访问 Host localhost、LAN、VPN、内部 DNS 和 Host 信任的 HTTPS，但不应取得 Host Browser 会话。

## 决策
Join renderer 经独立 `Http` 数据流调用 HostNetworkGateway。Remote cookie/cache 按认证连接和 `context_id` 隔离；不复制 Host cookie、localStorage、DOM 或 history。HostNetworkGateway 是能力边界，HTTP(S) 只是首个协议。

## 备选与拒绝原因
- Remote 直接访问 URL：无法获得 Host 网络可达性。
- 镜像 Host Browser：同步敏感会话并退化为远程桌面。
- 永久定义为 HTTP proxy：阻碍后续 WebSocket/TCP 独立流。

## 跨平台影响
Host HTTP client 使用各平台系统路由、proxy、DNS 和证书能力；协议一致。

## Remote 带宽影响
body 是原始字节流；缓存支持条件重验证；无 1 MiB 总量或 30 秒总请求限制。

## 迁移影响与可逆性
不迁移旧 ProxyReq/ProxyRes、base64 body 或 Host Browser session。新增协议类型不改变控制流。
