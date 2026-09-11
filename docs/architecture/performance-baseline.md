# V3 performance baseline

Terminal and Agent GUI reconnection is covered by the real process-boundary tests in `src-tauri/tests/runtime_supervisor_process.rs`. Remote Files uses an independent QUIC stream so file bytes cannot occupy the semantic control queue.

Resident Browser/Terminal memory, full GUI cold-start time, and real network latency remain device acceptance measurements. A macOS loopback number cannot prove Windows or Linux behavior.
