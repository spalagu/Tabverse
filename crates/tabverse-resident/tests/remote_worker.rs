use anyhow::Result;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tabverse_proto::{Access, SharedTabType};
use tabverse_remote::{
    InputOutcome, InputPayload, RemoteHub, ShareBinding, ShareOpts, ShareSource, ViewerId, Viewport,
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

struct Source {
    snapshots: mpsc::Sender<ViewerId>,
    inputs: mpsc::Sender<Vec<u8>>,
    binding: Mutex<Option<ShareBinding>>,
}

impl ShareSource for Source {
    fn kind(&self) -> SharedTabType {
        SharedTabType::Terminal
    }

    fn grid(&self) -> Option<Viewport> {
        Some(Viewport { cols: 80, rows: 24 })
    }

    fn request_snapshot(&self, viewer: ViewerId) {
        let _ = self.snapshots.send(viewer);
    }

    fn inject_input(
        &self,
        _viewer: ViewerId,
        _access: Access,
        payload: InputPayload,
    ) -> Result<InputOutcome> {
        if let InputPayload::Bytes(bytes) = payload {
            let _ = self.inputs.send(bytes);
        }
        Ok(InputOutcome::Applied)
    }

    fn bind(&self, binding: ShareBinding) {
        *self.binding.lock().unwrap() = Some(binding);
    }

    fn unbind(&self) {
        self.binding.lock().unwrap().take();
    }
}

#[test]
fn supervisor_owned_remote_worker_keeps_the_real_p2p_join_and_replays_events() {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let hub = RemoteHub::new();
            let (snapshot_tx, snapshot_rx) = mpsc::channel();
            let (input_tx, input_rx) = mpsc::channel();
            let source = Arc::new(Source {
                snapshots: snapshot_tx,
                inputs: input_tx,
                binding: Mutex::new(None),
            });
            let (share, ticket) = hub
                .share_start(ShareOpts {
                    title: "resident remote".into(),
                    source,
                    on_presence: Arc::new(|_| {}),
                    ttl: None,
                    access: Access::Steer,
                })
                .await
                .unwrap();

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
                    tab_id: "tab-remote-1".into(),
                    kind: "remote".into(),
                    descriptor: RuntimeDescriptor {
                        plugin_id: "tabverse.tab.remote".into(),
                        plugin_version: "1.0.0".into(),
                        artifact_hash: hash.clone(),
                        entrypoint: artifact.file_name().unwrap().to_string_lossy().into_owned(),
                        permissions: vec![CapabilityRequest {
                            capability: "remote.runtime".into(),
                            reason: "keep the P2P join outside the GUI".into(),
                            optional: false,
                        }],
                        protocol_range: ProtocolRange::supervisor(),
                        signature: format!("fixture:{hash}"),
                    },
                    artifact_source: artifact.into(),
                    expected_catalog_revision: 0,
                    request_id: "remote-worker-integration".into(),
                    initial_checkpoint: serde_json::json!({"joinTicket": ticket}),
                })
                .unwrap();

            let viewer = snapshot_rx
                .recv_timeout(Duration::from_secs(20))
                .expect("resident worker should join the real share");
            share.begin_buffering(viewer);
            share.snapshot_ready(
                viewer,
                data_encoding::BASE64.encode(b"resident-snapshot"),
                80,
                24,
            );

            let deadline = Instant::now() + Duration::from_secs(20);
            let replay = loop {
                let replay = supervisor.poll(&runtime, 0).unwrap();
                let has_welcome = replay.events.iter().any(|event| {
                    event.payload["type"] == "welcome"
                        && event.payload["tabTitle"] == "resident remote"
                });
                let has_snapshot = replay
                    .events
                    .iter()
                    .any(|event| event.payload["type"] == "snapshot");
                if has_welcome && has_snapshot {
                    break replay;
                }
                assert!(
                    Instant::now() < deadline,
                    "resident remote events timed out"
                );
                thread::sleep(Duration::from_millis(10));
            };
            assert!(!replay.events.is_empty());

            supervisor
                .send_intent(
                    &runtime,
                    &serde_json::to_vec(&serde_json::json!({
                        "type": "input",
                        "dataB64": data_encoding::BASE64.encode(b"whoami\n"),
                    }))
                    .unwrap(),
                )
                .unwrap();
            assert_eq!(
                input_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                b"whoami\n"
            );
            supervisor.stop(&runtime).unwrap();
        });
}
