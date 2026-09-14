# ADR-0014: Common Content and File Associations Belong to the One-App Core

## Status
Accepted.

## Context and requirements
Markdown, code, tables, images, PDFs, archives, SQLite, Office documents, and media need unified open semantics and operating-system associations.

## Decision
Use `resources/content-types.json` as the single content-type catalog and generate the runtime registry, Tauri bundle associations, and checks from it. Normalize every ingress into an `OpenIntent`, then route through a ContentHandler or a safe fallback.

## Alternatives rejected
- Handwritten extensions per platform: catalogs drift.
- Scattered suffix checks in React components: cannot cover operating-system ingress.
- Silently taking over default applications: violates user control.

## Cross-platform impact
The content catalog is shared; adapters generate Launch Services, Windows ProgId, and XDG registration.

## Remote bandwidth impact
Files Remote transmits only requested metadata, previews, and content; it does not mirror the filesystem.

## Migration impact and reversibility
Legacy scattered associations are not authoritative. Association declarations can be regenerated, and the operating-system UX manages default-application changes.
