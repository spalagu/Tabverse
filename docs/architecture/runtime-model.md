# V3 Runtime Supervisor

## Ownership

The windowed GUI does not own `LiveProcess`. The signed Tabverse executable starts a
windowless Runtime Supervisor with
`--helper <app-data-dir> <endpoint-cache-dir> <content-dir>`. The Supervisor is the only
writer of `runtime.db`.

```text
GUI client
├── Terminal local socket / Windows named pipe
└── Agent local socket / Windows named pipe
        ↓
Runtime Supervisor
├── Terminal PTY LiveProcess
├── Agent LiveProcess
└── runtime.db lease, heartbeat, generation, and state
```

The IPC bootstrap token travels through an anonymous stdin pipe and is never written to the
endpoint record. Agent IPC uses a bidirectional HMAC challenge. Unix endpoint records use
owner-only permissions and live in the platform cache directory, not durable application
data. `runtime.db` lives in the application-data directory.

## Lifecycle

- Create: the Supervisor creates a LiveProcess and records its generation and attachment.
- GUI detach: GUI egress disconnects while the LiveProcess continues.
- GUI restart/reattach: the new client obtains a new generation; stale mutations are refused.
- Logical tab close: the LiveProcess is terminated explicitly and recorded as stopped.
- Supervisor failure: a later Host marks expired non-stopped leases interrupted; no process
  recovery is fabricated.
- An empty Supervisor exits after its idle window. Any Terminal or Agent LiveProcess keeps it
  alive.

## Storage rules

`app.db` owns durable structured application state. `runtime.db` owns runtime identity,
generation, state, Host instance, and required checkpoints. The GUI never writes
`runtime.db`. Neither database imports removed JSON or vault formats.

Registered scalar settings use `app.db.settings`. Profiles, templates, shortcuts, and Files
walk rules remain declarative configuration. Agent transcripts are append-only JSONL content
under the application content directory.

## Verification

`src-tauri/tests/runtime_supervisor_process.rs` starts a real `tabverse --helper` child and
checks Terminal continuation and Agent handle reattachment across two GUI clients.
`crates/tabverse-runtime` separately verifies writer leases, stale Hosts, interrupted state,
and the absence of fabricated recovery.
