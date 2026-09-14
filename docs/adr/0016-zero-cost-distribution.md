# ADR-0016: Adopt Zero-Cost Desktop Distribution

## Status

Accepted.

## Context and requirements

Tabverse is an open-source project. Current distribution must not depend on paid developer accounts, paid signing services, or paid hosting. A macOS Apple Developer ID requires paid Apple Developer Program membership, and Apple notarization requires a valid Developer ID signature, so both remain outside the current delivery boundary.

## Decision

- Build macOS installers on native Apple Silicon and Intel GitHub Actions runners.
- Keep macOS applications ad-hoc signed; do not obtain an Apple Developer ID or submit for Apple notarization.
- Windows and Linux builds must also avoid paid signing services.
- Upload each release candidate only as a GitHub Actions artifact. Publish a GitHub Release only for an explicitly created new version tag.
- Include a SHA-256 checksum, source commit, target architecture, and platform installation instructions with release artifacts.
- State clearly that the macOS application is not notarized and instruct users to allow only Tabverse; never require disabling Gatekeeper globally.
- Never overwrite an existing tag or release from the release workflow.

## Alternatives rejected

- Apple Developer ID and notarization: introduce an annual fee and account dependency.
- Mac App Store: requires a paid account and changes the direct-distribution model.
- Disabling Gatekeeper globally: expands the attack surface on the user's device.
- Hiding the lack of notarization in troubleshooting: prevents users from understanding installation requirements before downloading.

## User impact

On first launch, macOS users must right-click Tabverse in Finder and choose **Open**, or allow only Tabverse in **System Settings → Privacy & Security**. If needed, they can remove the quarantine attribute only from `/Applications/Tabverse.app`. Download instructions must disclose this limitation in advance.

## Migration impact and reversibility

Zero-cost distribution does not change application data or protocols. If the project later obtains compliant signing at no cost, a new ADR may add signing and notarization. The current commitment must not change silently.
