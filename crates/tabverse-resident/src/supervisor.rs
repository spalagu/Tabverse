use crate::{
    store::{CreationJournal, PersistedState, RequestOutcome, RuntimeRecord},
    AttachReplay, EventRecord, ProtocolRange, ResidentStore, RuntimeDescriptor, RuntimeRef,
    RuntimeStatus,
};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{mpsc::Receiver, Arc, Mutex},
    thread::JoinHandle,
};

pub trait SignatureVerifier: Send + Sync + 'static {
    fn verify(&self, descriptor: &RuntimeDescriptor, digest: &[u8]) -> Result<()>;
}

pub struct ArtifactVerifier {
    signature: Arc<dyn SignatureVerifier>,
}

impl ArtifactVerifier {
    pub fn new(signature: Arc<dyn SignatureVerifier>) -> Self {
        Self { signature }
    }

    fn verify(&self, descriptor: &RuntimeDescriptor, source: &Path) -> Result<()> {
        let bytes = fs::read(source)
            .with_context(|| format!("read resident artifact {}", source.display()))?;
        let digest = Sha256::digest(bytes);
        if hex::encode(digest) != descriptor.artifact_hash.to_ascii_lowercase() {
            bail!("resident-artifact-hash-mismatch")
        }
        if descriptor.signature.is_empty() {
            bail!("resident-signature-missing")
        }
        self.signature
            .verify(descriptor, digest.as_ref())
            .map_err(|_| anyhow!("resident-signature-invalid"))
    }
}

#[derive(Debug, Clone)]
pub struct WorkerContext {
    pub runtime: RuntimeRef,
    pub descriptor: RuntimeDescriptor,
    pub entrypoint: PathBuf,
    pub resident_root: PathBuf,
    pub initial_checkpoint: Value,
}

pub trait RunningWorker: Send + Sync + 'static {
    fn send(&self, payload: &[u8]) -> Result<()>;
    fn terminate(&self) -> Result<()>;
    fn is_alive(&self) -> bool;
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkerOutput {
    Event { payload: Value },
    Checkpoint { seq: u64, checkpoint: Value },
    Exited,
}

pub struct SpawnedWorker {
    pub worker: Arc<dyn RunningWorker>,
    pub output: Receiver<WorkerOutput>,
}

pub trait WorkerFactory: Send + Sync + 'static {
    fn spawn(&self, context: WorkerContext) -> Result<SpawnedWorker>;
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureRuntime {
    pub tab_id: String,
    pub kind: String,
    pub descriptor: RuntimeDescriptor,
    pub artifact_source: PathBuf,
    pub expected_catalog_revision: u64,
    pub request_id: String,
    pub initial_checkpoint: Value,
}

pub struct Supervisor {
    store: Arc<ResidentStore>,
    verifier: ArtifactVerifier,
    factory: Arc<dyn WorkerFactory>,
    state: Arc<Mutex<PersistedState>>,
    workers: Mutex<BTreeMap<String, Arc<dyn RunningWorker>>>,
    output_threads: Mutex<BTreeMap<String, JoinHandle<()>>>,
    lifecycle: Mutex<()>,
}

impl Supervisor {
    pub fn open(
        root: impl Into<PathBuf>,
        verifier: ArtifactVerifier,
        factory: Arc<dyn WorkerFactory>,
    ) -> Result<Self> {
        let store = Arc::new(ResidentStore::open(root)?);
        let mut state = store.load()?;
        let mut changed = false;
        if let Some(journal) = state.creation_journal.take() {
            state.requests.insert(
                journal.request_id,
                RequestOutcome::Failed {
                    code: "resident-create-interrupted".into(),
                },
            );
            changed = true;
        }
        // Taking the owner lock means the old supervisor no longer exists.
        // We cannot honestly claim its process handles survived; preserve the
        // runtime/checkpoint/slot and expose an explicit interrupted state.
        for runtime in state.runtimes.values_mut() {
            if runtime.status == RuntimeStatus::Running {
                runtime.status = RuntimeStatus::Interrupted;
                changed = true;
            }
        }
        if changed {
            store.commit(&state)?;
        }
        Ok(Self {
            store,
            verifier,
            factory,
            state: Arc::new(Mutex::new(state)),
            workers: Mutex::new(BTreeMap::new()),
            output_threads: Mutex::new(BTreeMap::new()),
            lifecycle: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        self.store.root()
    }

    pub fn catalog_revision(&self) -> u64 {
        self.state.lock().unwrap().catalog_revision
    }

    pub fn set_catalog_revision(&self, expected: u64, next: u64) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        if state.catalog_revision != expected || next <= expected {
            bail!("resident-catalog-revision-conflict")
        }
        state.catalog_revision = next;
        self.store.commit(&state)
    }

    pub fn sync_catalog_revision(&self, next: u64) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        if next < state.catalog_revision {
            bail!("resident-catalog-revision-conflict")
        }
        if next == state.catalog_revision {
            return Ok(());
        }
        state.catalog_revision = next;
        self.store.commit(&state)
    }

