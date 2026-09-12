# ADR-0006: Desktop Browser Uses Wry Only

## Status
Accepted.

## Context and requirements
Desktop Browser must use each platform's native WebView while avoiding CEF, dual runtimes, and a custom Tauri fork.

## Decision
Use upstream Tauri and Wry: WKWebView on macOS, WebView2 on Windows, and WebKitGTK on Linux. Handle platform events only in `src-tauri` adapters.

## Alternatives rejected
- CEF: adds a second runtime, packaging chain, and security-update responsibility.
- Custom Tauri fork: expands long-term maintenance without a current capability requirement.

## Cross-platform impact
Product semantics are shared; WebView event wiring may be platform-specific.

## Remote bandwidth impact
The local Browser engine does not enter the Remote data plane. Browser tabs are unavailable on Join.

## Migration impact and reversibility
V3 does not import CEF state or helpers. A future engine change requires a new architecture decision and cannot silently add a second runtime inside an existing adapter.
