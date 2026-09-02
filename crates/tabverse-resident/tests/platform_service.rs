use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Output, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tabverse_proto::{Access, SharedTabType};
use tabverse_remote::{
    InputOutcome, InputPayload, RemoteHub, ShareBinding, ShareOpts, ShareSource, ViewerId, Viewport,
};
use tabverse_resident::{
    resolve_current_supervisor, AuthToken, EnsureRuntime, InstallArtifacts, InstallPlan,
    PlatformKind, ProtocolRange, ResidentClient, RuntimeDescriptor, RuntimeRef, RuntimeStatus,
};
use tabverse_term::{
    client::HelperClient,
    protocol::{AuthToken as TerminalAuthToken, Frame, Kind, SessionId},
};
use wait_timeout::ChildExt;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const PACKAGE_COMMAND_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const GUI_FIXTURE_CONFIG: &str = "TABVERSE_RESIDENT_GUI_FIXTURE_CONFIG";

struct ServiceCleanup {
    plan: InstallPlan,
    root: PathBuf,
    armed: bool,
}

impl Drop for ServiceCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = cleanup_acceptance_plan(&self.plan, &self.root);
        }
    }
}

struct RemoteSource {
    snapshots: mpsc::Sender<ViewerId>,
    inputs: mpsc::Sender<Vec<u8>>,
    binding: Mutex<Option<ShareBinding>>,
}

