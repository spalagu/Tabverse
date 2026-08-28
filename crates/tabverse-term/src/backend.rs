//! Helper-owned terminal sessions, independent of any GUI connection.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use anyhow::{anyhow, Result};

use crate::{
    protocol::SessionId,
    replay::{AttachBatch, ReplayRing},
    SessionManager, SpawnOpts,
};

type OutputCallback = Arc<dyn Fn(&[u8]) + Send + Sync + 'static>;
type ExitCallback = Arc<dyn Fn(Option<u32>) + Send + Sync + 'static>;

#[derive(Clone)]
pub struct SessionSink {
    pub on_output: OutputCallback,
    pub on_exit: ExitCallback,
}

impl SessionSink {
    pub fn new(
        on_output: impl Fn(&[u8]) + Send + Sync + 'static,
        on_exit: impl Fn(Option<u32>) + Send + Sync + 'static,
    ) -> Self {
        Self {
            on_output: Arc::new(on_output),
            on_exit: Arc::new(on_exit),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeta {
    pub id: SessionId,
    pub generation: u64,
    pub cwd: Option<String>,
    pub exited: Option<Option<u32>>,
    pub attached: bool,
}

struct RuntimeState {
    replay: ReplayRing,
    sink: Option<SessionSink>,
    exited: Option<Option<u32>>,
}

struct RuntimeSession {
    internal_id: String,
    cwd: Option<String>,
    generation: AtomicU64,
    state: Arc<Mutex<RuntimeState>>,
}

pub struct HelperRuntime {
    terms: Arc<SessionManager>,
    sessions: Arc<Mutex<HashMap<SessionId, Arc<RuntimeSession>>>>,
    /// Serializes spawn/terminate/kill-all ownership changes across clients.
    lifecycle: Mutex<()>,
}

impl Default for HelperRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl HelperRuntime {
    pub fn new() -> Self {
        Self {
            terms: Arc::new(SessionManager::new()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            lifecycle: Mutex::new(()),
        }
    }

    /// Spawn in the helper and attach the creating GUI as generation one.
    pub fn spawn(&self, opts: SpawnOpts, sink: SessionSink) -> Result<SessionId> {
        self.spawn_with_sink(opts, |_| sink)
    }

    /// Build the initial sink after the public session id exists. Network
    /// clients need that id in every Output/Exit frame, including output a
    /// shell may produce immediately after spawn.
    pub fn spawn_with_sink(
        &self,
        opts: SpawnOpts,
        sink_for: impl FnOnce(SessionId) -> SessionSink,
    ) -> Result<SessionId> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let id = SessionId(*uuid::Uuid::new_v4().as_bytes());
        let sink = sink_for(id);
        let cwd = opts.cwd.clone();
        let state = Arc::new(Mutex::new(RuntimeState {
            replay: ReplayRing::default(),
            sink: Some(sink),
            exited: None,
        }));
        let data_state = Arc::clone(&state);
        let exit_state = Arc::clone(&state);
        let exit_sessions = Arc::clone(&self.sessions);
        let exit_id = id;
        let internal_id = self.terms.create(
            opts,
            Arc::new(move |bytes| {
                let sink = {
                    let mut state = data_state.lock().unwrap();
                    state.replay.push(bytes);
                    state.sink.clone()
                };
                if let Some(sink) = sink {
                    (sink.on_output)(bytes);
                }
            }),
            Arc::new(move |code| {
                let sink = {
                    let mut state = exit_state.lock().unwrap();
                    state.exited = Some(code);
                    state.sink.clone()
                };
                if let Some(sink) = sink {
                    (sink.on_exit)(code);
                }
                exit_sessions.lock().unwrap().remove(&exit_id);
            }),
        )?;
        self.sessions.lock().unwrap().insert(
            id,
            Arc::new(RuntimeSession {
                internal_id,
                cwd,
                generation: AtomicU64::new(1),
                state: Arc::clone(&state),
            }),
        );
        // A command may exit before create() returns and before the row above
        // is visible to its callback. Do not reinsert an already-dead session.
        if state.lock().unwrap().exited.is_some() {
            self.sessions.lock().unwrap().remove(&id);
        }
        Ok(id)
    }

    pub fn write(&self, id: SessionId, generation: u64, data: &[u8]) -> Result<()> {
        let session = self.session(id)?;
        self.check_generation(&session, generation)?;
        if session.state.lock().unwrap().sink.is_none() {
            return Err(anyhow!("session is detached"));
        }
        self.terms.write(&session.internal_id, data)
    }

    pub fn resize(&self, id: SessionId, generation: u64, cols: u16, rows: u16) -> Result<()> {
        let session = self.session(id)?;
        self.check_generation(&session, generation)?;
        if session.state.lock().unwrap().sink.is_none() {
            return Err(anyhow!("session is detached"));
        }
        self.terms.resize(&session.internal_id, cols, rows)
    }

    pub fn detach(&self, id: SessionId, generation: u64) -> Result<u64> {
        let session = self.session(id)?;
        self.check_generation(&session, generation)?;
        session.state.lock().unwrap().sink = None;
        Ok(session.generation.fetch_add(1, Ordering::AcqRel) + 1)
    }

    pub fn begin_attach(&self, id: SessionId) -> Result<u64> {
        let session = self.session(id)?;
        let mut state = session.state.lock().unwrap();
        // Reserve replay before advancing generation. A competing attach that
        // loses this reservation must not invalidate the winner.
        state.replay.begin_attach()?;
        state.sink = None;
        Ok(session.generation.fetch_add(1, Ordering::AcqRel) + 1)
    }

    /// Send the frozen snapshot and attach delta while holding the session
    /// state lock, then expose the live sink. Output callbacks block on the
    /// same lock, so no live byte can overtake replay or fall into a gap.
    pub fn complete_attach(
        &self,
        id: SessionId,
        generation: u64,
        sink: SessionSink,
        deliver_replay: impl FnOnce(&AttachBatch) -> Result<()>,
    ) -> Result<AttachBatch> {
        let session = self.session(id)?;
        self.check_generation(&session, generation)?;
        let mut state = session.state.lock().unwrap();
        let batch = state.replay.finish_attach()?;
        deliver_replay(&batch)?;
        state.sink = Some(sink);
        Ok(batch)
    }

    pub fn terminate(&self, id: SessionId, generation: u64) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let session = self.session(id)?;
        self.check_generation(&session, generation)?;
        self.sessions.lock().unwrap().remove(&id);
        self.terms.kill(&session.internal_id)
    }

    pub fn kill_all(&self) {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let sessions: Vec<Arc<RuntimeSession>> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in sessions {
            let _ = self.terms.kill(&session.internal_id);
        }
    }

    pub fn list(&self) -> Vec<SessionMeta> {
        let sessions = self.sessions.lock().unwrap();
        let mut listed: Vec<SessionMeta> = sessions
            .iter()
            .map(|(id, session)| {
                let state = session.state.lock().unwrap();
                SessionMeta {
                    id: *id,
                    generation: session.generation.load(Ordering::Acquire),
                    cwd: session.cwd.clone(),
                    exited: state.exited,
                    attached: state.sink.is_some(),
                }
            })
            .collect();
        listed.sort_by_key(|meta| meta.id.0);
        listed
    }

    pub fn replay_snapshot(&self, id: SessionId) -> Result<Vec<u8>> {
        let session = self.session(id)?;
        let snapshot = session.state.lock().unwrap().replay.snapshot();
        Ok(snapshot)
    }

    fn session(&self, id: SessionId) -> Result<Arc<RuntimeSession>> {
        self.sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown helper session {id:?}"))
    }

    fn check_generation(&self, session: &RuntimeSession, received: u64) -> Result<()> {
        let expected = session.generation.load(Ordering::Acquire);
        if received != expected {
            return Err(anyhow!(
                "stale helper session generation: expected {expected}, received {received}"
            ));
        }
        Ok(())
    }
}

impl Drop for HelperRuntime {
    fn drop(&mut self) {
        self.kill_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread, time::Duration};

    fn sink() -> (SessionSink, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel();
        (
            SessionSink::new(
                move |bytes| {
                    let _ = tx.send(bytes.to_vec());
                },
                |_| {},
            ),
            rx,
        )
    }

    fn wait_for(rx: &mpsc::Receiver<Vec<u8>>, needle: &[u8]) {
        let mut seen = Vec::new();
        for _ in 0..30 {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                seen.extend_from_slice(&chunk);
                if seen.windows(needle.len()).any(|window| window == needle) {
                    return;
                }
            }
        }
        panic!(
            "terminal output never contained {:?}",
            String::from_utf8_lossy(needle)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_helper_owned_shell_keeps_running_while_no_gui_is_attached() {
        let runtime = HelperRuntime::new();
        let (first_sink, first_output) = sink();
        let id = runtime
            .spawn(
                SpawnOpts {
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                    shell_integration: false,
                    ..Default::default()
                },
                first_sink,
            )
            .unwrap();
        runtime.write(id, 1, b"printf 'BEFORE\\n'\n").unwrap();
        wait_for(&first_output, b"BEFORE");
        runtime
            .write(id, 1, b"sleep 0.1; printf 'DETACHED\\n'\n")
            .unwrap();
        // The shell owns this delayed work before the GUI leaves. Its output
        // must enter the helper replay ring while no sink exists.
        let detached_generation = runtime.detach(id, 1).unwrap();
        assert!(runtime
            .write(id, detached_generation, b"echo forbidden\n")
            .is_err());
        thread::sleep(Duration::from_millis(300));

        let attach_generation = runtime.begin_attach(id).unwrap();
        let (second_sink, second_output) = sink();
        let batch = runtime
            .complete_attach(id, attach_generation, second_sink, |_| Ok(()))
            .unwrap();
        let mut replayed = batch.snapshot;
        replayed.extend(batch.delta);
        assert!(
            replayed
                .windows(b"DETACHED".len())
                .any(|w| w == b"DETACHED"),
            "detached output must be replayed"
        );
        runtime
            .write(id, attach_generation, b"printf 'LIVE\\n'\n")
            .unwrap();
        wait_for(&second_output, b"LIVE");
        runtime.terminate(id, attach_generation).unwrap();
        assert!(runtime.list().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn stale_generation_cannot_write_or_detach() {
        let runtime = HelperRuntime::new();
        let (sink, _) = sink();
        let id = runtime
            .spawn(
                SpawnOpts {
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                    shell_integration: false,
                    ..Default::default()
                },
                sink,
            )
            .unwrap();
        let current = runtime.detach(id, 1).unwrap();
        assert!(runtime.detach(id, 1).is_err());
        assert!(runtime.write(id, 1, b"stale").is_err());
        assert_eq!(runtime.list()[0].generation, current);
        assert!(runtime.terminate(id, 1).is_err());
        runtime.terminate(id, current).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_losing_attach_does_not_invalidate_the_winner() {
        let runtime = HelperRuntime::new();
        let (first_sink, _) = sink();
        let id = runtime
            .spawn(
                SpawnOpts {
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                    shell_integration: false,
                    ..Default::default()
                },
                first_sink,
            )
            .unwrap();
        let detached = runtime.detach(id, 1).unwrap();
        let winner = runtime.begin_attach(id).unwrap();
        assert!(runtime.begin_attach(id).is_err());
        assert_eq!(runtime.list()[0].generation, winner);
        let (sink, _) = sink();
        runtime
            .complete_attach(id, winner, sink, |_| Ok(()))
            .unwrap();
        runtime.terminate(id, winner).unwrap();
        assert!(winner > detached);
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_exits_on_its_own_releases_the_helper_row() {
        let runtime = HelperRuntime::new();
        let (sink, _) = sink();
        runtime
            .spawn(
                SpawnOpts {
                    shell: Some("/bin/sh".into()),
                    cols: 80,
                    rows: 24,
                    shell_integration: false,
                    run_on_start: Some("exit".into()),
                    ..Default::default()
                },
                sink,
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !runtime.list().is_empty() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            runtime.list().is_empty(),
            "exited sessions must not pin helper idle"
        );
    }
}
