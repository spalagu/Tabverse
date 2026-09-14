# Tabverse Sidebar Experience Contract

Version 1.1, 2026-09-14. Implementation baseline: `main` at
`c2c5352618fb31a454edf70a6658a7230b29f454`.

This document defines expected behavior. It is not a completion claim. Verified
implementation and acceptance evidence live in
`sidebar-implementation-status.md`.

## 0. Scope and outcome

This work refines the existing Tabverse sidebar. It does not add a product
surface.

- Do not add Favorites, Spaces, a synchronization service, a second sidebar
  model, or legacy V3 compatibility.
- Preserve the SQLite local-data model on current `main`. Do not restore JSON
  session migrations or removed compatibility fixtures.
- Preserve terminals, files, browser tabs, agents, remote tabs, groups, saved
  entries, split view, search, and the existing command surfaces.
- Treat Arc as a reference for calm hierarchy and clear tab identity, not as a
  specification to copy.

The expected user-visible change is a sidebar that is easier to read and safer
to operate repeatedly: stable rows, explicit lifecycle actions, predictable
sorting and split placement, guarded closing, measured menus, and one
interruptible auto-hide controller.

## 1. Product model and invariants

A tab has four independent properties:

1. **Identity**: stable ID, type, title, and recoverable content.
2. **Saved placement**: a non-null group, including a type preset or a nested
   user group.
3. **Runtime state**: live, dormant, or removed.
4. **Split membership**: a display relationship with up to four live tabs.

The following invariants apply to every entry point.

- A01: only an explicit pin, unpin, or cross-zone organization action changes
  saved placement.
- A02: split, unsplit, swap, and remove-from-split do not change identity,
  group, title, URL, or runtime state.
- A03: close is not unpin; unpin is not wake; collapse is not sleep.
- A04: removing a display relationship never destroys content.
- A05: asynchronous actions capture IDs and an object generation. A completed
  prompt may not be applied to a replacement tab with the same ID.
- A06: non-activation work does not move focus or change the active tab.
- A07: the previewed drop result and the committed drop use the same placement
  calculation.
- A08: runtime protection completes before state mutation. An unload timeout or
  error is not permission to close.
- A09: temporary UI state such as hover, selection, drag feedback, menus, and
  animation progress is not persisted.
- A10: reopening state never recreates a folder the user explicitly deleted.

## 2. Lifecycle and recovery

| Starting state and action | Required result |
| --- | --- |
| Live saved tab: close runtime | Run protection, then make it dormant while preserving title, group, and saved address |
| Dormant saved tab: remove | Remove the saved entry directly and add it to recently closed; do not start content or create a Today copy |
| Live ordinary tab: close | Run protection, then remove and record recoverable state |
| Any dormant tab: unpin | Preserve the dormant state and move it to Today; do not start it |
| Removed saved tab: reopen | Restore it dormant without activation |
| Closed ordinary tab: reopen | Restore recoverable workspace state without stale runtime handles or one-shot start commands |

Reopen placement uses the original group if it still exists, then the nearest
surviving ancestor, then the type preset. If no suitable saved group survives,
use a neutral `Pinned` fallback. Never recreate a deleted folder and never
overwrite another group merely because its historical ID or name matches.

Rapid repeated close calls use the state captured by the first user action.
They cannot turn “sleep this live saved tab” into “remove this now-dormant saved
tab.” Closing a non-active tab does not activate it. Closing an active split
member selects a live neighbor before falling back to the next visible row.

Deleting a group is a protected batch operation. Every live member must pass
the same close coordinator used by row, menu, keyboard, and remote requests.
Cancellation leaves the group and all unprocessed members intact.

## 3. Split behavior

- A11: every split member remains a complete row in its own group or Today
  position.
- A12: a small split marker expresses the relationship. The active member uses
  the normal active treatment; co-visible members use a quieter treatment.
- A13: menu-based split and content-drop split call the same store operation.
- A14: duplicate, self, dormant, peek, and fifth-member additions are rejected
  without replacing the current split.
- A15: explicit pin, unpin, rename, or regroup actions made while split are
  retained after unsplit.
