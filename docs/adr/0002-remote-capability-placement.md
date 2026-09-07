# ADR-0002: Remote uses capability placement, not remote-desktop replication

## Status
Accepted.

## Context
Tabverse Remote must minimize data transfer while preserving useful host capabilities. A single "host executes and remote receives pixels" model wastes bandwidth and is wrong for several feature domains.

The Browser requirement in particular is initially **host-network reachability**, not synchronization with the host's local BrowserSession. Remote cookies/storage/history may be independent.

## Decision
Each feature places execution, data and rendering according to where capabilities must physically exist and where rendering is most data-efficient.

Initial placement:

- Terminal: host PTY/shell execution; remote terminal rendering from semantic/byte stream.
- Agent: host execution; remote rendering from structured events/actions.
- Files: host filesystem; remote rendering from metadata and requested content.
- Browser: remote rendering/browser context; network requests delegated through the host network environment.

Remote data representation preference is:

1. semantic state/actions;
2. native domain streams;
3. delegated host capability;
4. requested content/data;
5. visual frames;
6. full pixel streaming.

Pixel streaming is a fallback, not the default Browser Remote architecture.

## Browser consequences
A remote Browser does not need the host Browser's cookies, localStorage, DOM or history. Its HTTP/WebSocket traffic must be able to originate through the host network path so host localhost/LAN/VPN/DNS reachability is available.

The host-network abstraction must not permanently be defined as an HTTP proxy. HTTP(S) is the first implementation; WebSocket/TCP can be added later without changing the Remote philosophy.

## Bandwidth consequence
Bulk bodies must use streaming/raw-byte transports rather than base64-in-JSON control frames. Architecture reviews should treat unnecessary pixel transport as a regression unless a feature genuinely requires it.
