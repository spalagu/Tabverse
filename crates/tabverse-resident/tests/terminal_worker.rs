use anyhow::Result;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use tabverse_resident::{
    ArtifactVerifier, CapabilityRequest, EnsureRuntime, ProcessWorkerFactory, ProtocolRange,
    RuntimeDescriptor, SignatureVerifier, Supervisor,
};
use tabverse_term::{
    client::HelperClient,
    protocol::{AuthToken, Frame, Kind, SessionId},
};

struct FixtureSignature;

impl SignatureVerifier for FixtureSignature {
    fn verify(&self, descriptor: &RuntimeDescriptor, digest: &[u8]) -> Result<()> {
        anyhow::ensure!(descriptor.signature == format!("fixture:{}", hex::encode(digest)));
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    runtime_id: String,
    tab_id: String,
    port: u16,
    token_hex: String,
}

#[test]
fn supervisor_spawns_a_real_terminal_worker_and_gui_style_client_attaches() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("resident");
    let artifact = Path::new(env!("CARGO_BIN_EXE_tabverse-resident-worker"));
    let digest = Sha256::digest(std::fs::read(artifact).unwrap());
    let hash = hex::encode(digest);
    let supervisor = Supervisor::open(
        &root,
        ArtifactVerifier::new(Arc::new(FixtureSignature)),
        Arc::new(ProcessWorkerFactory::for_in_process_tests()),
    )
    .unwrap();
    let runtime = supervisor
        .ensure_runtime(EnsureRuntime {
            tab_id: "tab-terminal-1".into(),
            kind: "terminal".into(),
            descriptor: RuntimeDescriptor {
                plugin_id: "tabverse.tab.terminal".into(),
                plugin_version: "1.0.0".into(),
                artifact_hash: hash.clone(),
                entrypoint: artifact.file_name().unwrap().to_string_lossy().into_owned(),
                permissions: vec![CapabilityRequest {
                    capability: "terminal.pty".into(),
                    reason: "run the Terminal tab outside the GUI".into(),
                    optional: false,
                }],
                protocol_range: ProtocolRange::supervisor(),
                signature: format!("fixture:{hash}"),
            },
            artifact_source: artifact.into(),
            expected_catalog_revision: 0,
            request_id: "terminal-worker-integration".into(),
            initial_checkpoint: serde_json::json!({}),
        })
        .unwrap();

    let endpoint_path = root
        .join("runtime-endpoints")
        .join(format!("{}.json", runtime.runtime_id));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !endpoint_path.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let endpoint: Endpoint =
        serde_json::from_slice(&std::fs::read(&endpoint_path).unwrap()).unwrap();
    assert_eq!(endpoint.runtime_id, runtime.runtime_id);
    assert_eq!(endpoint.tab_id, runtime.tab_id);
    let token: [u8; 32] = hex::decode(endpoint.token_hex).unwrap().try_into().unwrap();
    let (client, _, _) = HelperClient::connect(
        ([127, 0, 0, 1], endpoint.port).into(),
        AuthToken::new(token),
        [9; 32],
        Arc::new(|_| {}),
    )
    .unwrap();
    let list = client
        .request(
            &Frame::new(Kind::List, SessionId::default(), 0, vec![]),
            Kind::List,
            None,
            Duration::from_secs(2),
        )
        .unwrap();
    assert_eq!(list.payload, b"[]");
    drop(client);
    supervisor.stop(&runtime).unwrap();
    assert!(!endpoint_path.exists());
}
