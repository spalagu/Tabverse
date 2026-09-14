# ADR-0003: Built-ins use lightweight Feature Modules

## Status
Accepted.

## Context
Tabverse needs Terminal, Files, Browser, Agent and other built-in capabilities to contribute tab metadata, state behavior, runtime/remote behavior and commands without hard-coding every feature into one application switch.

The v0.0.2 Plugin Kernel solved that problem together with a much larger runtime-installable plugin lifecycle: install/uninstall, enable/disable, dependency management, activation ownership and journals. Tabverse does not currently require those package-manager semantics for trusted built-in features.

## Decision
Built-in capabilities use a compile-time `BuiltInFeatureModuleDefinition` / future `TabModule<State>` model.

The built-in feature registry centralizes identity, presentation metadata and close-lifecycle intent. Existing Workbench APIs are projected from that single catalog.

Module contracts may add runtime definitions, remote definitions and commands when concrete consumers require them. State codecs accept only their current representation; old-format migration is not part of the module contract.

## Non-goal
This is not the architecture for untrusted third-party extensions. If Tabverse later commits to an external plugin ecosystem, distribution, signatures, sandboxing, capability grants and compatibility will be designed as a separate trust problem.

## Consequences
- Built-in modularity remains simple and statically testable.
- Adding a new Tab type must be accounted for in the built-in feature catalog.
- Workbench remains independent of Desktop/Remote runtime implementations.
- V3 avoids recreating Plugin Kernel V1 merely because modularity is useful.
