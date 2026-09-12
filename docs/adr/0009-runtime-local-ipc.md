# ADR-0009: Runtime Uses Platform-Local IPC

## Status
Accepted.

## Context and requirements
The GUI and Runtime Supervisor need authenticated, streaming IPC without exposing a network port.

## Decision
Use an owner-only Unix domain socket on Unix and a Named Pipe on Windows. The handshake token never enters subsequent wire payloads, and frame size is bounded.

## Alternatives rejected
- Localhost TCP: adds port discovery, firewall concerns, and a probe surface for other local users.
- File polling: cannot carry real-time terminal and Agent events.

## Cross-platform impact
Transport is platform-specific; frame, authentication, generation, and error semantics are shared.

## Remote bandwidth impact
IPC remains local to the Host; Remote traffic still uses iroh.

## Migration impact and reversibility
Do not read legacy TCP endpoints. A transport adapter can be replaced independently without changing the runtime protocol.
