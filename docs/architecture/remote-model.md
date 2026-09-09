# V3 Remote 模型

## 传输与能力

Remote 使用 iroh 的端到端加密连接。第一条双向流承载小型语义控制帧；HTTP 正文等大数据使用同一连接上的独立 QUIC 双向流。

```text
认证连接
├── 控制流：snapshot、action、presence、access、Agent event
└── 数据流：preface + bounded head + raw bytes
```

控制流不承载 HTTP body，不使用 base64，也不等待完整响应。

## 授权边界

- ticket 建立连接身份，不能直接授权网络请求。
- App share 存在且 viewer 当前为 Steer 时，才允许接受新的 Browser 数据流。
- 每条流在 Host I/O 前重新读取权限；重定向通过新流再次检查。
- View 可以读取已经同步的语义状态，但不能发起新的 Browser 网络流。
- `context_id` 只选择 Remote Browser cookie/cache 状态，不能扩大权限。

实现边界位于 `crates/tabverse-remote/src/lib.rs` 和 `crates/tabverse-remote/src/bridge/data_stream.rs`。

## 各功能的 Remote 语义

- Terminal：PTY 字节、尺寸和 attach snapshot。
- Agent：Prompt、Cancel、Answer 和 `SessionEvent`，不传屏幕像素。
- Files：目录/元数据和按需内容，不镜像整个文件系统。
- Workbench：snapshot 加语义 action。
- Browser：Remote 端渲染；网络从 Host 发出。

## 扩展

`DataStreamKind` 当前只有 HTTP。协议版本与控制协议独立；WebSocket 和 TCP 必须作为新的独立数据流种类加入，不能退化成控制流 RPC 或轮询。