impl ShareSource for RemoteSource {
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
    ) -> anyhow::Result<InputOutcome> {
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

#[derive(Debug)]
struct PackageResources {
    root: PathBuf,
    supervisor: PathBuf,
    launcher: PathBuf,
    trusted_keys: PathBuf,
    package_version: String,
    package_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageAcceptanceManifest {
    version: String,
    package_sha256: String,
}

impl PackageResources {
    fn from_env(name: &str) -> Self {
        let root = PathBuf::from(env::var_os(name).unwrap_or_else(|| {
            panic!("{name} must point at resident resources extracted from an installed package")
        }));
        Self::from_path(root)
    }

    fn from_path(root: PathBuf) -> Self {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let manifest: PackageAcceptanceManifest =
            serde_json::from_slice(&fs::read(root.join(".package-acceptance.json")).unwrap())
                .unwrap();
        assert!(
            manifest.package_sha256.len() == 64
                && manifest
                    .package_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        );
        let resources = Self {
            supervisor: root
                .join("control")
                .join(format!("tabverse-resident-supervisor{suffix}")),
            launcher: root
                .join("control")
                .join(format!("tabverse-resident-launcher{suffix}")),
            trusted_keys: root.join("control/trusted-keys.json"),
            root,
            package_version: manifest.version,
            package_sha256: manifest.package_sha256,
        };
        for required in [
            &resources.supervisor,
            &resources.launcher,
            &resources.trusted_keys,
            &resources.root.join("terminal/descriptor.json"),
            &resources.root.join("remote/descriptor.json"),
        ] {
            assert!(
                required.is_file(),
                "installed package resource is missing: {}",
                required.display()
            );
        }
        resources
    }

    fn install_artifacts(&self) -> InstallArtifacts {
        InstallArtifacts {
            supervisor_hash: hash(&self.supervisor),
            supervisor_source: self.supervisor.clone(),
            supervisor_version: self.package_version.clone(),
            launcher_hash: hash(&self.launcher),
            launcher_source: self.launcher.clone(),
            trusted_keys_json: fs::read(&self.trusted_keys).unwrap(),
        }
    }

    fn runtime_request(
        &self,
        kind: &str,
        tab_id: &str,
        request_id: &str,
        initial_checkpoint: Value,
    ) -> EnsureRuntime {
        let descriptor: RuntimeDescriptor = serde_json::from_slice(
            &fs::read(self.root.join(kind).join("descriptor.json")).unwrap(),
        )
        .unwrap();
        let artifact_source = self.root.join(kind).join(&descriptor.entrypoint);
        assert!(artifact_source.is_file());
        EnsureRuntime {
            tab_id: tab_id.into(),
            kind: kind.into(),
            descriptor,
            artifact_source,
            expected_catalog_revision: 1,
            request_id: request_id.into(),
            initial_checkpoint,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuiFixtureConfig {
    mode: String,
    root: PathBuf,
    package_root: PathBuf,
    state_path: PathBuf,
    continue_path: Option<PathBuf>,
    ticket: Option<String>,
    terminal_runtime: Option<RuntimeRef>,
    remote_runtime: Option<RuntimeRef>,
    expected_outputs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuiFixtureState {
    phase: String,
    protocol: u16,
    terminal_runtime: RuntimeRef,
    remote_runtime: RuntimeRef,
    supervisor_pid: u32,
    terminal_worker_pid: u32,
    remote_worker_pid: u32,
    event_sequences: Vec<u64>,
    event_gap_or_duplicate_count: usize,
    old_terminal_generation_rejected: bool,
    old_remote_generation_rejected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkerProcesses {
    terminal_pid: u32,
    remote_pid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessObservation {
    supervisor_pid: u32,
    terminal_worker_pid: u32,
    remote_worker_pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessEvidence {
    normal_gui_ready: ProcessObservation,
    normal_gui_exited: ProcessObservation,
    crash_gui_ready: ProcessObservation,
    crash_gui_killed: ProcessObservation,
    package_v2_install_started: ProcessObservation,
    package_v2_install_finished: ProcessObservation,
    package_v2_takeover: ProcessObservation,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundaryOutcomes {
    normal_gui_exit_success: bool,
    normal_gui_exit_code: Option<i32>,
    crashed_gui_exit_success: bool,
    crashed_gui_exit_code: Option<i32>,
    package_v2_install_success: bool,
    package_v2_install_exit_code: Option<i32>,
}

#[test]
fn process_evidence_schema_rejects_missing_boundaries_and_pid_drift() {
    let baseline = ProcessObservation {
        supervisor_pid: 10,
        terminal_worker_pid: 20,
        remote_worker_pid: 30,
    };
    let evidence = ProcessEvidence {
        normal_gui_ready: baseline,
        normal_gui_exited: baseline,
        crash_gui_ready: baseline,
        crash_gui_killed: baseline,
        package_v2_install_started: baseline,
        package_v2_install_finished: baseline,
        package_v2_takeover: baseline,
    };
    assert!(evidence.workers_owned_by_supervisor());
    assert!(evidence.normal_gui_exit_preserved_workers());
    assert!(evidence.crashed_gui_exit_preserved_workers());
    assert!(evidence.package_replacement_preserved_workers());

    let value = serde_json::to_value(&evidence).unwrap();
    for field in [
        "normalGuiReady",
        "normalGuiExited",
        "crashGuiReady",
        "crashGuiKilled",
        "packageV2InstallStarted",
        "packageV2InstallFinished",
        "packageV2Takeover",
    ] {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<ProcessEvidence>(missing).is_err());
    }

    let mut drifted = evidence.clone();
    drifted.package_v2_install_finished.remote_worker_pid += 1;
    assert!(!drifted.workers_owned_by_supervisor());
    assert!(!drifted.package_replacement_preserved_workers());
}

impl ProcessEvidence {
    fn workers_owned_by_supervisor(&self) -> bool {
        self.all()
            .iter()
            .all(|value| *value == self.normal_gui_ready)
    }

    fn normal_gui_exit_preserved_workers(&self) -> bool {
        self.normal_gui_ready == self.normal_gui_exited
    }

    fn crashed_gui_exit_preserved_workers(&self) -> bool {
        self.crash_gui_ready == self.crash_gui_killed
    }

    fn package_replacement_preserved_workers(&self) -> bool {
        self.package_v2_install_started == self.package_v2_install_finished
    }

    fn all(&self) -> [ProcessObservation; 7] {
        [
            self.normal_gui_ready,
            self.normal_gui_exited,
            self.crash_gui_ready,
            self.crash_gui_killed,
            self.package_v2_install_started,
            self.package_v2_install_finished,
            self.package_v2_takeover,
        ]
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalEndpoint {
    runtime_id: String,
    tab_id: String,
    pid: u32,
    port: u16,
    token_hex: String,
}

#[test]
#[ignore = "launched as an independent GUI client subprocess by the three-platform service acceptance test"]
fn gui_client_fixture() {
    assert_acceptance_environment();
    let config_path = PathBuf::from(
        env::var_os(GUI_FIXTURE_CONFIG).expect("GUI fixture config path is required"),
    );
    let config: GuiFixtureConfig =
        serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    let package = PackageResources::from_path(config.package_root.clone());
    let client = connect(&config.root, &format!("acceptance-{}", config.mode));
    let protocol = client.welcome.protocol;

    match config.mode.as_str() {
        "create-normal" => {
            client.sync_catalog_revision(1).unwrap();
            let terminal = client
                .ensure_runtime(package.runtime_request(
                    "terminal",
                    "tab-terminal-acceptance",
                    "terminal-package-v1",
                    serde_json::json!({}),
                ))
                .unwrap();
            let remote = client
                .ensure_runtime(package.runtime_request(
                    "remote",
                    "tab-remote-acceptance",
                    "remote-package-v1",
                    serde_json::json!({"joinTicket": config.ticket.unwrap()}),
                ))
                .unwrap();
            let endpoint = wait_for_terminal_endpoint(&config.root, &terminal);
            assert_terminal_accepts(&endpoint);
            let processes = observe_processes(&config.root);
            assert_eq!(endpoint.pid, processes.terminal_worker_pid);
            write_fixture_state(
                &config.state_path,
                &GuiFixtureState {
                    phase: "ready".into(),
                    protocol,
                    terminal_runtime: terminal.clone(),
                    remote_runtime: remote.clone(),
                    supervisor_pid: processes.supervisor_pid,
                    terminal_worker_pid: endpoint.pid,
                    remote_worker_pid: processes.remote_worker_pid,
                    event_sequences: vec![],
                    event_gap_or_duplicate_count: 0,
                    old_terminal_generation_rejected: false,
                    old_remote_generation_rejected: false,
                },
            );
            wait_for_file(config.continue_path.as_ref().unwrap());
            let expected: Vec<&str> = config.expected_outputs.iter().map(String::as_str).collect();
            let events = wait_for_remote_outputs(&client, &remote, &expected);
            let event_sequences = events.iter().map(|event| event.seq).collect();
            client.detach(terminal.clone()).unwrap();
            client.detach(remote.clone()).unwrap();
            write_fixture_state(
                &config.state_path,
                &GuiFixtureState {
                    phase: "complete".into(),
                    protocol,
                    terminal_runtime: terminal,
                    remote_runtime: remote,
                    supervisor_pid: processes.supervisor_pid,
                    terminal_worker_pid: endpoint.pid,
                    remote_worker_pid: processes.remote_worker_pid,
                    event_sequences,
                    event_gap_or_duplicate_count: 0,
                    old_terminal_generation_rejected: false,
                    old_remote_generation_rejected: false,
                },
            );
        }
        "attach-crash" => {
            let expected_terminal = config.terminal_runtime.unwrap();
            let expected_remote = config.remote_runtime.unwrap();
            assert_running_runtime_ids(&client, &expected_terminal, &expected_remote);
            let terminal = client
                .attach(expected_terminal.runtime_id.clone(), 0)
                .unwrap()
                .runtime;
            let remote = client
                .attach(expected_remote.runtime_id.clone(), 0)
                .unwrap()
                .runtime;
            let endpoint = wait_for_terminal_endpoint(&config.root, &terminal);
            assert_terminal_accepts(&endpoint);
            let processes = observe_processes(&config.root);
            assert_eq!(endpoint.pid, processes.terminal_worker_pid);
            write_fixture_state(
                &config.state_path,
                &GuiFixtureState {
                    phase: "ready".into(),
                    protocol,
                    terminal_runtime: terminal,
                    remote_runtime: remote,
                    supervisor_pid: processes.supervisor_pid,
                    terminal_worker_pid: endpoint.pid,
                    remote_worker_pid: processes.remote_worker_pid,
                    event_sequences: vec![],
                    event_gap_or_duplicate_count: 0,
                    old_terminal_generation_rejected: false,
                    old_remote_generation_rejected: false,
                },
            );
            wait_for_file(config.continue_path.as_ref().unwrap());
            panic!("attach-crash fixture must be force-killed by the parent acceptance test");
        }
        "takeover-v2" => {
            let stale_terminal = config.terminal_runtime.unwrap();
            let stale_remote = config.remote_runtime.unwrap();
            assert_running_runtime_ids(&client, &stale_terminal, &stale_remote);
            let terminal = client
                .attach(stale_terminal.runtime_id.clone(), 0)
                .unwrap()
                .runtime;
            let remote_attach = client.attach(stale_remote.runtime_id.clone(), 0).unwrap();
            let remote = remote_attach.runtime;
            assert!(terminal.generation > stale_terminal.generation);
            assert!(remote.generation > stale_remote.generation);
            let old_terminal_generation_rejected = client
                .send_intent(stale_terminal, b"stale-terminal".to_vec())
                .is_err();
            let old_remote_generation_rejected = client
                .send_intent(stale_remote, b"stale-remote".to_vec())
                .is_err();
            assert!(old_terminal_generation_rejected);
            assert!(old_remote_generation_rejected);
            let expected: Vec<&str> = config.expected_outputs.iter().map(String::as_str).collect();
            let events = wait_for_remote_outputs(&client, &remote, &expected);
            let event_sequences: Vec<u64> = events.iter().map(|event| event.seq).collect();
            let event_gap_or_duplicate_count = event_sequences
                .windows(2)
                .filter(|pair| pair[1] != pair[0].saturating_add(1))
                .count();
            assert_eq!(event_sequences.first(), Some(&1));
            assert_eq!(event_gap_or_duplicate_count, 0);
            client
                .send_intent(
                    remote.clone(),
                    serde_json::to_vec(&serde_json::json!({
                        "type": "input",
                        "dataB64": data_encoding::BASE64.encode(b"AFTER-TAKEOVER\n"),
                    }))
                    .unwrap(),
                )
                .unwrap();
            let endpoint = wait_for_terminal_endpoint(&config.root, &terminal);
            assert_terminal_accepts(&endpoint);
            let processes = observe_processes(&config.root);
            assert_eq!(endpoint.pid, processes.terminal_worker_pid);
            client.stop(terminal.clone()).unwrap();
            client.stop(remote.clone()).unwrap();
            write_fixture_state(
                &config.state_path,
                &GuiFixtureState {
                    phase: "complete".into(),
                    protocol,
                    terminal_runtime: terminal,
                    remote_runtime: remote,
                    supervisor_pid: processes.supervisor_pid,
                    terminal_worker_pid: endpoint.pid,
                    remote_worker_pid: processes.remote_worker_pid,
                    event_sequences,
                    event_gap_or_duplicate_count,
                    old_terminal_generation_rejected,
                    old_remote_generation_rejected,
                },
            );
        }
        mode => panic!("unsupported GUI fixture mode: {mode}"),
    }
}

#[test]
#[ignore = "registers a real isolated user-level platform service and may run only on a dedicated GitHub Actions runner"]
fn user_service_preserves_real_runtimes_across_gui_exit_and_package_reinstall() {
    assert_acceptance_environment();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(exercise_platform_service());
}

async fn exercise_platform_service() {
    let platform = PlatformKind::current().unwrap();
    let nonce = acceptance_nonce();
    let root = acceptance_root(&nonce);
    let plan =
        InstallPlan::render_acceptance(platform, &root, current_user_config_root(platform), &nonce)
            .unwrap();
    assert!(!root.exists(), "refusing to reuse acceptance root");
    assert!(!plan.is_registered_current_user().unwrap());
    for file in &plan.files {
        assert!(
            !file.path.exists(),
            "refusing to overwrite an existing acceptance service file: {}",
            file.path.display()
        );
    }

    let package_v1 = PackageResources::from_env("TABVERSE_RESIDENT_PACKAGE_V1");
    assert_eq!(package_v1.package_version, "0.0.1");
    let first = plan.stage(&package_v1.install_artifacts()).unwrap();
    let original_token = fs::read(&first.auth_token).unwrap();
    let mut cleanup = ServiceCleanup {
        plan: plan.clone(),
        root: root.clone(),
        armed: true,
    };
    plan.activate_current_user().unwrap();
    assert!(plan.is_registered_current_user().unwrap());

    // Kill the control plane before it owns any runtime. This separately
    // proves service-managed recovery without pretending a Supervisor crash
    // preserves child-process ownership.
    let activated_pid = wait_for_live_endpoint(&root, None);
    assert_running_from(activated_pid, &first.supervisor_slot);
    kill_process(activated_pid);
    let restarted_pid = wait_for_live_endpoint(&root, Some(activated_pid));
    assert_running_from(restarted_pid, &first.supervisor_slot);

    let (snapshot_tx, snapshot_rx) = mpsc::channel();
    let (input_tx, input_rx) = mpsc::channel();
    let hub = RemoteHub::new();
    let (share, ticket) = hub
        .share_start(ShareOpts {
            title: "resident package acceptance".into(),
            source: Arc::new(RemoteSource {
                snapshots: snapshot_tx,
                inputs: input_tx,
                binding: Mutex::new(None),
            }),
            on_presence: Arc::new(|_| {}),
            ttl: None,
            access: Access::Steer,
        })
        .await
        .unwrap();

    let direct_spawn_rejected = assert_direct_worker_spawn_rejected(&package_v1, &root);
    let normal_config = root.join("gui-normal-config.json");
    let normal_state = root.join("gui-normal-state.json");
    let normal_continue = root.join("gui-normal-continue");
    write_fixture_config(
        &normal_config,
        &GuiFixtureConfig {
            mode: "create-normal".into(),
            root: root.clone(),
            package_root: package_v1.root.clone(),
            state_path: normal_state.clone(),
            continue_path: Some(normal_continue.clone()),
            ticket: Some(ticket),
            terminal_runtime: None,
            remote_runtime: None,
            expected_outputs: vec!["BEFORE-GUI-EXIT".into()],
        },
    );
    let mut normal_gui = spawn_gui_fixture(&normal_config);
    let normal_ready = wait_for_fixture_phase(&normal_state, "ready");
    assert_eq!(normal_ready.protocol, ProtocolRange::supervisor().max);
    let terminal_before = normal_ready.terminal_runtime.clone();
    let remote_before = normal_ready.remote_runtime.clone();
    let terminal_endpoint_before = wait_for_terminal_endpoint(&root, &terminal_before);
    assert_eq!(
        terminal_endpoint_before.pid,
        normal_ready.terminal_worker_pid
    );
    let normal_gui_ready_processes = fixture_processes(&normal_ready);
    assert_eq!(normal_gui_ready_processes.supervisor_pid, restarted_pid);
    assert_eq!(observe_processes(&root), normal_gui_ready_processes);

    let viewer = snapshot_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("resident Remote runtime did not join its real local share");
    share.begin_buffering(viewer);
    share.snapshot_ready(
        viewer,
        data_encoding::BASE64.encode(b"PACKAGE-SNAPSHOT"),
        80,
        24,
    );
    share.broadcast_output(b"BEFORE-GUI-EXIT");
    fs::write(&normal_continue, b"exit normally").unwrap();
    let normal_gui_status = assert_child_success(&mut normal_gui, "normal GUI client");
    let normal_complete = wait_for_fixture_phase(&normal_state, "complete");
    let seq_before_exit = *normal_complete.event_sequences.last().unwrap();

    // A separate GUI client process has detached both leases and exited with
    // status 0. The Supervisor and both workers remain the same processes.
    share.broadcast_output(b"WHILE-GUI-DOWN");
    thread::sleep(Duration::from_millis(100));
    let supervisor_during_reinstall = endpoint_pid(&root).unwrap();
    assert_eq!(supervisor_during_reinstall, restarted_pid);
    let terminal_endpoint_during_exit = wait_for_terminal_endpoint(&root, &terminal_before);
    assert_eq!(
        terminal_endpoint_before.pid,
        terminal_endpoint_during_exit.pid
    );
    assert_terminal_accepts(&terminal_endpoint_during_exit);
    let normal_gui_exited_processes = observe_processes(&root);

    // A second independent GUI client takes both leases and is then force-
    // killed. This is the crash boundary; neither worker may follow it down.
    let crash_config = root.join("gui-crash-config.json");
    let crash_state = root.join("gui-crash-state.json");
    let crash_continue = root.join("gui-crash-continue-never-created");
    write_fixture_config(
        &crash_config,
        &GuiFixtureConfig {
            mode: "attach-crash".into(),
            root: root.clone(),
            package_root: package_v1.root.clone(),
            state_path: crash_state.clone(),
            continue_path: Some(crash_continue),
            ticket: None,
            terminal_runtime: Some(terminal_before.clone()),
            remote_runtime: Some(remote_before.clone()),
            expected_outputs: vec![],
        },
    );
    let mut crash_gui = spawn_gui_fixture(&crash_config);
    let crash_ready = wait_for_fixture_phase(&crash_state, "ready");
    let crash_gui_ready_processes = fixture_processes(&crash_ready);
    assert_eq!(observe_processes(&root), crash_gui_ready_processes);
    let crashed_gui_status = force_kill_child(&mut crash_gui, "crashing GUI client");
    share.broadcast_output(b"AFTER-GUI-CRASH");
    let crash_gui_killed_processes = observe_processes(&root);

    // Build v2 happened earlier, but the real DMG/NSIS/AppImage replacement is
    // deliberately executed only now, while the service owns both runtimes.
    let package_v2_install_started_processes = observe_processes(&root);
    let package_v2_install_status = install_package_v2_during_live_runtimes();
    let package_v2 = PackageResources::from_path(package_resources_root().join("v2"));
    assert_eq!(package_v2.package_version, "0.0.2");
    assert_ne!(package_v1.package_sha256, package_v2.package_sha256);
    let package_v2_install_finished_processes = observe_processes(&root);

    // New-app startup stages the just-installed package into an immutable slot.
    // It must not restart the owner while package-v1 runtimes are live.
    let second = plan.stage(&package_v2.install_artifacts()).unwrap();
    let token_preserved = fs::read(&second.auth_token).unwrap() == original_token;
    let old_slot_preserved = first.supervisor_slot.exists();
    let pointer_switched = resolve_current_supervisor(&root).unwrap() == second.supervisor_slot;
    assert!(token_preserved);
    assert!(old_slot_preserved);
    assert!(pointer_switched);
    assert_ne!(first.supervisor_slot, second.supervisor_slot);
    assert_eq!(endpoint_pid(&root), Some(restarted_pid));
    assert_running_from(restarted_pid, &first.supervisor_slot);

    let takeover_config = root.join("gui-takeover-config.json");
    let takeover_state = root.join("gui-takeover-state.json");
    write_fixture_config(
        &takeover_config,
        &GuiFixtureConfig {
            mode: "takeover-v2".into(),
            root: root.clone(),
            package_root: package_v2.root.clone(),
            state_path: takeover_state.clone(),
            continue_path: None,
            ticket: None,
            terminal_runtime: Some(crash_ready.terminal_runtime.clone()),
            remote_runtime: Some(crash_ready.remote_runtime.clone()),
            expected_outputs: vec![
                "BEFORE-GUI-EXIT".into(),
                "WHILE-GUI-DOWN".into(),
                "AFTER-GUI-CRASH".into(),
            ],
        },
    );
    let mut takeover_gui = spawn_gui_fixture(&takeover_config);
    assert_eq!(
        input_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        b"AFTER-TAKEOVER\n"
    );
    let _takeover_gui_status =
        assert_child_success(&mut takeover_gui, "package-v2 takeover GUI client");
    let takeover = wait_for_fixture_phase(&takeover_state, "complete");
    let package_v2_takeover_processes = fixture_processes(&takeover);
    let second_protocol = takeover.protocol;
    assert_eq!(second_protocol, ProtocolRange::supervisor().max);
    let terminal_after = takeover.terminal_runtime;
    let remote_after = takeover.remote_runtime;
    assert_eq!(terminal_after.runtime_id, terminal_before.runtime_id);
    assert_eq!(remote_after.runtime_id, remote_before.runtime_id);
    assert!(terminal_after.generation > crash_ready.terminal_runtime.generation);
    assert!(remote_after.generation > crash_ready.remote_runtime.generation);
    assert!(takeover.event_sequences.last().copied().unwrap() > seq_before_exit);
    let event_sequences = takeover.event_sequences;
    let event_gap_or_duplicate_count = takeover.event_gap_or_duplicate_count;
    let old_terminal_generation_rejected = takeover.old_terminal_generation_rejected;
    let old_remote_generation_rejected = takeover.old_remote_generation_rejected;
    let terminal_worker_pid_after = takeover.terminal_worker_pid;
    let terminal_worker_preserved = terminal_worker_pid_after == terminal_endpoint_before.pid;
    assert!(terminal_worker_preserved);
    let same_terminal_runtime = terminal_after.runtime_id == terminal_before.runtime_id;
    let same_remote_runtime = remote_after.runtime_id == remote_before.runtime_id;
    let process_evidence = ProcessEvidence {
        normal_gui_ready: normal_gui_ready_processes,
        normal_gui_exited: normal_gui_exited_processes,
        crash_gui_ready: crash_gui_ready_processes,
        crash_gui_killed: crash_gui_killed_processes,
        package_v2_install_started: package_v2_install_started_processes,
        package_v2_install_finished: package_v2_install_finished_processes,
        package_v2_takeover: package_v2_takeover_processes,
    };
    let boundary_outcomes = BoundaryOutcomes {
        normal_gui_exit_success: normal_gui_status.success(),
        normal_gui_exit_code: normal_gui_status.code(),
        crashed_gui_exit_success: crashed_gui_status.success(),
        crashed_gui_exit_code: crashed_gui_status.code(),
        package_v2_install_success: package_v2_install_status.success(),
        package_v2_install_exit_code: package_v2_install_status.code(),
    };
    let workers_owned_by_supervisor = process_evidence.workers_owned_by_supervisor();
    let normal_gui_exit_verified = boundary_outcomes.normal_gui_exit_success
        && process_evidence.normal_gui_exit_preserved_workers();
    let crashed_gui_exit_verified = !boundary_outcomes.crashed_gui_exit_success
        && process_evidence.crashed_gui_exit_preserved_workers();
    let package_replacement_while_runtimes_live = boundary_outcomes.package_v2_install_success
        && process_evidence.package_replacement_preserved_workers();
    assert!(workers_owned_by_supervisor);
    assert!(normal_gui_exit_verified);
    assert!(crashed_gui_exit_verified);
    assert!(package_replacement_while_runtimes_live);

    // With no live runtime left, a manager restart may move the control plane
    // to the staged package-v2 slot.
    plan.restart_current_user().unwrap();
    let package_v2_pid = wait_for_live_endpoint(&root, Some(restarted_pid));
    assert_running_from(package_v2_pid, &second.supervisor_slot);

    plan.deactivate_current_user().unwrap();
    wait_for_disconnected_endpoint(&root);
    let deactivated = !plan.is_registered_current_user().unwrap();
    assert!(deactivated);
    cleanup_acceptance_plan(&plan, &root).unwrap();
    cleanup.armed = false;

    println!(
        "{}",
        serde_json::json!({
            "schema": "tabverse-resident-platform-acceptance/v2",
            "platform": format!("{platform:?}"),
            "service": plan.service_name,
            "packageV1Sha256": package_v1.package_sha256,
            "packageV2Sha256": package_v2.package_sha256,
            "activatedPid": activated_pid,
            "restartedAfterFailurePid": restarted_pid,
            "supervisorPidDuringPackageReinstall": supervisor_during_reinstall,
            "packageV2SupervisorPid": package_v2_pid,
            "terminalRuntimeId": terminal_after.runtime_id,
            "remoteRuntimeId": remote_after.runtime_id,
            "packageV1NegotiatedProtocol": normal_ready.protocol,
            "packageV2NegotiatedProtocol": second_protocol,
            "terminalGenerationBefore": terminal_before.generation,
            "terminalGenerationAfter": terminal_after.generation,
            "remoteGenerationBefore": remote_before.generation,
            "remoteGenerationAfter": remote_after.generation,
            "terminalWorkerPidBefore": terminal_endpoint_before.pid,
            "terminalWorkerPidAfter": terminal_worker_pid_after,
            "processObservations": process_evidence,
            "boundaryOutcomes": boundary_outcomes,
            "workersOwnedBySupervisor": workers_owned_by_supervisor,
            "normalGuiExitVerified": normal_gui_exit_verified,
            "crashedGuiExitVerified": crashed_gui_exit_verified,
            "packageReplacementWhileRuntimesLive": package_replacement_while_runtimes_live,
            "directSpawnRejected": direct_spawn_rejected,
            "eventSequences": event_sequences,
            "eventGapOrDuplicateCount": event_gap_or_duplicate_count,
            "sameTerminalRuntime": same_terminal_runtime,
            "sameRemoteRuntime": same_remote_runtime,
            "terminalWorkerPreserved": terminal_worker_preserved,
            "oldTerminalGenerationRejected": old_terminal_generation_rejected,
            "oldRemoteGenerationRejected": old_remote_generation_rejected,
            "tokenPreserved": token_preserved,
            "oldSlotPreserved": old_slot_preserved,
            "pointerSwitched": pointer_switched,
            "deactivated": deactivated
        })
    );
}

#[test]
#[ignore = "fallback cleanup for the isolated user-level service created by this GitHub Actions run"]
fn cleanup_acceptance_service() {
    assert_acceptance_environment();
    let platform = PlatformKind::current().unwrap();
    let nonce = acceptance_nonce();
    let root = acceptance_root(&nonce);
    let plan =
        InstallPlan::render_acceptance(platform, &root, current_user_config_root(platform), &nonce)
            .unwrap();
    cleanup_acceptance_plan(&plan, &root).unwrap();
    assert!(!plan.is_registered_current_user().unwrap());
}

fn assert_acceptance_environment() {
    assert_eq!(env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
    assert_eq!(
        env::var("TABVERSE_RESIDENT_PLATFORM_ACCEPTANCE").as_deref(),
        Ok("1")
    );
}

fn acceptance_nonce() -> String {
    let nonce = env::var("TABVERSE_RESIDENT_ACCEPTANCE_NONCE").unwrap();
    assert!(
        !nonce.is_empty()
            && nonce.len() <= 96
            && nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    );
    nonce
}

fn acceptance_root(nonce: &str) -> PathBuf {
    PathBuf::from(env::var_os("RUNNER_TEMP").unwrap())
        .join("tabverse-resident-platform-acceptance")
        .join(nonce)
}

fn cleanup_acceptance_plan(plan: &InstallPlan, root: &Path) -> anyhow::Result<()> {
    plan.deactivate_current_user()?;
    if plan.is_registered_current_user()? {
        anyhow::bail!("acceptance service remained registered after cleanup")
    }
    for file in &plan.files {
        if file.path.exists() {
            fs::remove_file(&file.path)?;
        }
    }
    let runner_temp = PathBuf::from(env::var_os("RUNNER_TEMP").unwrap());
    anyhow::ensure!(root.starts_with(&runner_temp));
    if root.exists() {
        fs::remove_dir_all(root)?;
    }
    Ok(())
}

fn hash(path: &Path) -> String {
    hex::encode(Sha256::digest(fs::read(path).unwrap()))
}

fn current_user_config_root(platform: PlatformKind) -> PathBuf {
    match platform {
        PlatformKind::MacOs => PathBuf::from(env::var_os("HOME").unwrap()).join("Library"),
        PlatformKind::Windows => PathBuf::from(env::var_os("APPDATA").unwrap()),
        PlatformKind::Linux => env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap()).join(".config")),
    }
}

fn token(root: &Path) -> Option<AuthToken> {
    fs::read(root.join("auth-token"))
        .ok()?
        .try_into()
        .ok()
        .map(AuthToken::new)
}

fn connect(root: &Path, app_version: &str) -> ResidentClient {
    ResidentClient::connect(
        root,
        token(root).unwrap(),
        app_version,
        ProtocolRange::supervisor(),
    )
    .unwrap()
}

fn assert_running_runtime_ids(client: &ResidentClient, terminal: &RuntimeRef, remote: &RuntimeRef) {
    let running = client.list().unwrap();
    assert!(running.iter().any(|(runtime, status)| {
        runtime.runtime_id == terminal.runtime_id && *status == RuntimeStatus::Running
    }));
    assert!(running.iter().any(|(runtime, status)| {
        runtime.runtime_id == remote.runtime_id && *status == RuntimeStatus::Running
    }));
}

fn write_fixture_config(path: &Path, config: &GuiFixtureConfig) {
    fs::write(path, serde_json::to_vec_pretty(config).unwrap()).unwrap();
}

fn write_fixture_state(path: &Path, state: &GuiFixtureState) {
    let temporary = path.with_extension(format!("json.tmp-{}", std::process::id()));
    fs::write(&temporary, serde_json::to_vec_pretty(state).unwrap()).unwrap();
    fs::rename(temporary, path).unwrap();
}

fn wait_for_fixture_phase(path: &Path, phase: &str) -> GuiFixtureState {
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(state) = serde_json::from_slice::<GuiFixtureState>(&bytes) {
                if state.phase == phase {
                    return state;
                }
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!(
        "independent GUI fixture did not reach phase {phase}: {}",
        path.display()
    );
}

fn wait_for_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if path.is_file() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!(
        "GUI fixture coordination file was not created: {}",
        path.display()
    );
}

fn spawn_gui_fixture(config: &Path) -> Child {
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args(["--ignored", "--exact", "gui_client_fixture", "--nocapture"])
        .env(GUI_FIXTURE_CONFIG, config)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().unwrap()
}

fn assert_child_success(child: &mut Child, operation: &str) -> ExitStatus {
    let status = child
        .wait_timeout(Duration::from_secs(120))
        .unwrap()
        .unwrap_or_else(|| {
            let _ = child.kill();
            let _ = child.wait();
            panic!("{operation} timed out")
        });
    assert!(status.success(), "{operation} failed with {status}");
    status
}

fn force_kill_child(child: &mut Child, operation: &str) -> ExitStatus {
    child.kill().unwrap();
    let status = child
        .wait_timeout(COMMAND_TIMEOUT)
        .unwrap()
        .unwrap_or_else(|| panic!("{operation} did not terminate"));
    assert!(!status.success(), "{operation} unexpectedly exited cleanly");
    status
}

fn package_resources_root() -> PathBuf {
    PathBuf::from(env::var_os("RUNNER_TEMP").unwrap()).join("tabverse-resident-package-resources")
}

fn install_package_v2_during_live_runtimes() -> ExitStatus {
    let version = command_output(Command::new("node").arg("--version"), "node-version").unwrap();
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        "v22.23.2"
    );
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let script = repository.join("tools/prepare-resident-package-acceptance.mjs");
    let status = command_status_with_timeout(
        Command::new("node")
            .current_dir(&repository)
            .arg(&script)
            .args(["--phase", "v2", "--version", "0.0.2"]),
        "install-package-v2-with-live-runtimes",
        PACKAGE_COMMAND_TIMEOUT,
    )
    .unwrap();
    assert!(
        status.success(),
        "package-v2 installer failed with {status}"
    );
    status
}

fn assert_direct_worker_spawn_rejected(package: &PackageResources, root: &Path) -> bool {
    let descriptor: RuntimeDescriptor =
        serde_json::from_slice(&fs::read(package.root.join("terminal/descriptor.json")).unwrap())
            .unwrap();
    let endpoint = root.join("runtime-endpoints/direct-spawn-negative.json");
    let status = command_status(
        Command::new(package.root.join("terminal").join(descriptor.entrypoint))
            .args(["--resident-worker", "terminal"])
            .env("TABVERSE_RUNTIME_ID", "direct-spawn-negative")
            .env("TABVERSE_TAB_ID", "direct-spawn-negative")
            .env("TABVERSE_RUNTIME_GENERATION", "1")
            .env(
                "TABVERSE_RESIDENT_SUPERVISOR_PID",
                std::process::id().to_string(),
            )
            // Release workers do not compile the in-process test seam. A
            // caller cannot enable it by forging the debug-only variable.
            .env("TABVERSE_RESIDENT_IN_PROCESS_TEST_PARENT", "1")
            .env("TABVERSE_RESIDENT_ROOT", root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
        "direct-worker-spawn-negative",
    )
    .unwrap();
    assert!(!status.success(), "worker accepted a non-Supervisor parent");
    assert!(!endpoint.exists());
    true
}

fn endpoint_pid(root: &Path) -> Option<u32> {
    let value: Value =
        serde_json::from_slice(&fs::read(root.join("resident-endpoint.json")).ok()?).ok()?;
    value.get("pid")?.as_u64()?.try_into().ok()
}

fn endpoint_connects(root: &Path) -> bool {
    token(root).is_some_and(|token| {
        ResidentClient::connect(
            root,
            token,
            "platform-acceptance-probe",
            ProtocolRange::supervisor(),
        )
        .is_ok()
    })
}

fn wait_for_live_endpoint(root: &Path, previous_pid: Option<u32>) -> u32 {
    let deadline = Instant::now()
        + if cfg!(windows) {
            Duration::from_secs(100)
        } else {
            Duration::from_secs(30)
        };
    while Instant::now() < deadline {
        if let Some(pid) = endpoint_pid(root) {
            if Some(pid) != previous_pid && endpoint_connects(root) {
                return pid;
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    panic!("resident service did not publish a new live endpoint");
}

fn wait_for_disconnected_endpoint(root: &Path) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if !endpoint_connects(root) {
            return;
        }
        thread::sleep(Duration::from_millis(250));
    }
    panic!("resident service still accepts clients after deactivation");
}

fn wait_for_terminal_endpoint(root: &Path, runtime: &RuntimeRef) -> TerminalEndpoint {
    let path = root
        .join("runtime-endpoints")
        .join(format!("{}.json", runtime.runtime_id));
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(endpoint) = serde_json::from_slice::<TerminalEndpoint>(&bytes) {
                assert_eq!(endpoint.runtime_id, runtime.runtime_id);
                assert_eq!(endpoint.tab_id, runtime.tab_id);
                return endpoint;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("terminal runtime did not publish its endpoint");
}

fn assert_terminal_accepts(endpoint: &TerminalEndpoint) {
    let token: [u8; 32] = hex::decode(&endpoint.token_hex)
        .unwrap()
        .try_into()
        .unwrap();
    let (client, _, _) = HelperClient::connect(
        ([127, 0, 0, 1], endpoint.port).into(),
        TerminalAuthToken::new(token),
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
}

fn wait_for_remote_outputs(
    client: &ResidentClient,
    runtime: &RuntimeRef,
    expected: &[&str],
) -> Vec<tabverse_resident::EventRecord> {
    let expected: Vec<String> = expected.iter().map(|value| (*value).into()).collect();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let replay = client.poll(runtime.clone(), 0).unwrap();
        let outputs: Vec<String> = replay
            .events
            .iter()
            .filter(|event| event.payload["type"] == "output")
            .filter_map(|event| event.payload["b64"].as_str())
            .map(|value| {
                String::from_utf8(data_encoding::BASE64.decode(value.as_bytes()).unwrap()).unwrap()
            })
            .collect();
        if expected.iter().all(|value| outputs.contains(value)) {
            return replay.events;
        }
        assert!(
            Instant::now() < deadline,
            "resident Remote runtime did not journal expected outputs: {expected:?}; got {outputs:?}"
        );
        thread::sleep(Duration::from_millis(25));
    }
}

fn wait_for_worker_processes(supervisor_pid: u32) -> WorkerProcesses {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(processes) = worker_processes(supervisor_pid) {
            if let (Some(terminal_pid), Some(remote_pid)) = (
                processes
                    .iter()
                    .find(|(_, kind)| kind == "terminal")
                    .map(|(pid, _)| *pid),
                processes
                    .iter()
                    .find(|(_, kind)| kind == "remote")
                    .map(|(pid, _)| *pid),
            ) {
                assert_eq!(
                    processes.len(),
                    2,
                    "unexpected resident worker process: {processes:?}"
                );
                return WorkerProcesses {
                    terminal_pid,
                    remote_pid,
                };
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!("Supervisor {supervisor_pid} did not own Terminal and Remote worker children");
}

fn observe_processes(root: &Path) -> ProcessObservation {
    let supervisor_pid =
        endpoint_pid(root).expect("resident endpoint must expose a Supervisor pid");
    let workers = wait_for_worker_processes(supervisor_pid);
    ProcessObservation {
        supervisor_pid,
        terminal_worker_pid: workers.terminal_pid,
        remote_worker_pid: workers.remote_pid,
    }
}

fn fixture_processes(state: &GuiFixtureState) -> ProcessObservation {
    ProcessObservation {
        supervisor_pid: state.supervisor_pid,
        terminal_worker_pid: state.terminal_worker_pid,
        remote_worker_pid: state.remote_worker_pid,
    }
}

#[cfg(unix)]
fn worker_processes(supervisor_pid: u32) -> anyhow::Result<Vec<(u32, String)>> {
    let output = command_output(
        Command::new("ps").args(["-axo", "pid=,ppid=,command="]),
        "ps-worker-ownership",
    )?;
    anyhow::ensure!(output.status.success());
    let mut processes = vec![];
    for line in String::from_utf8(output.stdout)?.lines() {
        let mut fields = line.split_whitespace();
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(parent) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let command = fields.collect::<Vec<_>>().join(" ");
        if parent != supervisor_pid || !command.contains("--resident-worker") {
            continue;
        }
        for kind in ["terminal", "remote"] {
            if command.contains(&format!("--resident-worker {kind}")) {
                processes.push((pid, kind.into()));
            }
        }
    }
    Ok(processes)
}

#[cfg(windows)]
fn worker_processes(supervisor_pid: u32) -> anyhow::Result<Vec<(u32, String)>> {
    let query = format!(
        "$items = Get-CimInstance Win32_Process | Where-Object {{ $_.ParentProcessId -eq {supervisor_pid} -and $_.CommandLine -like '*--resident-worker*' }}; $items | ForEach-Object {{ Write-Output ($_.ProcessId.ToString() + \"`t\" + $_.CommandLine) }}"
    );
    let output = command_output(
        Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &query]),
        "powershell-worker-ownership",
    )?;
    anyhow::ensure!(output.status.success());
    let mut processes = vec![];
    for line in String::from_utf8(output.stdout)?.lines() {
        let Some((pid, command)) = line.trim().split_once('\t') else {
            continue;
        };
        let pid = pid.parse::<u32>()?;
        for kind in ["terminal", "remote"] {
            if command.contains(&format!("--resident-worker {kind}")) {
                processes.push((pid, kind.into()));
            }
        }
    }
    Ok(processes)
}

fn kill_process(pid: u32) {
    let success = if cfg!(windows) {
        command_status(
            Command::new("taskkill.exe").args(["/PID", &pid.to_string(), "/F"]),
            "taskkill",
        )
        .unwrap()
        .success()
    } else {
        command_status(Command::new("kill").args(["-9", &pid.to_string()]), "kill")
            .unwrap()
            .success()
    };
    assert!(success, "failed to kill resident pid {pid}");
}

fn command_status(command: &mut Command, operation: &str) -> anyhow::Result<ExitStatus> {
    command_status_with_timeout(command, operation, COMMAND_TIMEOUT)
}

fn command_status_with_timeout(
    command: &mut Command,
    operation: &str,
    timeout: Duration,
) -> anyhow::Result<ExitStatus> {
    let mut child = command.spawn()?;
    if let Some(status) = child.wait_timeout(timeout)? {
        return Ok(status);
    }
    let _ = child.kill();
    let _ = child.wait();
    anyhow::bail!("platform acceptance command timed out: {operation}")
}

fn command_output(command: &mut Command, operation: &str) -> anyhow::Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if child.wait_timeout(COMMAND_TIMEOUT)?.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        anyhow::bail!("platform acceptance command timed out: {operation}")
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_end(&mut stdout)?;
    }
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_end(&mut stderr)?;
    }
    let status = child.wait()?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(target_os = "linux")]
fn assert_running_from(pid: u32, expected: &Path) {
    let actual = fs::read_link(format!("/proc/{pid}/exe")).unwrap();
    assert_eq!(
        fs::canonicalize(actual).unwrap(),
        fs::canonicalize(expected).unwrap()
    );
}

#[cfg(target_os = "macos")]
fn assert_running_from(pid: u32, expected: &Path) {
    let output = command_output(
        Command::new("ps").args(["-ww", "-p", &pid.to_string(), "-o", "command="]),
        "ps-resident-path",
    )
    .unwrap();
    assert!(output.status.success());
    let command = String::from_utf8(output.stdout).unwrap();
    let expected = fs::canonicalize(expected).unwrap();
    assert!(
        command.trim().starts_with(&expected.to_string_lossy()[..]),
        "pid {pid} command did not start from {}: {command}",
        expected.display()
    );
}

#[cfg(target_os = "windows")]
fn assert_running_from(pid: u32, expected: &Path) {
    let query =
        format!("(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').ExecutablePath");
    let output = command_output(
        Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &query]),
        "powershell-resident-path",
    )
    .unwrap();
    assert!(output.status.success());
    let actual = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    assert_eq!(
        fs::canonicalize(actual).unwrap(),
        fs::canonicalize(expected).unwrap()
    );
}