    /// The only creation entrypoint. The GUI supplies a declaration and an
    /// idempotency key; this owner verifies, installs, journals and invokes the
    /// worker factory from inside the supervisor process.
    pub fn ensure_runtime(&self, request: EnsureRuntime) -> Result<RuntimeRef> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let revision_conflict = {
            let state = self.state.lock().unwrap();
            if let Some(outcome) = state.requests.get(&request.request_id) {
                return outcome_result(outcome);
            }
            state.catalog_revision != request.expected_catalog_revision
        };
        if revision_conflict {
            return self.fail_creation(&request.request_id, "resident-catalog-revision-conflict");
        }
        let prepared = (|| {
            request
                .descriptor
                .protocol_range
                .negotiate(ProtocolRange::supervisor())
                .ok_or_else(|| anyhow!("resident-worker-protocol-incompatible"))?;
            self.verifier
                .verify(&request.descriptor, &request.artifact_source)?;
            self.store
                .install_artifact(&request.descriptor, &request.artifact_source)
        })();
        let (artifact_slot, entrypoint) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                let code = stable_error_code(&error);
                return self.fail_creation(&request.request_id, &code);
            }
        };

        let mut state = self.state.lock().unwrap();
        let owner_key = runtime_owner_key(&request.tab_id, &request.kind);
        if let Some(runtime_id) = state.tab_runtimes.get(&owner_key) {
            let existing = state
                .runtimes
                .get(runtime_id)
                .ok_or_else(|| anyhow!("resident-registry-inconsistent"))?;
            if existing.status == RuntimeStatus::Running
                && existing.descriptor == request.descriptor
            {
                let reference = existing.reference.clone();
                state.requests.insert(
                    request.request_id,
                    RequestOutcome::Created {
                        runtime: reference.clone(),
                    },
                );
                self.store.commit(&state)?;
                return Ok(reference);
            }
            drop(state);
            return self.fail_creation(&request.request_id, "resident-tab-runtime-conflict");
        }

        let reference = RuntimeRef {
            runtime_id: uuid::Uuid::new_v4().to_string(),
            tab_id: request.tab_id.clone(),
            kind: request.kind,
            generation: 1,
            plugin_version: request.descriptor.plugin_version.clone(),
            artifact_slot: artifact_slot.clone(),
            lease_id: uuid::Uuid::new_v4().to_string(),
        };
        state.creation_journal = Some(CreationJournal {
            request_id: request.request_id.clone(),
            runtime_id: reference.runtime_id.clone(),
            tab_id: reference.tab_id.clone(),
            artifact_slot,
            phase: "prepared".into(),
        });
        self.store.commit(&state)?;
        drop(state);

        let spawned = match self.factory.spawn(WorkerContext {
            runtime: reference.clone(),
            descriptor: request.descriptor.clone(),
            entrypoint,
            resident_root: self.root().to_path_buf(),
            initial_checkpoint: request.initial_checkpoint.clone(),
        }) {
            Ok(spawned) if spawned.worker.is_alive() => spawned,
            Ok(spawned) => {
                let _ = spawned.worker.terminate();
                return self.fail_creation(&request.request_id, "resident-worker-not-alive");
            }
            Err(_) => {
                return self.fail_creation(&request.request_id, "resident-worker-spawn-failed")
            }
        };

        let mut state = self.state.lock().unwrap();
        let record = RuntimeRecord {
            reference: reference.clone(),
            descriptor: request.descriptor,
            status: RuntimeStatus::Running,
            checkpoint_seq: 0,
            checkpoint: request.initial_checkpoint,
            last_event_seq: 0,
            events: Vec::new(),
            last_ack_seq: 0,
        };
        state
            .tab_runtimes
            .insert(owner_key, reference.runtime_id.clone());
        state.runtimes.insert(reference.runtime_id.clone(), record);
        state.requests.insert(
            request.request_id,
            RequestOutcome::Created {
                runtime: reference.clone(),
            },
        );
        state.creation_journal = None;
        if let Err(error) = self.store.commit(&state) {
            let _ = spawned.worker.terminate();
            state.runtimes.remove(&reference.runtime_id);
            state
                .tab_runtimes
                .remove(&runtime_owner_key(&reference.tab_id, &reference.kind));
            return Err(error.context("commit resident creation"));
        }
        self.workers
            .lock()
            .unwrap()
            .insert(reference.runtime_id.clone(), spawned.worker);
        self.start_output_pump(reference.runtime_id.clone(), spawned.output);
        Ok(reference)
    }

    fn start_output_pump(&self, runtime_id: String, output: Receiver<WorkerOutput>) {
        let state = self.state.clone();
        let store = self.store.clone();
        let endpoint = self.runtime_endpoint_path(&runtime_id);
        let thread_runtime_id = runtime_id.clone();
        let thread = std::thread::Builder::new()
            .name(format!("tabverse-resident-output-{runtime_id}"))
            .spawn(move || {
                while let Ok(message) = output.recv() {
                    let mut state = state.lock().unwrap();
                    let Some(record) = state.runtimes.get_mut(&thread_runtime_id) else {
                        break;
                    };
                    match message {
                        WorkerOutput::Event { payload }
                            if record.status == RuntimeStatus::Running =>
                        {
                            record.last_event_seq = record.last_event_seq.saturating_add(1);
                            record.events.push(EventRecord {
                                seq: record.last_event_seq,
                                payload,
                            });
                            ResidentStore::trim_events(record);
                        }
                        WorkerOutput::Checkpoint { seq, checkpoint }
                            if record.status == RuntimeStatus::Running
                                && seq >= record.checkpoint_seq
                                && seq <= record.last_event_seq =>
                        {
                            record.checkpoint_seq = seq;
                            record.checkpoint = checkpoint;
                            record.events.retain(|event| event.seq > seq);
                        }
                        WorkerOutput::Exited => {
                            if record.status == RuntimeStatus::Running {
                                record.status = RuntimeStatus::Interrupted;
                            }
                            let _ = store.commit(&state);
                            let _ = fs::remove_file(&endpoint);
                            break;
                        }
                        _ => continue,
                    }
                    if store.commit(&state).is_err() {
                        break;
                    }
                }
            })
            .expect("spawn resident worker output pump");
        self.output_threads
            .lock()
            .unwrap()
            .insert(runtime_id, thread);
    }

    fn fail_creation<T>(&self, request_id: &str, code: &str) -> Result<T> {
        let mut state = self.state.lock().unwrap();
        state.creation_journal = None;
        state.requests.insert(
            request_id.to_string(),
            RequestOutcome::Failed {
                code: code.to_string(),
            },
        );
        self.store.commit(&state)?;
        bail!(code.to_string())
    }

    pub fn list(&self) -> Vec<(RuntimeRef, RuntimeStatus)> {
        self.state
            .lock()
            .unwrap()
            .runtimes
            .values()
            .map(|record| (record.reference.clone(), record.status))
            .collect()
    }

    pub fn attach(&self, runtime_id: &str, last_ack_seq: u64) -> Result<AttachReplay> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        let record = state
            .runtimes
            .get_mut(runtime_id)
            .ok_or_else(|| anyhow!("resident-runtime-not-found"))?;
        if record.status != RuntimeStatus::Running {
            bail!("resident-runtime-not-running")
        }
        record.reference.generation = record.reference.generation.saturating_add(1);
        record.reference.lease_id = uuid::Uuid::new_v4().to_string();
        record.last_ack_seq = last_ack_seq.min(record.last_event_seq);
        let replay_after = record.last_ack_seq.max(record.checkpoint_seq);
        let replay = AttachReplay {
            runtime: record.reference.clone(),
            checkpoint_seq: record.checkpoint_seq,
            checkpoint: record.checkpoint.clone(),
            events: record
                .events
                .iter()
                .filter(|event| event.seq > replay_after)
                .cloned()
                .collect(),
        };
        self.store.commit(&state)?;
        Ok(replay)
    }

    pub fn ack(&self, reference: &RuntimeRef, seq: u64) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let record = checked_record_mut(&mut state, reference)?;
        if seq > record.last_event_seq {
            bail!("resident-ack-out-of-range")
        }
        record.last_ack_seq = record.last_ack_seq.max(seq);
        self.store.commit(&state)
    }

    /// Read new worker output without rotating the GUI lease. Attach is a
    /// takeover boundary; polling is ordinary traffic on the current lease.
    pub fn poll(&self, reference: &RuntimeRef, last_ack_seq: u64) -> Result<AttachReplay> {
        let mut state = self.state.lock().unwrap();
        let record = checked_record_mut(&mut state, reference)?;
        if last_ack_seq > record.last_event_seq {
            bail!("resident-ack-out-of-range")
        }
        record.last_ack_seq = record.last_ack_seq.max(last_ack_seq);
        let replay_after = last_ack_seq.max(record.checkpoint_seq);
        let replay = AttachReplay {
            runtime: record.reference.clone(),
            checkpoint_seq: record.checkpoint_seq,
            checkpoint: record.checkpoint.clone(),
            events: record
                .events
                .iter()
                .filter(|event| event.seq > replay_after)
                .cloned()
                .collect(),
        };
        self.store.commit(&state)?;
        Ok(replay)
    }

    pub fn detach(&self, reference: &RuntimeRef) -> Result<RuntimeRef> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        let record = checked_record_mut(&mut state, reference)?;
        record.reference.generation = record.reference.generation.saturating_add(1);
        record.reference.lease_id.clear();
        let detached = record.reference.clone();
        self.store.commit(&state)?;
        Ok(detached)
    }

    pub fn send_intent(&self, reference: &RuntimeRef, payload: &[u8]) -> Result<()> {
        {
            let mut state = self.state.lock().unwrap();
            checked_record_mut(&mut state, reference)?;
        }
        let worker = self
            .workers
            .lock()
            .unwrap()
            .get(&reference.runtime_id)
            .cloned()
            .ok_or_else(|| anyhow!("resident-worker-not-owned"))?;
        worker.send(payload)
    }

    pub fn record_event(&self, runtime_id: &str, payload: Value) -> Result<EventRecord> {
        let mut state = self.state.lock().unwrap();
        let record = state
            .runtimes
            .get_mut(runtime_id)
            .ok_or_else(|| anyhow!("resident-runtime-not-found"))?;
        if record.status != RuntimeStatus::Running {
            bail!("resident-runtime-not-running")
        }
        record.last_event_seq = record.last_event_seq.saturating_add(1);
        let event = EventRecord {
            seq: record.last_event_seq,
            payload,
        };
        record.events.push(event.clone());
        ResidentStore::trim_events(record);
        self.store.commit(&state)?;
        Ok(event)
    }

    pub fn checkpoint(&self, runtime_id: &str, seq: u64, checkpoint: Value) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let record = state
            .runtimes
            .get_mut(runtime_id)
            .ok_or_else(|| anyhow!("resident-runtime-not-found"))?;
        if seq < record.checkpoint_seq || seq > record.last_event_seq {
            bail!("resident-checkpoint-sequence-invalid")
        }
        record.checkpoint_seq = seq;
        record.checkpoint = checkpoint;
        record.events.retain(|event| event.seq > seq);
        self.store.commit(&state)
    }

    pub fn stop(&self, reference: &RuntimeRef) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        {
            let mut state = self.state.lock().unwrap();
            checked_record_mut(&mut state, reference)?;
        }
        let worker = self
            .workers
            .lock()
            .unwrap()
            .remove(&reference.runtime_id)
            .ok_or_else(|| anyhow!("resident-worker-not-owned"))?;
        let owner_key = {
            let mut state = self.state.lock().unwrap();
            let record = checked_record_mut(&mut state, reference)?;
            record.status = RuntimeStatus::Stopped;
            let owner_key = runtime_owner_key(&record.reference.tab_id, &record.reference.kind);
            state.tab_runtimes.remove(&owner_key);
            self.store.commit(&state)?;
            owner_key
        };
        let terminate = worker.terminate();
        if let Some(thread) = self
            .output_threads
            .lock()
            .unwrap()
            .remove(&reference.runtime_id)
        {
            let _ = thread.join();
        }
        if let Err(error) = terminate {
            let mut state = self.state.lock().unwrap();
            if let Some(record) = state.runtimes.get_mut(&reference.runtime_id) {
                record.status = RuntimeStatus::Interrupted;
            }
            state
                .tab_runtimes
                .insert(owner_key, reference.runtime_id.clone());
            self.store.commit(&state)?;
            return Err(error.context("terminate resident worker"));
        }
        let _ = fs::remove_file(self.runtime_endpoint_path(&reference.runtime_id));
        Ok(())
    }

    fn runtime_endpoint_path(&self, runtime_id: &str) -> PathBuf {
        self.root()
            .join("runtime-endpoints")
            .join(format!("{runtime_id}.json"))
    }

    pub fn active_slots(&self) -> BTreeMap<String, usize> {
        let mut slots = BTreeMap::new();
        for record in self.state.lock().unwrap().runtimes.values() {
            if matches!(
                record.status,
                RuntimeStatus::Running | RuntimeStatus::Interrupted
            ) {
                *slots
                    .entry(record.reference.artifact_slot.clone())
                    .or_default() += 1;
            }
        }
        slots
    }
}

