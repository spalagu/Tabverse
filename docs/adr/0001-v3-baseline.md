# ADR-0001: V3 starts from v0.0.1

## Status
Accepted.

## Context
`v0.0.2` introduced Plugin Kernel and Resident Runtime in one large architecture change. `v0.0.3` then introduced CEF/dual-runtime work. V3 intentionally rejects major parts of both implementation directions while retaining several product requirements discovered by them.

Building V3 on current `main` would first require removing abstractions we already know we do not want, then rebuilding their replacements.

## Decision
The V3 code branch is created from tag `v0.0.1`.

Later commits are treated as a knowledge and bug-fix source. Each meaningful later change is classified as PORT, REIMPLEMENT, DROP or SUPERSEDED in `docs/architecture/post-v001-audit.md`.

## Consequences
- CEF and the custom Tauri fork never enter V3 unless a future product decision explicitly reintroduces them.
- Plugin/Resident V1 code is not inherited merely for compatibility.
- The first V3 release defines one new local-data baseline and ships no importer for data
  written by unreleased 0.0.2/0.0.3 builds.
- Useful later fixes are reproduced and forward-ported in V3-native form rather than blindly cherry-picked.
