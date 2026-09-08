# ADR-0005: Remote uses independent QUIC data streams beside the control stream

## Status
Accepted.

## Requirement
Remote semantic control traffic must stay responsive while Browser networking, file content, downloads, or other large payloads are in flight. V3 also requires bulk payloads to avoid base64 JSON framing.

## Decision
One authenticated iroh connection carries:

```text
stream 1: long-lived semantic control stream
stream N: independent bidirectional data stream
```

The first bidirectional stream remains the existing control protocol. After that stream has authenticated the viewer, the Host may accept additional bidirectional streams and dispatch them from a small `DataStreamPreface`.

HTTP is the first data stream kind. The same structure can later carry WebSocket, raw TCP, files, or other native data streams without changing semantic control messages.

## Isolation
Large data responses do not travel through the control channel and therefore do not occupy its JSON frame queue. QUIC stream-level multiplexing provides backpressure and isolates independent streams on the same encrypted connection.

Authentication remains connection-scoped: data streams are accepted only after the connection's control stream has successfully authenticated a Share ticket. The data-stream bridge does not create a second authentication protocol.

## Test requirement
A real iroh roundtrip must prove that:

1. stream 1 can carry a control marker;
2. a separate HTTP data stream can fetch Host `localhost` content larger than the old 1 MiB proxy ceiling;
3. the original control stream is still usable after the large response completes.
