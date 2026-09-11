# Sidebar tab interaction refinement

Base: main `e44bd884e48d460e47e95db05eafeb6bdd7b49d4` (0.1.1).

## Goal

Make everyday sidebar tab manipulation predictable and comfortable, taking inspiration from Arc without changing Tabverse's multi-tool workspace model or resuming the previous V3 roadmap.

Arc references:
- https://resources.arc.net/hc/en-us/articles/19231060187159-Pinned-Tabs-Tabs-you-want-to-stick-around
- https://resources.arc.net/hc/en-us/articles/25619402657303-How-Do-You-Switch-Between-Tabs-Quickly-on-Arc-Desktop

## Scope

Retain existing pinned groups, Today tabs, sleeping pinned entries, multiple selection, split views, and the current session/persistence model. Do not introduce automatic archiving of terminals or files, new Favorites/Spaces models, remote transport changes, or destructive migrations.

The implementation will focus on:

1. Accurate before/after drag placement, with drop feedback matching the committed operation and no stale indicators after cancellation.
2. Activation that does not unexpectedly reset a pinned browser's current page; reset remains an explicit command. Renaming, action buttons, dragging, and selecting must not accidentally navigate.
3. Keyboard and pointer access to the same tab actions, including a useful Shift-selection anchor.
4. Stable title/action layout and an active tab that remains discoverable in a long sidebar.
5. Regression coverage for existing groups, pinned-tab lifecycle, multi-selection, and splits.

## Validation

Unit/component tests and the existing Browser UI CI suite will validate the implementation. Native macOS webview focus, drag feel, and terminal/file lifecycle require a real desktop acceptance pass and must not be claimed from a browser fixture alone.
