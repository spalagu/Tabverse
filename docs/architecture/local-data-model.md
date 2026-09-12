# V3 Local Data Model

Status: Implemented; development-machine cutover pending

## Decision

Tabverse has one current implementation for each local-data domain. It does not read,
import, mirror, or preserve any legacy `state/*.json` format. A fresh installation creates
the current schema directly.

"One implementation" does not mean "one physical file". Storage follows ownership and
lifecycle:

| Store | Owner | Purpose |
| --- | --- | --- |
| `app.db` | `tabverse-state` plus feature credential adapters | Durable, structured product state |
| `runtime.db` | Runtime Supervisor | LiveProcess identity, generation, lease, status, and checkpoints |
| `.window-state.json` | Official Tauri window-state plugin | Window geometry only |
| `content/agent-sessions/*.jsonl` | Agent module | Append-only user-visible transcripts |
| `content/agent-memory/*.jsonl` | Agent module | Versioned long-term memories shared by sessions for one working directory |
| platform WebView store | WebKit, WebView2, or WebKitGTK | Website cookies, local storage, IndexedDB, media keys, and other site-owned data |
| platform secret store | Keychain, Credential Manager, or Secret Service | The machine key that protects encrypted records in `app.db` |
| platform cache directory | Feature adapter | Rebuildable favicons, downloaded completion specifications, and network caches |
| runtime endpoint file | Runtime Supervisor | Ephemeral local-process discovery; never durable truth |

No domain has two authoritative stores. Generated, cached, and endpoint files are not read
as product-state fallbacks.

The GUI owns ordinary application-state writes. The Runtime Supervisor accesses only the
Agent credential-vault record through the same credential adapter so it can refresh a token;
SQLite WAL and the configured busy timeout serialize that narrow multi-process access.

## `app.db` ownership

`app.db` is the only authority for durable structured application state:

- The current Workspace, Tabs, groups, splits, and module-owned Tab state, stored once as the
  `session` scope. The unused relational `workspaces`/`tabs` projection is deleted; adding a
  second Workspace is the trigger to replace the single document with relational records.
- Registered settings, theme choice, content-handler preferences, Browser history, visits,
  archive, and download records.
- Default-application takeover backups. Losing this state can prevent restoration of the
  user's previous system defaults, so it belongs in the transactional store rather than a
  side file.
- Browser permission decisions, including media grants and explicit certificate-host
  exceptions.
- Installed userscripts. One `userscript:<id>` scope contains source, metadata, enablement,
  and update location, so one existing scope upsert commits the executable body and its
  identity together. Grants and values remain separate module-owned scopes.
- Encrypted Browser login records.
- The encrypted snapshot of session-only Browser cookies. Tabverse keeps the current promise
  that website sessions survive an application restart; the snapshot uses the existing
  credential vault and platform-protected machine key.

Large but bounded userscript source is product data, not a cache. The existing 8 MiB scope
limit applies to the complete serialized userscript record, including source and metadata;
the current 4.8 MiB script fits without a new table or storage API. Agent transcripts are
different: they are unbounded, append-only content and
remain files at their existing session-derived paths. No database index is added without a
second lookup requirement.

`state_scopes` remains the narrow store for module-owned JSON whose schema is owned by one
feature. It is not a legacy file compatibility layer. Default-application backups, Browser
permission decisions, and complete per-script userscript records reuse this store.

## `runtime.db` ownership

`runtime.db` remains separate. The Runtime Supervisor is its sole writer, and the GUI does
not write it. Combining it with `app.db` would mix two writers and two lifecycles without a
product benefit.

Deleting `runtime.db` may discard reattachment information for live Terminal or Agent
processes. It must not delete Workspace or Tab identity from `app.db`, and it must never be
used as an application-state fallback.

## Files that remain outside the databases

- `.window-state.json` remains owned by the official Tauri plugin. Reimplementing the plugin
  to reduce the file count adds code without changing product semantics.
- Users' downloaded files remain at their chosen destination; only download records belong
  in `app.db`.
- Agent transcript JSONL remains append-only content.
- Agent memory JSONL remains bounded, user-content-like data keyed by working directory. The
  Agent module strictly decodes the current record version, shares one in-process store per
  path, blocks startup on corruption, and publishes whole-file changes by atomic rename.
- Favicons and downloaded completion specifications move to the platform cache directory.
  Missing cache entries are normal and trigger regeneration or download.
- Runtime endpoint data moves to a runtime/cache location and is recreated whenever the
  Supervisor starts.
