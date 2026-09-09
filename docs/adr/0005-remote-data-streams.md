# ADR-0005: Remote uses independent QUIC data streams beside the control stream

## Status
Accepted.

## Requirement
Remote semantic control traffic must stay responsive while Browser networking, file content, downloads, or other large payloads are in flight. V3 also requires bulk payloads to avoid base64 JSON framing.

## Decision
One authenticated iroh connection carries:

```text
stream 1: long-lived semantic control stream
stream N: independent bidirectional data stream
```

The first bidirectional stream remains the existing control protocol. After that stream has authenticated the viewer, the Host may accept additional bidirectional streams and dispatch them from a small `DataStreamPreface`.

当前实现包含两种数据流：`Http` 承载 Remote Browser 请求和响应正文，`FileRead` 按范围承载 Files 选中文件的原始字节。目录元数据、文件操作结果和其他小型状态仍走语义控制流。WebSocket、raw TCP 等后续能力必须继续增加独立数据流类型，不能把大正文放回控制消息。

Host 在每条流开始 I/O 前重新读取当前 App share 和 viewer 权限。`Http` 要求 Steer；只读的 `FileRead` 允许 View、Steer 和 Approve。`context_id` 仅用于状态路由，不参与授权。文件路径由 Host Files 后端校验，Remote transport 不自行解析路径。

## Isolation
Large data responses do not travel through the control channel and therefore do not occupy its JSON frame queue. QUIC stream-level multiplexing provides backpressure and isolates independent streams on the same encrypted connection.

Authentication remains connection-scoped: data streams are accepted only after the connection's control stream has successfully authenticated a Share ticket. The data-stream bridge does not create a second authentication protocol.

## Test requirement
A real iroh roundtrip must prove that:

1. stream 1 can carry a control marker;
2. a separate HTTP data stream can fetch Host `localhost` content larger than the old 1 MiB proxy ceiling;
3. the original control stream is still usable after the large response completes.
4. View 可以读取超过 1 MiB 的文件原始字节，但同一 View viewer 不能开启 HTTP；升级回 Steer 后 HTTP 恢复；
5. Files 标签切换会取消尚未完成的 `FileRead` 流，且文件正文不经过 `fs_read` RPC。
