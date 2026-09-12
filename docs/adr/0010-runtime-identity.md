# ADR-0010: Separate Runtime Identity from Process Identity

## Status
Accepted.

## Context and requirements
PIDs are reused, the GUI reconnects, and stale clients must not continue writing to a new Host.

## Decision
Store the stable runtime ID, Host instance, generation, lease, and state in `runtime.db`. Mutation requests must match the current generation. Record a stale Host as interrupted instead of fabricating recovery.

## Alternatives rejected
- PID as identity: restarts and PID reuse create false associations.
- Reconnection without a generation: stale clients can overwrite new sessions.
- Automatic replay: may repeat operations with side effects.

## Cross-platform impact
Identity and lease rules are fully shared; process detection is a platform adapter.

## Remote bandwidth impact
Transmit only required session events, never the runtime database.

## Migration impact and reversibility
Do not reuse legacy Resident identities. Interrupted records can be cleared but cannot be rewritten as recovered.