- WebView data and machine keys remain in their platform stores. Tabverse neither copies
  them into its state directory nor treats them as alternate application state.

## Removed implementation

The current baseline deletes, rather than deprecates, every legacy path:

- `session.json`, encoded per-Tab JSON files, history/visit/archive/download JSON, theme
  JSON, media-permission JSON, userscript index/grant/value JSON, and migration backups.
- Legacy login-vault files and their fallback importer.
- Userscript body files under the legacy `state/userscripts/` directory.
- First-run import of `state/*.json` into `app.db`.
- First-run import of registered settings from `config.toml`. Declarative profiles,
  templates, shortcuts, and Files walk rules remain configuration; registered product
  settings do not.
- The relational `workspaces`/`tabs` projection of `state_scopes.session`, its unused database
  API, historical `type`/`kind` fallback parsing, released-version fixtures, retry markers,
  and recovery text that names `session.json`.
- Any branch whose only purpose is to detect or preserve a removed storage format.
- The whole-machine Backup & migrate UI, package format, replacement importer, and migration
  backup directory. No current product requirement justifies retaining this migration engine.

Current-database corruption handling remains. A scope that cannot be read or decoded is
reported and write-blocked until a later read succeeds or the user explicitly deletes it;
it is never treated as missing and overwritten. Recovery does not search for an older
representation.

## Database evolution

Before this model ships, existing unreleased schema steps are collapsed into one current
baseline schema. A new database creates that schema directly and starts empty.

Future releases may add forward-only SQLite schema migrations inside `app.db` and
`runtime.db`. A schema migration evolves the same authoritative store; it is not permission
to read a removed JSON or vault format. There is no downgrade compatibility.

## Development-machine cutover

The shipping application contains no legacy importer. If the current development machine's
state must be retained, perform one explicit local cutover while Tabverse and its Runtime
Supervisor are stopped:

1. Keep the newer scopes, settings, content preferences, and credential vault already present
   in `app.db`; do not overwrite them with stale JSON copies. Stop all runtimes and create the
   current `runtime.db` baseline rather than importing records from an unreleased schema.
2. Insert the current default-application backup, media decisions, and complete userscript
   record through `state_scopes`, and the encrypted session-cookie snapshot through
   `credential_vault`.
3. Remove obsolete relational Workspace/Tab projections and legacy migration markers from
   the development database so its schema matches a fresh current database.
4. Verify default-app restoration, userscript execution and values, Browser login selection,
   website-session restart, Workspace/Tab restore, and runtime reattachment.
5. Move the removed legacy files and migration backups to macOS Trash. Do not create another
   backup copy.

This cutover is an operator action for this development machine. It is not committed as a
general importer and is not shipped to users.

## Implementation sequence

1. Reuse `state_scopes` for default-app backup, Browser permissions, and complete per-script
   userscript records. Reuse `credential_vault` for the encrypted session-cookie snapshot.
2. Switch each feature to its final owner and test that owner directly.
3. Relocate caches and the runtime endpoint; leave window-state and platform stores alone.
4. Delete legacy import, the unused relational session projection, whole-machine migration,
   fallback, fixture, and filesystem state code.
5. Update architecture documents and ADRs that still promise legacy migration.
6. Run the development-machine cutover, move old files to Trash, and verify the final layout.

Do not add a generic storage abstraction, dual-read period, compatibility flag, feature
flag, or fallback. Existing feature adapters call the narrow `app.db`, runtime, content,
cache, or platform-store operation they own.

## Acceptance

- Starting with an empty application-data directory creates the current `app.db` and creates
  `runtime.db` only when runtime work needs it.
- Planting any removed legacy file before startup does not change application behavior or
  database contents.
- No production source reads or writes a removed legacy filename or scans `state/*.json`.
- Default applications can be enabled and restored after restart using only `app.db`.
- Userscript install, enable/disable, update, values, and uninstall work after the legacy
  userscript directory is absent.
- Media and certificate decisions survive restart using only `app.db`.
- Saved logins and session-only cookies survive restart using the database vault plus the
  platform machine key.
- Removing favicons or completion caches only causes refetch or bundled fallback.
- GUI restart reattaches live runtimes through `runtime.db`; deleting runtime state never
  removes durable Tabs.
- Agent memory survives session replacement through strict current-version records under
  `content/agent-memory/`; a damaged record is reported and never partially loaded or overwritten.
- The normal application-data directory contains no legacy `state/` tree or migration
  backup after cutover.
- Architecture and security gates reject reintroduction of a removed filename or importer.
