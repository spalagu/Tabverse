# ADR-0008: Runtime Uses an On-Demand Sidecar

## Status
Accepted.

## Context and requirements
Terminal and Agent live processes should survive GUI restarts, but nonexistent processes must not be reported as recovered.

## Decision
Start the Runtime Supervisor on demand by running the same signed Tabverse executable in windowless helper mode. Exit after the idle window when no live process remains.

## Alternatives rejected
- Resident service: adds installation, upgrade, and permission lifecycles.
- GUI-owned processes: exiting the GUI terminates work.
- A generic worker per feature: duplicates lifecycle and database ownership.

## Cross-platform impact
Supervisor semantics are shared; platform adapters implement startup and local transport.

## Remote bandwidth impact
No additional periodic Remote traffic; only existing feature semantics are transmitted.

## Migration impact and reversibility
The legacy Resident service is not imported. The sidecar can stop with the application and start again on demand.
