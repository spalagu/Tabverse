# ADR-0011: Remote Prioritizes Semantics and Data, Not Pixels

## Status
Accepted.

## Context and requirements
Remote must operate Host work over low bandwidth while preserving each feature's state boundary.

## Decision
Terminal carries PTY bytes, Agent carries semantic events, Files carries metadata and requested raw content, and Workbench carries snapshots/actions. Browser is local-only and unavailable on Join.

## Alternatives rejected
- Screenshots or video streams by default: consume high bandwidth and lose structured interaction.
- Full DOM or local-state synchronization: expands the privacy surface and couples engine internals.

## Cross-platform impact
The semantic protocol is cross-platform; the Host provides only capability adapters.

## Remote bandwidth impact
The control flow carries only small frames, while large bodies use independent QUIC streams. Normal browsing must not continuously transmit frames.

## Migration impact and reversibility
Do not import legacy pixel or ProxyReq/ProxyRes paths. A feature-specific pixel fallback requires a separate ADR.
