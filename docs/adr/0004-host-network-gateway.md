# ADR-0004: Remote Browser delegates network capability through HostNetworkGateway

## Status
Accepted.

## Requirement
A Remote Browser must be able to reach resources that are reachable from the Host environment even when the remote device itself cannot reach them. Initial examples include Host localhost, LAN services, VPN routes and Host-resolved internal DNS names.

Remote bandwidth should remain low. Remote Browser does not need the Host Browser's pixels, cookies, localStorage, DOM or history merely to gain Host network reachability.

## Decision
V3 introduces a transport-neutral `tabverse-network` crate and a `HostNetworkGateway` HTTP implementation.

For HTTP(S):

- request/response metadata uses small bounded JSON frames;
- request and response bodies travel as raw stream bytes;
- bodies are streamed with backpressure rather than buffered in full;
- there is no architecture-level 1 MiB response ceiling;
- there is no whole-exchange 30 second deadline;
- DNS resolution and outgoing connections happen on the Host;
- `tabverse-network` consumes an injected `reqwest::Client` instead of constructing one itself;
- the Host adapter constructs that client through the application's canonical HTTP client factory, so DNS, proxy, TLS, redirect and timeout policy have one construction boundary;
- the Remote Browser Host client uses Host network routing/system proxy behavior appropriate to this capability;
- redirects are surfaced instead of silently consumed so Remote Browser navigation can remain coherent.

The data-stream protocol version is independent from the semantic Remote control protocol. HTTP is the first `DataStreamKind`, not the permanent definition of Host networking. WebSocket and raw TCP may be added as new stream kinds when required.

## Remote transport shape
The existing iroh connection remains the encrypted transport. The intended next integration is:

```text
one long-lived control stream
+
zero or more independent bidirectional data streams
```

Each data stream begins with a small preface describing its kind and Remote Browser context. An HTTP stream then carries a request head followed by raw request body bytes until EOF; the reverse direction carries a response-start frame followed by raw response bytes until EOF.

The preface is routing metadata, not an authorization token. Host network capability must only be attached to a connection after the existing Remote share authentication and viewer-access checks have succeeded; a caller-controlled `context_id` must never grant or widen access.

## Browser state
`context_id` identifies Remote Browser context state. It deliberately does not identify or synchronize a local Wry BrowserSession.

当前实现由 HostNetworkGateway 按 Remote 连接隔离 cookie 和 HTTP 缓存，并在连接内继续按 `context_id` 隔离。缓存键包含目标 URL 和 `Vary` 指定的请求头；实现支持 `Cache-Control`、`Expires`、`ETag`、`Last-Modified` 和条件重验证。正文仍先流向 Remote，同时在有界内存中旁路收集可缓存响应；单项上限 16 MiB、连接总上限 64 MiB。缓存命中仍要求建立新的已认证数据流，因此每次请求都会先经过当前 App share 和 Steer 权限检查。`context_id` 仍然只是状态路由键，不是授权凭据。

## Dependency boundary
`tabverse-network` owns the streaming protocol and HTTP exchange mechanics, not operating-environment policy. It must remain usable without Tauri and must not create HTTP clients on its own.

The desktop Host adapter owns construction of the concrete HTTP client. This keeps the dependency direction explicit:

```text
Remote transport / Core
        ↓
HostNetworkGateway
        ↓
injected HTTP client
        ↓
Host adapter / canonical client factory
```

This is the same Port/Adapter rule used elsewhere in V3: product/runtime semantics stay in Tabverse-owned core code, while environment-specific plumbing is supplied from the outer adapter layer.

## Rejected alternatives

### Host Browser pixel streaming
Rejected as the default because it sends rendered pixels when the actual required capability is Host network reachability.

### Keep `ProxyReq` / `ProxyRes` with larger limits
Rejected because the old mechanism still base64-encodes bodies inside control JSON, buffers whole responses and makes HTTP request/response data compete with semantic control traffic.

### Define Host networking permanently as an HTTP proxy
Rejected because future Browser compatibility may require WebSocket or other Host-side connections. HTTP is an implementation stage, not the architecture boundary.

### Let `tabverse-network` create its own reqwest client
Rejected because it would create a second HTTP-policy construction boundary outside the application's existing network factory. A Tauri-independent core crate should consume the capability it needs, not decide Host DNS/proxy/TLS policy for itself.

## Cross-platform impact
The gateway uses ordinary Host networking through an injected mature cross-platform Rust HTTP client. Platform-specific routing, VPN, DNS and proxy mechanics remain Host adapter / OS concerns rather than Tabverse Core branches.
