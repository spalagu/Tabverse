# ADR-0013: Browser credentials are a local core capability

## Status

Accepted.

## Context

The local Browser needs to save, fill, update, delete, and choose between multiple accounts
without writing plaintext secrets to disk.

## Decision

The credential adapter encrypts Browser login records and session-cookie snapshots, then
stores both in `app.db.credential_vault` under separate identifiers. A machine key bundle is
protected by Keychain, Credential Manager, or Secret Service. BrowserBridge captures and
fills credentials only for a matching origin.

No standalone vault or cookie file is read. Credentials never enter Remote snapshots,
control frames, or data streams. Forgetting Browser logins does not remove Agent login state.

## Rejected alternatives

- Plaintext configuration: exposes passwords.
- WebView-owned password storage: inconsistent behavior and no product control.
- Host-to-Join credential synchronization: Browser is local-only.
- A fallback reader for old vault files: creates a second credential authority.
