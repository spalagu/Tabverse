# V3 Remote model

## Transport

Remote uses end-to-end encrypted iroh connections. The first bidirectional stream carries small semantic control frames. Selected file bodies use independent QUIC streams as raw bytes.

```text
authenticated connection
├── control: snapshot, action, presence, access, Agent events
└── file streams: bounded metadata + raw bytes
```

Each connection processes at most 16 file streams concurrently. Control traffic does not consume these permits.

## Authorization

- A ticket authenticates a connection.
- Each file stream rechecks that the App share and viewer still exist before Host file I/O.
- View, Steer, and Approve may read Files content. Only Steer may perform editable actions.
- The Host Files backend validates paths.

The implementation boundary is `crates/tabverse-remote/src/lib.rs` and `crates/tabverse-remote/src/bridge/data_stream.rs`.

## Capability semantics

- Terminal: PTY bytes, dimensions, and attach snapshot.
- Agent: Prompt, Cancel, Answer, and structured session events.
- Files: directory metadata over semantic RPC; selected file bodies over independent raw-byte streams.
- Workbench: snapshots and semantic actions.
- Browser: local-only and explicitly unavailable on Join.
