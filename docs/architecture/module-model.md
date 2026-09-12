# V3 Module Model

## Goal

Tabverse V3 uses built-in feature modules and does not provide an installable Plugin Kernel. Modules declare product capabilities; runtimes provide those capabilities through ports and adapters.

## Current layers

```text
packages/runtime-contracts   Portable DTOs and ports
packages/workbench           Runtime-independent product UI and interactions
packages/runtime-desktop     Desktop port adapters
packages/runtime-remote      Join/Remote port adapters
src-tauri                    Tauri commands, composition root, and OS adapters
crates/tabverse-*            Reusable Rust core
```

The renderer catalog in `packages/workbench/src/tabView.tsx` is the composition point for built-in modules. Files, Browser, Terminal, Agent, Remote, and Settings register explicit renderers without dynamic package installation or a Plugin lifecycle.

## Dependency direction

- Workbench does not depend on Tauri, the Desktop runtime, or the Remote runtime.
- `runtime-contracts` does not depend on React, Workbench, or a concrete runtime.
- Desktop and Remote runtimes may depend on contracts; contracts cannot depend on application source.
- `crates/tabverse-*` does not depend on Tauri; `src-tauri` assembles the application.
- Modules cannot obtain undeclared privileged APIs. All runtime capabilities enter through typed contexts and ports.

`tools/check-workbench-boundary.mjs` enforces these boundaries through `npm run check:architecture`.

## Desktop composition root

`src-tauri/src/lib.rs` is the composition root for process startup, shared-state assembly, plugin registration, and command registration. Remaining adapters continue to split by capability. The Files command adapter is in `src-tauri/src/fs_commands.rs`: blocking-pool selection, IPC parameters, and watch events belong to the adapter, while `tabverse-fs` implements directory reads, search, replacement, archives, and inspection semantics. New Files behavior must not move back into the composition root.

`src-tauri/src/state_commands.rs` owns `AppDatabase`, database-path resolution, and the state/config IPC adapters. Other Desktop adapters can obtain `AppStateStore` only through the narrow entry point exposed by this module. Workbench and the Rust core never access database handles.

`src-tauri/src/terminal_commands.rs` owns Terminal IPC, helper event buffering, GUI channel adaptation, and shared-source wiring. `tabverse-term` continues to implement terminal process and protocol semantics, while `tabverse-remote` implements remote-session ordering and permission semantics. New Terminal commands must not move back into the composition root.

`src-tauri/src/remote_commands.rs` owns the Remote Join IPC and GUI channel adapter. `tabverse-remote` owns connections, encrypted transport, control/file streams, and Host-side authorization.

`src-tauri/src/agent_commands.rs` owns Agent login, Agent tab IPC, Runtime Supervisor wiring, and shared-source registration. Agent events and turn semantics belong to `tabverse-agent`; runtime identity and process lifecycle belong to `tabverse-runtime`. The adapter neither stores recovery state nor fabricates process recovery.

`src-tauri/src/credential_commands.rs` owns local user confirmation and password CSV import/export IPC. Credential storage and encryption belong to the credential adapter and the `app.db` vault. The composition root never handles plaintext credentials.

`src-tauri/src/appearance_commands.rs` owns window fullscreen, macOS traffic lights, applying
the resolved theme to windows, and WebView-log IPC. Platform calls exist only in target-gated
adapter branches. The config/state adapter persists theme preference as a registered setting
in `app.db.settings`.

`src-tauri/src/browser_commands.rs` is the official Tauri/Wry Browser adapter. It owns webview creation, navigation, find, snapshots, local page proxying, and Browser IPC wiring. It does not introduce CEF or a custom Tauri runtime. Browser is local-only.

## Non-goals

- External plugin installation, updates, signing, or package management.
- A Plugin Kernel, Resident Runtime, or CEF runtime.
- A speculative dynamic lifecycle framework for future capabilities.
