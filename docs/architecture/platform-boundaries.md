# V3 Platform Boundaries

## Core and adapters

Cross-platform semantics live in `packages/runtime-contracts`, `packages/workbench`, and `crates/tabverse-*`. Tauri, WebView, Keychain/Credential Manager/Secret Service, Launch Services, Windows Registry, and Linux desktop integration exist only in outer adapters.

`tools/check-workbench-boundary.mjs` prevents core Rust crates from depending on Tauri and checks reverse dependencies across Workbench, contracts, the Desktop runtime, and Join.

## Browser

- Desktop uses upstream Tauri and Wry.
- macOS uses WKWebView, Windows uses WebView2, and Linux uses WebKitGTK.
- The product contains no CEF, custom Tauri fork, or dual runtime.
- Browser is local-only. Join does not render Browser content or proxy Browser traffic through the Host.

## Credentials

Credential records are encrypted in `app.db`. macOS Keychain, Windows Credential Manager, or Linux Secret Service protects the machine master-key bundle. Credentials are never written to plaintext configuration or migration packages.

## Runtime IPC

Unix uses a local socket and Windows uses a Named Pipe; this must not become a localhost TCP service. Host health, lease, and generation semantics remain cross-platform. Platform code owns only transport and system integration.

## System integration

- macOS: Launch Services.
- Windows: per-user ProgId/capabilities and the system default-applications UI.
- Linux: XDG desktop and MIME tools.

OS-specific implementations must remain in `src-tauri` adapters or explicit target modules. Product rules, routing, state schemas, and Remote permissions must not fork by operating system.

## Acceptance boundary

Local development must pass TypeScript, Vitest, Rust fmt/clippy/test, architecture checks, and current-platform process tests. Only the corresponding runner or device can prove real Windows/Linux WebView, credential-store, default-application, and Runtime Host health behavior; macOS unit tests cannot replace that evidence.
