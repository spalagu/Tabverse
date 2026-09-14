# V3 Runtime Supervisor

## Ownership

The windowed GUI does not own `LiveProcess` instances. The same signed Tabverse executable starts a windowless Runtime Supervisor with `--helper <state-dir>`. The supervisor is the sole writer of `runtime.db`.

```text
GUI client
├── Terminal local socket / Windows Named Pipe
└── Agent local socket / Windows Named Pipe
        ↓
Runtime Supervisor
├── Terminal PTY LiveProcess
├── Agent LiveProcess
└── runtime.db lease, heartbeat, generation, and state
```

The IPC bootstrap token reaches the child through an anonymous stdin pipe and is never written to the endpoint file. Agent IPC uses a bidirectional HMAC challenge; the token never appears on the protocol wire. Endpoint files use mode `0600` on Unix.

## Lifecycle

- Create: the supervisor creates a `LiveProcess` and records its generation and attached state.
- GUI detach: GUI egress disconnects while the `LiveProcess` keeps running.
- GUI restart or reattach: the new client receives a new generation; mutation requests from the old client are rejected.
- Logical tab close: the `LiveProcess` is explicitly terminated and recorded as stopped.
- Supervisor failure: after its lease expires, a new Host marks non-stopped records as interrupted without pretending to recover their processes.
- An empty supervisor exits after its idle window. Any Terminal or Agent `LiveProcess` keeps it alive.

## Database rules

`app.db` stores workspaces, tabs, and settings. `runtime.db` stores only runtime identity, generation, state, Host instance, and required checkpoints. The GUI never writes `runtime.db` directly.

When `app.db` is first created, it transactionally imports old `state/*.json` without deleting or modifying the old files. `crates/tabverse-state/tests/fixtures/` fixes the `type` session format from `v0.0.1` and the `kind` session formats from `v0.0.2` and `v0.0.3`. Tests cover projection of all three versions, one-time import, rollback on failure, and retry after repair.

Registered product settings are owned only by `app.db.settings`; `config_get`, local `config_set/config_reset`, and App Share Steer RPC all use `app.db` as their authority. `config.toml` owns profiles, templates, shortcuts, and Files walk rules, and never imports product settings. Registered `[network]` settings are additionally written there as a derived boot projection because HostNetworkGateway is constructed before Tauri opens the database; the projection is not a read authority. The current macOS path is `~/Library/Application Support/app.tabverse/config.toml`.

## Verification

`src-tauri/tests/runtime_supervisor_process.rs` starts a real `tabverse --helper` child process and verifies Terminal snapshot and continued execution plus Agent handle reattachment across two GUI clients under one PID. `crates/tabverse-runtime` separately verifies the writer lease, stale Hosts, interrupted state, and the absence of fake recovery.
