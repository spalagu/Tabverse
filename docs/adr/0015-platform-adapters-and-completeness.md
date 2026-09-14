# ADR-0015: Keep Platform Mechanisms in Adapters and Prioritize Complete Features

## Status
Accepted.

## Context and requirements
V3 must deliver current core capabilities across platforms without delaying complete features for hypothetical threats, plugins, or generic managers.

## Decision
Keep OS APIs, WebView callbacks, SecretStore, default applications, and process transport in `src-tauri` target adapters. The core owns only cross-platform semantics. Complete runnable features, migration, and acceptance before addressing measured performance and security hardening.

## Alternatives rejected
- Scattering `cfg` platform mechanisms through the core: contaminates domain boundaries.
- Prebuilding a Plugin Kernel, generic Worker, or NetworkManager: no current user requirement.
- Replacing functionality with unverified hardening: does not prove the product works.

## Cross-platform impact
Every platform requires a real build and acceptance run; macOS results cannot replace Windows or Linux evidence.

## Remote bandwidth impact
Platform adapters do not change minimal semantic transport rules; optimizations require evidence.

## Migration impact and reversibility
Adapters can be replaced one platform at a time. Any new architecture layer or feature downgrade requires separate review and cannot enter through a platform difference.
