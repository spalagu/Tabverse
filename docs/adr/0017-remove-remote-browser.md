# ADR-0017: Browser is local-only

## Status

Accepted.

## Context

The Join implementation attempted to reconstruct Browser pages from Host-fetched HTTP responses. Real websites depend on browser execution, security, storage, origin, and navigation behavior that document rewriting cannot reproduce reliably. A correct replacement would add a heavy browser/runtime component, pixel streaming, or substantial custom browser machinery. Those options conflict with the product constraints.

## Decision

Browser tabs are local-only.

- Whole-App share may show the Browser tab row so the shared workspace structure remains coherent.
- Selecting a Browser tab on Join displays an explicit unavailable message.
- Remote does not transmit Browser pixels, DOM, storage, cookies, history, or network traffic.
- HostNetworkGateway, Remote HTTP data streams, Join document rewriting, and the Join Service Worker proxy are removed.
- Independent raw-byte `FileRead` streams remain part of Remote Files.

## Consequences

Join continues to support Terminal, Agent, Files, Settings, and Workbench semantic actions. Browser content and interaction are not Remote capabilities. Reintroducing Browser Remote requires a new ADR and a solution that satisfies the product constraints without reviving the removed proxy/rewrite path.
