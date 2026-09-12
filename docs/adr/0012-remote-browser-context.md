# ADR-0012: Remote Browser Renders Remotely and Uses the Host Network

## Status
Superseded by ADR-0017. The implementation described below has been removed.

## Context and requirements
A Remote device needs access to Host localhost, LAN, VPN, internal DNS, and Host-trusted HTTPS without obtaining the Host Browser session.

## Decision
The Join renderer calls HostNetworkGateway through an independent `Http` data stream. Remote cookies and caches are isolated by authenticated connection and `context_id`; Host cookies, localStorage, DOM, and history are not copied. HostNetworkGateway is the capability boundary, and HTTP(S) is only the first protocol.

## Alternatives rejected
- Direct URL access from Remote: cannot provide Host network reachability.
- Mirroring Host Browser: synchronizes sensitive sessions and degrades into remote desktop behavior.
- Permanently defining an HTTP proxy: blocks future independent WebSocket/TCP streams.

## Cross-platform impact
The Host HTTP client uses platform routing, proxy, DNS, and certificate capabilities while keeping the protocol consistent.

## Remote bandwidth impact
Bodies are raw byte streams, caches support conditional revalidation, and there is no 1 MiB total-size or 30-second total-request limit.

## Migration impact and reversibility
Do not migrate legacy ProxyReq/ProxyRes, base64 bodies, or Host Browser sessions. New protocol types do not change the control flow.
