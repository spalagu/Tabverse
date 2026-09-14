# Sidebar Experience Implementation Status

Updated 2026-09-14. Design:
`docs/sidebar-experience-design.md`. Integration target: `main` at
`c2c5352618fb31a454edf70a6658a7230b29f454`.

## Delivery state

PR #36 now contains the implementation adapted to the current SQLite
local-data model. The historical 30-file patch based on `e44bd884` was used
only as input: it was not applied over current `main`, and it did not restore
the removed JSON session or migration paths.

The implementation adds no runtime dependency and no product feature. It
retains the existing Tabverse capabilities and changes sidebar behavior,
presentation, and safety.

## A — identity, lifecycle, and split

| IDs | Implemented behavior | Evidence |
| --- | --- | --- |
| A01–A03 | Live saved close sleeps; dormant saved close removes directly; reopen restores dormant without a Today copy; unpin never wakes | Store, contract, mirror, and Chromium tests pass |
| A04–A06 | Reopen uses surviving group/ancestor/preset/fallback and never recreates a deleted folder; dissolve preserves saved identity | Store and sidebar contract tests pass |
| A07–A10 | Atomic multi-tab movement, repeated-close state guard, safe runtime-handle stripping, mirror agreement | Store and mirror tests pass |
| A11–A16 | Split entry points preserve group and identity; every member keeps a complete row; invalid or fifth-member additions do not replace the split | Store, split, presentation, and Chromium tests pass |

An intentional adjustment from the historical candidate is now part of the
contract: reopening a saved entry does not recreate an explicitly deleted
folder. It selects the nearest surviving safe placement.

## B — auto-hide and continuous operation

| IDs | Implemented behavior | Evidence |
| --- | --- | --- |
| B01–B02 | One controller receives DOM and native intent; open, leave, lock, blur, and reverse paths share timers | Controller tests and Chromium edge tests pass |
| B03 | 100 ms intent, 280 ms leave grace, 180 ms enter, 200 ms exit; Reduced Motion removes spatial motion; native cover remains through exit | Controller tests pass; native keyboard hide/show over WKWebView passed |
| B04 | Resize, pointer cancellation, blur, drag end, and unmount clear work and locks | Unit coverage passes; physical trackpad path still pending |
| B05 | Folder preview validates pending intent and active tab, waits across the portal gap, freezes during drag, and does not steal focus on hover | Component tests pass; native pointer traversal still pending |
| B06 | Hidden sidebar is inert; focus and rename hold it open | Chromium focus and hidden-state checks pass |

## C — rows, drag, menus, and close safety

| IDs | Implemented behavior | Evidence |
| --- | --- | --- |
| C01–C03 | Title activation is separate from saved-URL reset; F2/double-click rename isolates IME; range selection does not activate | Component and Chromium keyboard tests pass |
| C04–C05 | Row halves sort before/after; content crossing alone arms split; row dwell never changes gesture meaning; drop feedback clears globally | Real Chromium mouse-drag tests pass |
| C06 | Split members retain complete, independently operable rows with compact relation markers | Presentation and Chromium split tests pass |
| C07 | 34/44 px adaptive rows, stable icon/action slots, restrained active/selection states, theme tokens | Build and visual screenshots reviewed in browser and native app |
| C08 | Offscreen activation reveals the row without taking focus | Chromium long-list test passes |
| C09 | Tab, group, sidebar, and footer menus use measured viewport placement and keyboard navigation | Chromium viewport test and native menu inspection pass |
| C10 | Row, menu, group batch, content, and remote requests use one serialized close coordinator with generation validation | Close coordinator tests pass |

Browser subtitles were further refined after visual review: a unique page title
stays one line; the host appears only when another browser tab has the same
title. Paths remain visible for file and terminal rows.

Group deletion now passes each member through close protection. Cancelling a
dirty, busy, shared, or unload-protected member prevents the group deletion.

## D — verification and acceptance

### D01: full automated quality gate — passed

`npm run check:quality` completed successfully:

- Workbench TypeScript check: passed.
- Architecture boundary, content catalog, generated associations, and release
  source checks: passed.
- Production TypeScript/Vite build: passed.
- Vitest: 191 files, 2,169 tests passed.
- `cargo fmt --all -- --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `cargo test --workspace`: 653 tests passed, 2 intentionally ignored,
  0 failed.

The three page-proxy deadline tests reported running longer than 60 seconds and
then passed at 91.27 seconds. This is a real successful completion, not a
skipped or killed test. Vite still reports the repository’s existing dynamic
import and large-chunk warnings.

### D02: real Chromium UI — passed

`npm run test:browser` completed with 13 of 13 tests passing in four workers.
The eight sidebar scenarios cover:

- real mouse lower-half insertion and final ordering;
- no time-based conversion from sort to split;
- split rows and identity after unsplit;
- dormant saved removal and reopen;
- keyboard focus, rename cancellation, and Shift range;
- stable title width, narrow sidebar, and bottom-edge menu placement;
- edge intent, exit grace, reverse, and inert hidden state;
- long-list reveal without focus theft.

The five existing browser smoke checks also passed.

### D03: native macOS — partial, with completed evidence

The isolated build used identifier `app.tabverse.sidebar-candidate`, so it did
not read or write the installed Tabverse application database.

Passed on macOS:

- the native application launched with normal traffic-light controls;
- a real PTY started, accepted
  `printf 'TABVERSE_PTY_OK\\n'`, displayed the output, and returned status;
- a native browser tab loaded `https://example.com` in WKWebView;
- keyboard unpin hid the sidebar over WKWebView and keyboard toggle restored
  the sidebar, controls, and native page coverage;
- a tab context menu remained inside the window and left the WKWebView visible;
- a local page with `beforeunload` displayed the Tabverse close-protection
  dialog; Cancel retained the page;
- a Markdown file in an isolated `/tmp` directory was edited without saving;
  closing its Files tab displayed the same protection dialog; Cancel retained
  the editor and dirty state.

Not completed after macOS locked automatically:

- physical trackpad resize and edge-hover traversal;
- native folder-preview pointer traversal across the portal gap;
- a two-device or second-client sharing session.

These three items remain manual acceptance items. Automated controller,
Chromium pointer, resize cleanup, preview focus, share protection, and mirror
tests pass, but they are not relabelled as physical native acceptance.

### D04: visual review — passed with stated limits

Browser and native screenshots were reviewed at the default light theme. The
row hierarchy, stable action slot, adaptive subtitle, active/co-visible
treatment, menu size, window controls, and WKWebView boundary are legible and
do not shift on hover. Automated tests cover light/dark theme token switching
and narrow width. A full pixel comparison against Arc is intentionally not a
goal, and the timing values are Tabverse choices rather than Arc measurements.

### D05: repository state

The branch integrates current `main` and is intended to update PR #36. It
must remain unmerged until the PR commit, remote CI result, and the three manual
native acceptance items above are recorded. No automatic merge into `main`
is part of this task.

## Reproduction

Run:

```sh
npm ci
npm run check:quality
npm run test:browser
```

For isolated native validation, build with a non-production identifier:

```sh
npx tauri build --debug --bundles app \
  --config '{"identifier":"app.tabverse.sidebar-candidate","productName":"Tabverse Sidebar Candidate"}'
```

Pass criteria are the rows in section 10 of
`docs/sidebar-experience-design.md`. Native validation must use isolated
state, must not close a user’s live Tabverse tabs, and must record any unsigned
or unnotarized artifact accurately.
