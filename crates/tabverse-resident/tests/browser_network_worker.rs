use anyhow::Result;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tabverse_resident::{
    ArtifactVerifier, CapabilityRequest, EnsureRuntime, ProcessWorkerFactory, ProtocolRange,
    RuntimeDescriptor, SignatureVerifier, Supervisor,
};

struct FixtureSignature;

impl SignatureVerifier for FixtureSignature {
    fn verify(&self, descriptor: &RuntimeDescriptor, digest: &[u8]) -> Result<()> {
        anyhow::ensure!(descriptor.signature == format!("fixture:{}", hex::encode(digest)));
        Ok(())
    }
}

#[test]
fn browser_network_worker_executes_on_the_host_network_and_enforces_its_origin_grant() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 4096];
        let read = stream.read(&mut request).unwrap();
        assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /inside HTTP/1.1"));
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\ncontent-length: 13\r\nconnection: close\r\n\r\ninternal-only",
            )
            .unwrap();
    });

    let dir = tempfile::tempdir().unwrap();
    let artifact = Path::new(env!("CARGO_BIN_EXE_tabverse-resident-worker"));
    let digest = Sha256::digest(std::fs::read(artifact).unwrap());
    let hash = hex::encode(digest);
    let supervisor = Supervisor::open(
        dir.path().join("resident"),
        ArtifactVerifier::new(Arc::new(FixtureSignature)),
        Arc::new(ProcessWorkerFactory::for_in_process_tests()),
    )
    .unwrap();
    let runtime = supervisor
        .ensure_runtime(EnsureRuntime {
            tab_id: "tab-browser-1".into(),
            kind: "browser-network".into(),
            descriptor: RuntimeDescriptor {
                plugin_id: "tabverse.tab.browser".into(),
                plugin_version: "1.0.0".into(),
                artifact_hash: hash.clone(),
                entrypoint: artifact.file_name().unwrap().to_string_lossy().into_owned(),
                permissions: vec![CapabilityRequest {
                    capability: "browser.host-network".into(),
                    reason: "route an already-started Browser request outside the GUI".into(),
                    optional: false,
                }],
                protocol_range: ProtocolRange::supervisor(),
                signature: format!("fixture:{hash}"),
            },
            artifact_source: artifact.into(),
            expected_catalog_revision: 0,
            request_id: "browser-network-worker-integration".into(),
            initial_checkpoint: serde_json::json!({}),
        })
        .unwrap();
    let origin = format!("http://127.0.0.1:{port}");
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    supervisor
        .send_intent(
            &runtime,
            &serde_json::to_vec(&serde_json::json!({
                "type": "browserOpen",
                "requestId": "request-1",
                "method": "GET",
                "url": format!("{origin}/inside"),
                "headers": [],
                "bodyB64": null,
                "grantOrigin": origin,
                "grantExpiresAtMs": expires,
                "pinnedAddrs": [format!("127.0.0.1:{port}")],
            }))
            .unwrap(),
        )
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let events = loop {
        let replay = supervisor.poll(&runtime, 0).unwrap();
        if replay
            .events
            .iter()
            .any(|event| event.payload["type"] == "browserResponseEnd")
        {
            break replay.events;
        }
        assert!(
            Instant::now() < deadline,
            "browser worker response timed out"
        );
        thread::sleep(Duration::from_millis(10));
    };
    let body = events
        .iter()
        .filter(|event| event.payload["type"] == "browserResponseChunk")
        .flat_map(|event| {
            data_encoding::BASE64
                .decode(event.payload["b64"].as_str().unwrap().as_bytes())
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(body, b"internal-only");
    server.join().unwrap();

    let acknowledged = events.last().unwrap().seq;
    supervisor
        .send_intent(
            &runtime,
            &serde_json::to_vec(&serde_json::json!({
                "type": "browserOpen",
                "requestId": "request-denied",
                "method": "GET",
                "url": format!("http://127.0.0.1:{port}/inside"),
                "headers": [],
                "bodyB64": null,
                "grantOrigin": "http://127.0.0.1:1",
                "grantExpiresAtMs": expires,
                "pinnedAddrs": [format!("127.0.0.1:{port}")],
            }))
            .unwrap(),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let denied_ack = loop {
        let replay = supervisor.poll(&runtime, acknowledged).unwrap();
        if replay.events.iter().any(|event| {
            event.payload["type"] == "browserResponseError"
                && event.payload["requestId"] == "request-denied"
        }) {
            break replay.events.last().unwrap().seq;
        }
        assert!(Instant::now() < deadline, "grant rejection timed out");
        thread::sleep(Duration::from_millis(10));
    };

    let slow_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let slow_port = slow_listener.local_addr().unwrap().port();
    let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
    let slow_server = thread::spawn(move || {
        let (mut stream, _) = slow_listener.accept().unwrap();
        let mut request = [0u8; 4096];
        let read = stream.read(&mut request).unwrap();
        assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /slow HTTP/1.1"));
        accepted_tx.send(()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut byte = [0u8; 1];
        match stream.read(&mut byte) {
            Ok(0) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof
                ) => {}
            outcome => panic!("cancel must close the host request socket: {outcome:?}"),
        }
    });
    let slow_origin = format!("http://127.0.0.1:{slow_port}");
    supervisor
        .send_intent(
            &runtime,
            &serde_json::to_vec(&serde_json::json!({
                "type": "browserOpen",
                "requestId": "request-cancelled",
                "method": "GET",
                "url": format!("{slow_origin}/slow"),
                "headers": [],
                "bodyB64": null,
                "grantOrigin": slow_origin,
                "grantExpiresAtMs": expires,
                "pinnedAddrs": [format!("127.0.0.1:{slow_port}")],
            }))
            .unwrap(),
        )
        .unwrap();
    accepted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let cancelled_at = Instant::now();
    supervisor
        .send_intent(
            &runtime,
            &serde_json::to_vec(&serde_json::json!({
                "type": "browserCancel",
                "requestId": "request-cancelled",
            }))
            .unwrap(),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let replay = supervisor.poll(&runtime, denied_ack).unwrap();
        if replay.events.iter().any(|event| {
            event.payload["type"] == "browserResponseError"
                && event.payload["requestId"] == "request-cancelled"
                && event.payload["code"] == "browser-network-cancelled"
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "browser cancellation timed out");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(cancelled_at.elapsed() < Duration::from_secs(1));
    slow_server.join().unwrap();
    supervisor.stop(&runtime).unwrap();
}
