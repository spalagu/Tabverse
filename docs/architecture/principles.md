# Tabverse Architecture V3 principles

This file is the short-form architectural constitution for V3. When implementation details are not specified elsewhere, prefer these rules over copying historical implementation patterns.

## Product

1. **One App.** Tabverse should cover common technical work in one workbench: terminals, agents, web, files, Markdown, images, tabular data and other useful content viewers.
2. **A Tab is working context, not a component.** React trees, WebViews, PTYs and processes are implementations of a logical Tab, not its identity.
3. **Preserve work, not machinery.** Workspace/Tab/task identity and genuinely recoverable state are durable. GUI processes, runtime hosts and workers are replaceable execution machinery.
4. **Browser credentials are a baseline browser feature.** Saving/filling website passwords is product functionality, not optional infrastructure.
5. **Common file associations are a baseline One-App capability.** Supported formats should route through a single content catalog and open usefully in Tabverse.

## Remote

6. **Remote is not Remote Desktop.** Prefer semantic state/actions and native domain data over pixels.
7. **Minimize data transfer by architecture, not just compression.** Choose the smallest representation that preserves the useful capability.
8. **Place capability where it must live; place rendering/computation where it is cheapest and most useful.**
   - Terminal: host executes PTY; remote renders terminal bytes.
   - Agent: host executes; remote renders structured events.
   - Files: host owns filesystem; remote renders metadata and requested content.
   - Browser: local only. Browser tabs remain visible in a Whole-App share but are unavailable on Join.
9. **Remote does not carry Browser content or networking.** Do not add Browser pixels, DOM mirroring, browser-state synchronization, or Host-network proxying to Remote.
10. **Bulk Remote file data must stream as bytes.** Do not base64 file bodies into JSON control messages.

## Cross-platform and implementation

11. **Product semantics are cross-platform; OS mechanics live at the edge.** Core code should know abstractions such as RuntimeHost, SecretStore and ContentHandler, not launchctl/Win32/systemd/WebView internals.
12. **Own differentiation; reuse commodity infrastructure.** Prefer official Tauri plugins, then mature Rust crates, then narrow platform adapters, before custom OS plumbing.
13. **One authoritative writer per durable state domain.** Application state and runtime state must not be concurrently mutated by unrelated components.
14. **Do not fake recovery.** A new process is not the old terminal; visual restoration is not execution restoration.
15. **Built-in modularity does not require a dynamic plugin package manager.** V3 uses lightweight built-in Feature Modules. External plugins are a separate future trust/distribution problem.
16. **Functionality before speculative defense.** Keep clear structural trust boundaries, but do not add allowlists, rate limits or protocol restrictions without a concrete threat and product reason.
17. **Every abstraction must pay rent in current product value.** Do not add managers, daemons, worker layers or policy frameworks for hypothetical future consumers.

## Decision order

When V3 does not specify a detail, decide in this order:

1. preserve user data;
2. preserve intended product semantics;
3. preserve cross-platform behavior;
4. preserve architecture boundaries;
5. minimize Remote data transfer;
6. choose the simpler design;
7. reuse mature infrastructure;
8. optimize only after measurement;
9. preserve historical internal implementation only when it remains useful.
