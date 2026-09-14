# V3 Content Model

## Single catalog

`resources/content-types.json` is the single catalog for content capabilities and operating-system file associations. `tools/check-content-catalog.mjs` validates it, `tools/generate-tauri-associations.mjs` generates and checks Tauri bundle associations, and the Rust build reads the same catalog directly.

The current catalog covers 32 content types, 118 extensions, and 31 installation association groups, including Markdown, text and code, JSON/YAML/TOML/XML, images, CSV/TSV, HTML, PDF, archives, SQLite, Office documents, and common media.

## Routing

`OpenIntent` is the unified input for operating-system opens, deep links, commands, and Workbench open actions. `OpenIntentRouter` selects an explicit handler from ContentRegistry. Unknown or non-embeddable content uses a safe fallback instead of scattered extension checks.

```text
OS/deep link/Workbench intent
→ OpenIntent
→ ContentRegistry
→ ContentHandler
→ preview/editor/inspect/fallback
```

## State boundaries

- The content catalog describes capabilities and does not store user data.
- User association preferences and tab state belong in `app.db`.
- Installer associations, runtime recognition, and display metadata come from the same catalog.
- The application must not silently take over operating-system defaults. Default-application changes require an explicit user action and expose their current status.

## Non-goals

ContentRegistry is not a Plugin Kernel. It does not load external executable code or introduce a Resident Runtime.
