# Tabverse

Tabverse is a cross-platform workspace for terminals, AI agents, files, and
the web. It keeps the tools around a task in one tabbed app and lets you share
live work with another browser when collaboration is faster than switching
apps or explaining from screenshots.

## Highlights

- **Terminal workspace** — run real shells, split panes, search scrollback,
  revisit command blocks, and restore sessions after a restart.
- **Agent tabs** — follow conversations, tool calls, permission decisions,
  and cancellations beside the files and terminals involved in the work.
- **Files and previews** — browse files with Git status, edit with a diff
  against HEAD, and preview common document, image, media, and data formats.
- **Built-in browser** — keep relevant pages in native web views with focused
  navigation and per-site state.
- **Secure sharing** — share a live terminal or workspace through an
  end-to-end encrypted connection and join from a browser without installing
  the desktop app.
- **One shared interface** — the desktop app and the browser Join page reuse
  the same workbench components and responsive styles.

## Download

Installers for macOS, Windows, and Linux are published on the
[latest release](https://github.com/spalagu/Tabverse/releases/latest) page.

To join a shared Tabverse session without installing the app, open the
[Tabverse Join page](https://spalagu.github.io/Tabverse/join/).

## Development

Tabverse requires Node.js 20 or newer, npm, a Rust toolchain, and the platform
dependencies required by Tauri.

```bash
npm ci
npm run tauri dev
```

Build the desktop application with:

```bash
npm run tauri build
```

## Quality checks

Run the same core checks used by GitHub Actions:

```bash
npm run check:quality
npm run test:browser
```

The repository also builds the Join page, runs browser interaction and visual
regression checks, performs security analysis, and creates cross-platform
release assets through GitHub Actions.

## Contributing

Bug reports and focused pull requests are welcome. Before opening a new issue,
please search the [existing issues](https://github.com/spalagu/Tabverse/issues)
and include a clear reproduction when reporting a problem.

## License

Tabverse is licensed under the [Apache License 2.0](LICENSE). Third-party
attributions are listed in [NOTICE](NOTICE).
