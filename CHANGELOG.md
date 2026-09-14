# Tabverse Changelog

## 0.1.4

- Refine saved-tab lifecycle so live saved tabs sleep, dormant entries remove cleanly, and recovery never recreates deleted folders or stale runtime state.
- Keep split relationships independent from sidebar grouping and ordering, with complete rows for every visible split member.
- Separate sidebar sorting from content-plane splitting and clear drag feedback reliably after drop, cancellation, blur, or unmount.
- Stabilize auto-hide timing, focus ownership, row density, duplicate-title context, viewport-safe menus, keyboard navigation, and IME rename behavior.
- Route tab, group, keyboard, content, and remote close requests through one serialized protection coordinator for dirty, busy, shared, and beforeunload states.

## 0.1.3

- Use `~/Library/Application Support/app.tabverse/config.toml` as the current macOS application-support configuration path and stop reading the removed bundle path.
- Keep registered settings in `app.db` while `config.toml` owns only declarative profiles, templates, shortcuts, and Files rules.
- Remove previous-default backup and restore behavior; Tabverse can claim supported defaults, while later changes belong to the operating system and the user.

## 0.1.2

- Establish `app.db` as the single authority for durable structured application state.
- Keep runtime lifecycle state in `runtime.db` and Agent transcripts and memory in append-oriented content files.
- Remove legacy JSON state, import, migration, passphrase, and compatibility paths.
- Reject corrupt or unsupported current state without overwriting it, and require explicit replacement.
- Make credential, transcript, and memory persistence failures visible and protect concurrent updates.
- Document the current local-data ownership model and enforce it through architecture checks.

## 0.1.1

- Keep local Browser tabs interactive while navigation remains in progress.
- Restore live Browser tabs after transient desktop overlays close, regardless of how the overlay was opened.
- Remove Remote Browser transport and rendering; Browser remains local-only while Join keeps Terminal, Agent, Files, Settings, and Whole-App semantic sharing.
- Remove obsolete compatibility shims, dead media-audibility code, and unused Workbench dependency declarations.
- Keep zero-cost distribution: macOS builds are ad-hoc signed and not notarized; no paid signing service is required.

## 0.1.0 — V3

### Workspace and persistence

- Use workspaces and tabs as the unified work context.
- Persist workspaces, tabs, settings, and content preferences in `app.db`, with transactional and retryable migrations for historical state.
- Manage long-running work with the on-demand Runtime Supervisor so Terminal and Agent tasks can continue across GUI restarts.

### One-App content capabilities

- Provide built-in Terminal, Agent, Files, Browser, and Settings feature modules without a Plugin Kernel.
- Unify OpenIntent, ContentRegistry, and the file association catalog.
- Preview common technical files in Tabverse and edit and save text content suited to direct editing.

### Remote

- Retains end-to-end encrypted iroh transport and separates semantic control from raw file data.
- Terminal carries terminal bytes and control semantics, Agent carries structured events, and Files transfers requested raw bytes.
- File streams require an authenticated connection and a current App-share viewer.
- Browser is local-only. Join displays Browser rows as unavailable and carries no Browser pixels, state, or network traffic.

### Architecture cleanup

- Do not include CEF, a custom Tauri fork, a Resident Runtime, a Plugin Kernel, or legacy ProxyReq/ProxyRes.
- Remote Browser document rewriting, HostNetworkGateway, and HTTP data streams are removed.
- Keep product semantics consistent across macOS, Windows, and Linux while containing platform mechanisms in narrow adapters.

### Distribution

- Bump the version to `0.1.0`.
- Allow manual release-candidate builds without creating a tag or GitHub Release.
- Provide Apple Silicon and Intel macOS DMGs with ad-hoc signatures, without an Apple Developer ID or notarization.
- Avoid paid code-signing services on every platform and include SHA-256 checksums and build provenance with release artifacts.