- A16: unsplit preserves all tabs and current focus. Removing one member keeps
  the remaining relationship when at least two members remain.

Dragging within the sidebar is always sorting or grouping. Split placement is
armed only after the pointer crosses into the content plane. Waiting on a row
does not change the meaning of the gesture.

## 4. Pointer, keyboard, rename, and selection

- C01: clicking a title activates only. Returning a deviated saved browser tab
  to its saved URL is a separately labelled icon action.
- C02: double-click or F2 renames. Enter saves a non-empty trimmed value,
  Escape cancels, and ordinary blur saves. IME composition never submits.
- C03: ordinary click establishes the range anchor. Command/Ctrl selection and
  Shift range selection do not activate their target.
- C04: Up, Down, Home, and End move sidebar focus; Enter or Space activates.
  Shift+F10 and the Menu key open the row menu.
- C05: activating an offscreen tab minimally reveals its row without moving
  keyboard focus into the sidebar.
- C06: hidden sidebar controls are inert and unreachable through Tab.
- C07: row actions stop propagation; dragging a title does not first activate
  it, and cancelling a drag does not become a click.

The editor and terminal keep ownership of their editing shortcuts. The sidebar
does not install a global undo stack that captures Command+Z.

## 5. Sorting and grouping

- C08: upper and lower row halves mean insert-before and insert-after.
- C09: a group head means move into the group; the group tail means append.
- C10: multi-tab moves commit once with IDs, destination group, and insertion
  anchor. The selected order is the current visible order.
- C11: dropping a selection onto itself, using an invalid target, or cancelling
  has no state effect.
- C12: a group tail never uses the next group’s first item as its anchor.
- C13: preview, selected IDs, content-drop state, edge-scroll work, and all drop
  decoration are cleared by drop, drag end, blur, or unmount.

Drop feedback is a stable insertion line. It may not resize rows or place a
large label under the pointer.

## 6. Auto-hide controller

One controller owns DOM edge events, panel events, document movement, native
browser-pointer reports, focus, menus, previews, rename, drag, split drag, and
resize locks.

The states are hidden, awaiting-open, open, awaiting-close, closing, and hidden.
Any reverse intent cancels a pending timer. Returning during closing reverses
from the current visual position.

Initial calibrated values are:

| Parameter | Value |
| --- | --- |
| Edge intent | 100 ms |
| Leave grace | 280 ms |
| Enter movement | 180 ms |
| Exit movement | 200 ms |
| Folder-preview intent / grace | 300 ms / 360 ms |

These values are Tabverse choices, not measured Arc values. Reduced Motion
removes spatial movement while preserving intent delays. Resize follows the
pointer and does not animate width.

During exit movement, the native page remains covered until the sidebar is
actually hidden. A late native snapshot or pointer event is accepted only when
the active tab, request generation, and current intent still match. Losing
window focus clears candidates and drag work; it does not close tabs, expand
groups, or change scroll position.

## 7. Visual contract

The visual direction is quiet, legible, and stable across light, dark, and
custom themes.

| Element | Required treatment |
| --- | --- |
| Row | 34 px for title-only content; 44 px when useful secondary text exists |
| Icon and actions | Stable icon slot and one stable close/remove slot; hover does not change title width |
| Browser subtitle | Omit for a unique title; show the host when another browser tab has the same title |
| File/terminal subtitle | Keep the path or distinguishing runtime context |
| Active | Restrained solid or mixed background with clear foreground, not a large glow |
| Selection | Independent inset outline that can coexist with active and split states |
| Dormant/exited | Communicate status without reducing the entire row to disabled contrast |
| Split | Complete rows plus a compact, explained relation marker |
| Group | Consistent baseline, bounded nesting indent, honest total count |
| Menu/preview | Measure real content, clamp to the viewport, scroll internally, and avoid spring overshoot |
| Floating sidebar | Modest radius and shadow; no layout shift between saved and Today areas |

Hover preview does not steal focus from a terminal, editor, or webpage. It may
receive focus after an explicit click. Desktop action targets are at least
24 px, focus-visible is clear, and a narrow sidebar still preserves a readable
title.

## 8. Menus and close coordination

