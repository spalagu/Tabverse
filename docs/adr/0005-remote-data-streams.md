# ADR-0005: Remote uses independent QUIC data streams beside the control stream

## Status

Accepted. HTTP-related decisions are superseded by ADR-0017.

## Requirement

Remote semantic control traffic must stay responsive while file content or other large payloads are in flight. Bulk payloads must not use base64 JSON framing.

## Decision

One authenticated iroh connection carries a long-lived semantic control stream and independent raw-byte `FileRead` streams. File metadata uses bounded JSON frames; file bodies use raw bytes.

The Host accepts a file stream only after the control stream has authenticated the viewer. Before opening a file, the Host rechecks that the App share and viewer still exist. View, Steer, and Approve may read files. The Host Files backend validates paths.

Each authenticated connection has a 16-permit semaphore for file streams. QUIC stream backpressure handles waiting without occupying the control stream.

## Test requirement

A real iroh roundtrip must prove that a current App-share viewer can read file bytes through an independent stream. Join tests must prove that switching away cancels an unfinished `FileRead` stream and that file bodies do not use the `fs_read` control RPC.