fn runtime_owner_key(tab_id: &str, kind: &str) -> String {
    format!("{tab_id}\0{kind}")
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        for worker in self.workers.lock().unwrap().values() {
            let _ = worker.terminate();
        }
        self.workers.lock().unwrap().clear();
        let threads = std::mem::take(&mut *self.output_threads.lock().unwrap());
        for (_, thread) in threads {
            let _ = thread.join();
        }
    }
}

fn checked_record_mut<'a>(
    state: &'a mut PersistedState,
    reference: &RuntimeRef,
) -> Result<&'a mut RuntimeRecord> {
    let record = state
        .runtimes
        .get_mut(&reference.runtime_id)
        .ok_or_else(|| anyhow!("resident-runtime-not-found"))?;
    if record.status != RuntimeStatus::Running {
        bail!("resident-runtime-not-running")
    }
    if record.reference.tab_id != reference.tab_id
        || record.reference.generation != reference.generation
        || record.reference.lease_id != reference.lease_id
    {
        bail!("resident-stale-generation-or-lease")
    }
    Ok(record)
}

fn outcome_result(outcome: &RequestOutcome) -> Result<RuntimeRef> {
    match outcome {
        RequestOutcome::Created { runtime } => Ok(runtime.clone()),
        RequestOutcome::Failed { code } => bail!(code.clone()),
    }
}

