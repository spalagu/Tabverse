# V3 性能与带宽基线

## Remote Browser 传输

基线命令：

```bash
cargo test -p tabverse-remote \
  control_and_large_http_data_streams_share_one_iroh_connection -- --nocapture
```

该测试使用两个 loopback iroh endpoint、一个 Host-only HTTP origin 和独立控制流。统计值来自加密 QUIC 连接的 UDP datagram 计数，包含协议帧、ACK 和传输开销，不只是应用正文。

2026-09-10 在 Apple Silicon macOS 的本地结果：

| 项目 | 数值 |
| --- | ---: |
| HTTP 正文字节 | 1,245,184 |
| Host → Remote QUIC 字节 | 1,279,379 |
| Remote → Host QUIC 字节 | 14,916 |
| 完成时间 | 74 ms |

回归门不固定机器相关时间，而固定架构属性：Host → Remote 总量必须至少覆盖正文且小于正文的两倍，Remote → Host 必须小于 256 KiB，并且大响应期间原控制流仍能收发 marker。该门会拦截普通导航退化为持续像素流或大正文回到控制帧的实现。

## 其他性能项

Terminal/Agent GUI 重连由 `src-tauri/tests/runtime_supervisor_process.rs` 的真实进程边界测试覆盖；HTTP 缓存复用由 `tabverse-network` 的 fresh-cache 和 ETag 重验证测试覆盖。Browser/Terminal 常驻内存、完整 GUI 冷启动时间和真实 VPN/LAN 延迟属于验收构建的设备数据，不用单机 loopback 数值代替。
