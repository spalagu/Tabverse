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
- production HTTP uses a mature `reqwest` client with Host-side system proxy support;
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

## Browser state
`context_id` identifies Remote Browser context state. It deliberately does not identify or synchronize a local Wry BrowserSession. Cookie/cache layers may later key their own state by this context without changing the data transport.

## Rejected alternatives

### Host Browser pixel streaming
Rejected as the default because it sends rendered pixels when the actual required capability is Host network reachability.

### Keep `ProxyReq` / `ProxyRes` with larger limits
Rejected because the old mechanism still base64-encodes bodies inside control JSON, buffers whole responses and makes HTTP request/response data compete with semantic control traffic.

### Define Host networking permanently as an HTTP proxy
Rejected because future Browser compatibility may require WebSocket or other Host-side connections. HTTP is an implementation stage, not the architecture boundary.

## Cross-platform impact
The gateway uses ordinary Host networking APIs through a mature cross-platform Rust HTTP client. Platform-specific routing, VPN, DNS and proxy mechanics remain OS concerns rather than Tabverse Core branches.