fn stable_error_code(error: &anyhow::Error) -> String {
    let text = error.to_string();
    text.split(':')
        .next()
        .filter(|code| code.starts_with("resident-"))
        .unwrap_or("resident-artifact-invalid")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct FixtureSignature;
    impl SignatureVerifier for FixtureSignature {
        fn verify(&self, descriptor: &RuntimeDescriptor, digest: &[u8]) -> Result<()> {
            let expected = format!("fixture:{}", hex::encode(digest));
            (descriptor.signature == expected)
                .then_some(())
                .ok_or_else(|| anyhow!("bad fixture signature"))
        }
    }

    struct Worker {
        alive: AtomicBool,
        sends: Arc<AtomicUsize>,
    }
    impl RunningWorker for Worker {
        fn send(&self, _payload: &[u8]) -> Result<()> {
            if !self.is_alive() {
                bail!("dead")
            }
            self.sends.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn terminate(&self) -> Result<()> {
            self.alive.store(false, Ordering::SeqCst);
            Ok(())
        }
        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }
    }

    struct Factory {
        spawns: Arc<AtomicUsize>,
        sends: Arc<AtomicUsize>,
        fail: bool,
    }

    struct OutputFactory {
        receiver: Mutex<Option<Receiver<WorkerOutput>>>,
        sends: Arc<AtomicUsize>,
    }
    impl WorkerFactory for OutputFactory {
        fn spawn(&self, _context: WorkerContext) -> Result<SpawnedWorker> {
            Ok(SpawnedWorker {
                worker: Arc::new(Worker {
                    alive: AtomicBool::new(true),
                    sends: self.sends.clone(),
                }),
                output: self
                    .receiver
                    .lock()
                    .unwrap()
                    .take()
                    .ok_or_else(|| anyhow!("fixture output already consumed"))?,
            })
        }
    }
    impl WorkerFactory for Factory {
        fn spawn(&self, _context: WorkerContext) -> Result<SpawnedWorker> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                bail!("fixture spawn failure")
            }
            let (_output, receiver) = std::sync::mpsc::channel();
            Ok(SpawnedWorker {
                worker: Arc::new(Worker {
                    alive: AtomicBool::new(true),
                    sends: self.sends.clone(),
                }),
                output: receiver,
            })
        }
    }

    fn fixture(
        root: &Path,
        fail: bool,
    ) -> (Supervisor, PathBuf, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let artifact = root.join("fixture-worker");
        fs::write(&artifact, b"fixture-worker-v1").unwrap();
        let spawns = Arc::new(AtomicUsize::new(0));
        let sends = Arc::new(AtomicUsize::new(0));
        let supervisor = Supervisor::open(
            root.join("resident"),
            ArtifactVerifier::new(Arc::new(FixtureSignature)),
            Arc::new(Factory {
                spawns: spawns.clone(),
                sends: sends.clone(),
                fail,
            }),
        )
        .unwrap();
        (supervisor, artifact, spawns, sends)
    }

    fn request(artifact: &Path, request_id: &str) -> EnsureRuntime {
        let hash = hex::encode(Sha256::digest(b"fixture-worker-v1"));
        EnsureRuntime {
            tab_id: "tab-1".into(),
            kind: "fixture".into(),
            descriptor: RuntimeDescriptor {
                plugin_id: "tabverse.fixture".into(),
                plugin_version: "1.0.0".into(),
                artifact_hash: hash.clone(),
                entrypoint: "worker".into(),
                permissions: vec![crate::CapabilityRequest {
                    capability: "fixture.echo".into(),
                    reason: "exercise the resident protocol".into(),
                    optional: false,
                }],
                protocol_range: ProtocolRange::supervisor(),
                signature: format!("fixture:{hash}"),
            },
            artifact_source: artifact.into(),
            expected_catalog_revision: 0,
            request_id: request_id.into(),
            initial_checkpoint: serde_json::json!({"value": 0}),
        }
    }

    #[test]
    fn ensure_is_single_writer_idempotent_and_installs_an_immutable_slot() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, artifact, spawns, _) = fixture(dir.path(), false);
        let first = supervisor
            .ensure_runtime(request(&artifact, "request-1"))
            .unwrap();
        let replay = supervisor
            .ensure_runtime(request(&artifact, "request-1"))
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(supervisor.active_slots().values().sum::<usize>(), 1);
        assert!(supervisor
            .root()
            .join("slots")
            .join("tabverse.fixture@1.0.0")
            .join(&request(&artifact, "unused").descriptor.artifact_hash)
            .join("worker")
            .exists());
    }

    #[test]
    fn one_tab_may_own_distinct_primary_and_task_runtimes() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, artifact, spawns, _) = fixture(dir.path(), false);
        let primary = supervisor
            .ensure_runtime(request(&artifact, "primary"))
            .unwrap();
        let mut task_request = request(&artifact, "network-task");
        task_request.kind = "browser-network".into();
        let task = supervisor.ensure_runtime(task_request).unwrap();
        assert_ne!(primary.runtime_id, task.runtime_id);
        assert_eq!(primary.tab_id, task.tab_id);
        assert_eq!(spawns.load(Ordering::SeqCst), 2);
        supervisor.stop(&primary).unwrap();
        supervisor.stop(&task).unwrap();
    }

    #[test]
    fn catalog_sync_is_monotonic_and_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, _, _, _) = fixture(dir.path(), false);
        supervisor.sync_catalog_revision(3).unwrap();
        supervisor.sync_catalog_revision(3).unwrap();
        assert_eq!(supervisor.catalog_revision(), 3);
        assert_eq!(
            supervisor.sync_catalog_revision(2).unwrap_err().to_string(),
            "resident-catalog-revision-conflict"
        );
    }

    #[test]
    fn failed_spawn_is_persistently_idempotent_and_leaves_no_runtime_owner() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, artifact, spawns, _) = fixture(dir.path(), true);
        for _ in 0..2 {
            assert_eq!(
                supervisor
                    .ensure_runtime(request(&artifact, "request-fail"))
                    .unwrap_err()
                    .to_string(),
                "resident-worker-spawn-failed"
            );
        }
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert!(supervisor.list().is_empty());
        assert!(supervisor.state.lock().unwrap().creation_journal.is_none());
    }

    #[test]
    fn opening_after_a_prepared_creation_journal_records_one_stable_failure() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, artifact, _, _) = fixture(dir.path(), false);
        {
            let mut state = supervisor.state.lock().unwrap();
            state.creation_journal = Some(CreationJournal {
                request_id: "interrupted-request".into(),
                runtime_id: "uncommitted-runtime".into(),
                tab_id: "tab-1".into(),
                artifact_slot: "tabverse.fixture@1.0.0/hash".into(),
                phase: "prepared".into(),
            });
            supervisor.store.commit(&state).unwrap();
        }
        drop(supervisor);

        let spawns = Arc::new(AtomicUsize::new(0));
        let reopened = Supervisor::open(
            dir.path().join("resident"),
            ArtifactVerifier::new(Arc::new(FixtureSignature)),
            Arc::new(Factory {
                spawns: spawns.clone(),
                sends: Arc::new(AtomicUsize::new(0)),
                fail: false,
            }),
        )
        .unwrap();
        assert_eq!(
            reopened
                .ensure_runtime(request(&artifact, "interrupted-request"))
                .unwrap_err()
                .to_string(),
            "resident-create-interrupted"
        );
        assert_eq!(spawns.load(Ordering::SeqCst), 0);
        assert!(reopened.state.lock().unwrap().creation_journal.is_none());
    }

    #[test]
    fn attach_replays_ordered_events_once_and_old_generation_cannot_mutate() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, artifact, _, sends) = fixture(dir.path(), false);
        let first = supervisor
            .ensure_runtime(request(&artifact, "request-1"))
            .unwrap();
        let one = supervisor
            .record_event(&first.runtime_id, serde_json::json!({"n": 1}))
            .unwrap();
        let two = supervisor
            .record_event(&first.runtime_id, serde_json::json!({"n": 2}))
            .unwrap();
        assert_eq!((one.seq, two.seq), (1, 2));
        supervisor
            .checkpoint(&first.runtime_id, 1, serde_json::json!({"n": 1}))
            .unwrap();
        let attached = supervisor.attach(&first.runtime_id, 0).unwrap();
        assert_eq!(attached.checkpoint_seq, 1);
        assert_eq!(
            attached
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            [2]
        );
        assert!(supervisor.send_intent(&first, b"stale").is_err());
        supervisor
            .send_intent(&attached.runtime, b"current")
            .unwrap();
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        let polled = supervisor.poll(&attached.runtime, 1).unwrap();
        assert_eq!(polled.runtime.generation, attached.runtime.generation);
        assert_eq!(
            polled
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            [2]
        );
        supervisor.ack(&attached.runtime, 2).unwrap();
        let next = supervisor.attach(&first.runtime_id, 2).unwrap();
        assert!(next.events.is_empty());
        assert!(supervisor.stop(&attached.runtime).is_err());
        supervisor.stop(&next.runtime).unwrap();
    }

    #[test]
    fn worker_output_is_journaled_and_exit_becomes_interrupted_without_a_gui() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = dir.path().join("fixture-worker");
        fs::write(&artifact, b"fixture-worker-v1").unwrap();
        let (output, receiver) = std::sync::mpsc::channel();
        let supervisor = Supervisor::open(
            dir.path().join("resident"),
            ArtifactVerifier::new(Arc::new(FixtureSignature)),
            Arc::new(OutputFactory {
                receiver: Mutex::new(Some(receiver)),
                sends: Arc::new(AtomicUsize::new(0)),
            }),
        )
        .unwrap();
        let runtime = supervisor
            .ensure_runtime(request(&artifact, "worker-output"))
            .unwrap();
        output
            .send(WorkerOutput::Event {
                payload: serde_json::json!({"n": 1}),
            })
            .unwrap();
        output
            .send(WorkerOutput::Event {
                payload: serde_json::json!({"n": 2}),
            })
            .unwrap();
        output
            .send(WorkerOutput::Checkpoint {
                seq: 1,
                checkpoint: serde_json::json!({"n": 1}),
            })
            .unwrap();
        for _ in 0..1_000 {
            if supervisor
                .state
                .lock()
                .unwrap()
                .runtimes
                .get(&runtime.runtime_id)
                .is_some_and(|record| record.checkpoint_seq == 1)
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let replay = supervisor.attach(&runtime.runtime_id, 0).unwrap();
        assert_eq!(replay.checkpoint, serde_json::json!({"n": 1}));
        assert_eq!(
            replay.events,
            vec![EventRecord {
                seq: 2,
                payload: serde_json::json!({"n": 2}),
            }]
        );

        output.send(WorkerOutput::Exited).unwrap();
        for _ in 0..1_000 {
            if supervisor.list()[0].1 == RuntimeStatus::Interrupted {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(supervisor.list()[0].1, RuntimeStatus::Interrupted);
    }

    #[test]
    fn app_replacement_only_rotates_the_gui_lease_not_runtime_or_slot() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, artifact, spawns, _) = fixture(dir.path(), false);
        let created = supervisor
            .ensure_runtime(request(&artifact, "old-app"))
            .unwrap();
        let detached = supervisor.detach(&created).unwrap();
        assert_eq!(detached.runtime_id, created.runtime_id);
        assert_eq!(detached.artifact_slot, created.artifact_slot);
        let new_app = supervisor.attach(&created.runtime_id, 0).unwrap().runtime;
        assert_eq!(new_app.runtime_id, created.runtime_id);
        assert_eq!(new_app.artifact_slot, created.artifact_slot);
        assert!(new_app.generation > detached.generation);
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert!(supervisor.send_intent(&created, b"old-app").is_err());
        supervisor.stop(&new_app).unwrap();
    }

    #[test]
    fn signature_catalog_and_worker_protocol_are_checked_before_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let (supervisor, artifact, spawns, _) = fixture(dir.path(), false);
        let mut bad_signature = request(&artifact, "bad-signature");
        bad_signature.descriptor.signature = "not-valid".into();
        assert!(supervisor.ensure_runtime(bad_signature).is_err());
        assert_eq!(
            supervisor
                .ensure_runtime(request(&artifact, "bad-signature"))
                .unwrap_err()
                .to_string(),
            "resident-signature-invalid"
        );
        let mut bad_revision = request(&artifact, "bad-revision");
        bad_revision.expected_catalog_revision = 9;
        assert!(supervisor.ensure_runtime(bad_revision).is_err());
        let mut future = request(&artifact, "future");
        future.descriptor.protocol_range = ProtocolRange { min: 3, max: 3 };
        assert!(supervisor.ensure_runtime(future).is_err());
        assert_eq!(spawns.load(Ordering::SeqCst), 0);
    }
}
