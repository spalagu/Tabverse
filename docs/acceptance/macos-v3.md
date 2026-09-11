# Tabverse V3 macOS acceptance

## Overview

1. Download the artifact matching the Mac from one GitHub Actions run: `macos-v3-acceptance-arm64-*` for Apple Silicon or `macos-v3-acceptance-x64-*` for Intel.
2. Verify `SHA256SUMS` and install `Tabverse.app` from the DMG.
3. Exercise local Browser tabs and Remote Terminal, Agent, Files, Settings, and Whole-App actions.
4. Confirm that Join reports Browser tabs as unavailable and performs no Host-network request for them.
5. Save `build-info.txt`, relevant Tabverse logs, and failed steps. Never record passwords, cookies, tickets, or private file contents.

The acceptance build is ad-hoc signed and is not notarized. If Gatekeeper blocks the first launch, use Finder's Open command or allow only Tabverse in System Settings → Privacy & Security. Do not disable Gatekeeper globally and do not run `spctl --master-disable`.

## Download, verify, and install

```bash
cd /path/to/unzipped-artifact
shasum -a 256 -c SHA256SUMS
```

Open the DMG and drag `Tabverse.app` to `/Applications`. If Finder and System Settings provide no per-app opening action, remove quarantine only from this app:

```bash
xattr -dr com.apple.quarantine /Applications/Tabverse.app
```

## Logs

Quit existing Tabverse processes, then launch the acceptance build from Terminal:

```bash
/Applications/Tabverse.app/Contents/MacOS/Tabverse 2>&1 | tee /tmp/tabverse-v3-acceptance.log
```

Share only the relevant, redacted section of `/tmp/tabverse-v3-acceptance.log` when a failure occurs.

## Checklist

### Local Browser

- Open HTTP and HTTPS pages, follow redirects, and load relative resources.
- Confirm navigation, scrolling, clicking, tab switching, and cancellation remain interactive while a page loads.
- Exercise local LAN, VPN/internal DNS, and Host-trusted enterprise HTTPS when those environments are available.

### Whole-App share

- Connect through the Join page and switch among Terminal, Agent, Files, Settings, and Browser rows.
- Confirm Browser selection displays `Browser tabs are not available through Remote.`
- Confirm Browser selection does not load the page, transmit pixels, or initiate a Host-network stream.
- Confirm Steer permits semantic actions and View prevents editable actions.

### Remote Files

- Select a text file larger than 4 MiB on the Host, then select the Files tab on Join.
- Confirm Join displays the first 4 MiB with a truncation notice.
- Switch away before a slow read completes and confirm the unfinished `FileRead` stream is cancelled.
- Confirm View can read content but cannot save; restore Steer and confirm editable actions return.
- Confirm file bodies use the independent raw-byte stream rather than `fs_read` RPC or base64 control frames.

## Result record

Record the GitHub Actions run URL, commit and target from `build-info.txt`, Mac model, CPU architecture, macOS version, and each checklist result. The workflow uploads CI artifacts only; it does not create or replace the `v0.0.1` tag or release.