Tab, group, sidebar, and footer menus share measured placement and keyboard
behavior. Arrow keys cycle enabled commands; Home and End jump; Escape closes
and restores the trigger when it still exists. Text inputs keep their own keys.

Labels must state scope: `Close running tab`, `Remove saved tab`, `Unpin`,
`Remove from split`, and `Separate split into tabs` are different actions.

Row button, middle click, menu, content chrome, group batch, keyboard command,
and remote close request use one close coordinator. Protection covers:

- dirty Files workspaces;
- busy agents and terminals;
- active terminal or application sharing;
- native browser `beforeunload`;
- inability to determine whether a page can unload.

Prompts are serialized. Repeated requests for the same object are deduplicated.
After a prompt, the coordinator revalidates presence, runtime state, URL,
working directory, dirty/busy state, terminal/session IDs, and share identity.

## 9. A/B/C/D delivery map

### A — identity and lifecycle

A01–A10 cover close, sleep, remove, reopen, unpin, placement fallback, atomic
movement, protected group deletion, and host/mirror agreement. A11–A16 cover
split identity and display invariants.

### B — auto-hide and continuous operation

B01 single intent controller; B02 open/leave/reverse timing; B03 exit coverage
and Reduced Motion; B04 resize and cancellation cleanup; B05 preview
invalidation and focus behavior; B06 hidden focus exclusion.

### C — rows, drag, menus, and visual hierarchy

C01–C07 cover activation, reset, rename, IME, selection, navigation, and focus.
C08–C13 cover real sorting, grouping, atomic movement, and cleanup. C14 covers
complete split rows; C15 covers adaptive subtitles and stable action slots;
C16 covers measured menus; C17 covers unified close entry points.

### D — acceptance

D01 lifecycle, batch, nested-group, split-capacity, and long-list automated
scenarios. D02 real Chromium mouse drag, interrupted motion, viewport, focus,
and layout checks. D03 native macOS WKWebView, window chrome, PTY, dirty file,
beforeunload, sharing, and trackpad checks. D04 records incomplete items
explicitly. D05 requires review before merge; this work does not merge itself
into `main`.

## 10. Acceptance summary

| Verify | Pass condition |
| --- | --- |
| Saved lifecycle | Live close sleeps; dormant remove creates no Today copy; reopen stays saved and dormant |
| Deleted folder recovery | Folder stays deleted and the restored entry lands in a surviving safe group |
| Split identity | Menu and content-drop splits preserve each member’s group through reorder and unsplit |
| Drag | Before/after feedback equals final order; row dwell never becomes split; all feedback clears |
| Keyboard and IME | Focus and activation remain separate; rename handles Enter, Escape, and composition |
| Auto-hide | Fly-by does not open; dwell opens; leave has grace; return reverses; locks hold the panel |
| Layout | Hover does not shrink titles; unique browser titles stay compact; menus fit the viewport |
| Runtime protection | Busy, dirty, shared, and beforeunload cases cannot bypass the prompt |
| Native page | Sidebar covers and uncovers WKWebView content without dead zones or stale overlays |
| Persistence | No JSON session path returns; no restored content replays one-shot runtime commands |

## 11. References

- Arc Pinned Tabs:
  https://resources.arc.net/hc/en-us/articles/19231060187159-Pinned-Tabs-Tabs-you-want-to-stick-around
- Arc Folders:
  https://resources.arc.net/hc/en-us/articles/19228419623447-Folders-Stash-Similar-Tabs-Together
- Arc Command Bar Actions: https://start.arc.net/command-bar-actions
- Arc Find deep focus: https://start.arc.net/find-focus
- Arc Hide Sidebar:
  https://resources.arc.net/hc/en-us/articles/25619487530519-How-Do-You-Hide-the-Sidebar

Repository evidence includes `src/state/store.ts`, `src/appCommands.ts`,
`src/sidebarHover.ts`, `src/components/Sidebar*.tsx`,
`src/components/{TabMenu,GroupMenu,FolderPreview,TabContent}.tsx`,
`src/components/sidebar-experience.css`, and
`packages/workbench/src/sidebarPresentation.tsx`.
