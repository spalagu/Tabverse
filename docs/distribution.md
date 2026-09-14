# Tabverse Zero-Cost Distribution

## Artifact provenance

GitHub Actions builds Tabverse installers from the corresponding version tag or an explicitly selected source ref. Verify the downloaded file against the `SHA256SUMS` from the same build before installing it.

## macOS

macOS installers use ad-hoc signatures. They do not use an Apple Developer ID and are not submitted for Apple notarization. Use an `aarch64` or `arm64` DMG on Apple Silicon and an `x64` DMG on Intel.

On first launch:

1. Drag `Tabverse.app` to `/Applications`.
2. In Finder, right-click `Tabverse.app` and choose **Open**.
3. If macOS still blocks it, open **System Settings → Privacy & Security** and choose **Open Anyway** for Tabverse only.

If macOS does not show the per-application option above, run:

```bash
xattr -dr com.apple.quarantine /Applications/Tabverse.app
```

This command removes the download quarantine attribute only from Tabverse. Do not run `spctl --master-disable` and do not disable Gatekeeper globally.

## Windows and Linux

Windows and Linux installers also avoid paid code-signing services. The operating system or security software may show an unknown-publisher warning. Download only from a `spalagu/Tabverse` GitHub Release or the corresponding GitHub Actions run, and verify the SHA-256 checksum.

## Release constraints

- Keep release candidates only as GitHub Actions artifacts; do not create a tag or release.
- Publish a final release from a new immutable version tag.
- Never overwrite an existing tag or GitHub Release.
- Preserve `v0.0.1` as a historical release; V3 does not overwrite it.
