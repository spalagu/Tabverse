# ADR-0007: SQLite owns durable structured state

## Status

Accepted.

## Context

Tabverse needs one authoritative representation for sessions, registered settings, content
preferences, site decisions, userscripts, and encrypted credential payloads. Parallel JSON
files and relational projections created duplicate owners and compatibility paths.

## Decision

`app.db`, owned by `tabverse-state`, is the only durable structured application store.
The `state_scopes.session` row is the only session representation. Registered settings use
the `settings` table, content choices use `content_preferences`, and encrypted secrets use
`credential_vault`. Default-application restore data, site decisions, and each complete
userscript use state scopes.

`runtime.db` remains separate because the Runtime Supervisor is its single writer. Agent
transcripts remain append-only JSONL content. Tauri owns `.window-state.json`; WebView and
the operating-system secret store remain platform-owned.

The application does not read old `state/*.json`, userscript body files, standalone vault
files, or old session shapes. Future schema migrations may evolve the current SQLite schema
forward, but may not introduce an importer for a removed format.

## Rejected alternatives

- A directory of JSON databases: no cross-record transaction or single schema authority.
- A relational Workspace/Tab projection beside `state_scopes.session`: two session owners.
- Frontend-owned SQLite access: breaks the environment boundary and single-writer rule.
- Shipping an old-format importer: restores permanent compatibility code to a first-release
  baseline.

## Consequences

- A fresh install creates `app.db`; the Runtime Supervisor creates `runtime.db` on first use.
- Removed formats are ignored, not imported or rewritten.
- Cache files are disposable and live in the application cache directory.
- There is no downgrade compatibility.
