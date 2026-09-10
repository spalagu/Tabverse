//! Windowless Agent LiveProcess server hosted by the Runtime Supervisor.

use std::{
    collections::{HashMap, HashSet},
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tabverse_runtime::agent_ipc::{
    AgentIpcListener, AgentIpcSender, AgentIpcStream, AuthToken, Frame, Kind, TransportError,
};
use tabverse_runtime::{RuntimeRecord, RuntimeStore};

use crate::agent_bridge::{AgentEventCallback, AgentRegistry};

const ACCEPT_POLL: Duration = Duration::from_millis(10);

#[derive(Deserialize)]
struct StartRequest {
    request_id: u64,
    session_id: String,
    cwd: String,
}

#[derive(Deserialize)]
struct PromptRequest {
    request_id: u64,
    handle: String,
    text: String,
}

#[derive(Deserialize)]
struct HandleRequest {
    request_id: u64,
    handle: String,
}

#[derive(Deserialize)]
struct AnswerRequest {
    request_id: u64,
    handle: String,
    call_id: String,
    allow: bool,
    reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Reply {
    request_id: u64,
    handle: Option<String>,
    answered: Option<bool>,
    error: Option<String>,
}

impl Reply {
    fn ok(request_id: u64) -> Self {
        Self {
            request_id,
            handle: None,
            answered: None,
            error: None,
        }
    }

    fn error(request_id: u64, error: impl ToString) -> Self {
        Self {
            request_id,
            handle: None,
            answered: None,
            error: Some(error.to_string()),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct EventEnvelope {
    session_id: String,
    event: tabverse_agent::event::SessionEvent,
}

pub struct AgentSupervisor {
    endpoint: String,
    state: Arc<SupervisorState>,
    shutdown: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

struct SupervisorState {
    registry: Arc<AgentRegistry>,
    owners: Mutex<HashMap<String, u64>>,
    store: RuntimeStore,
    host_instance: String,
}

impl AgentSupervisor {
    pub fn start_persistent(
        token: AuthToken,
        log_dir: Option<PathBuf>,
        store: RuntimeStore,
        host_instance: String,
    ) -> io::Result<Self> {
        Self::start_runtime(token, log_dir, store, host_instance)
    }

    fn start_runtime(
        token: AuthToken,
        log_dir: Option<PathBuf>,
        store: RuntimeStore,
        host_instance: String,
    ) -> io::Result<Self> {
        let endpoint = format!(
            "tabverse-agent-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        );
        let listener = AgentIpcListener::bind(&endpoint)?;
        let registry = Arc::new(AgentRegistry::new());
        let state = Arc::new(SupervisorState {
            registry,
            owners: Mutex::new(HashMap::new()),
            store,
            host_instance,
        });
        let shutdown = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let thread_state = Arc::clone(&state);
        let thread_shutdown = Arc::clone(&shutdown);
        let thread_alive = Arc::clone(&alive);
        let thread = thread::Builder::new()
            .name("tabverse-agent-supervisor".into())
            .spawn(move || {
                while !thread_shutdown.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok(stream) => {
                            let state = Arc::clone(&thread_state);
                            let log_dir = log_dir.clone();
                            thread::Builder::new()
                                .name("tabverse-agent-supervisor-client".into())
                                .spawn(move || handle_client(stream, token, state, log_dir))
                                .ok();
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                        Err(_) => break,
                    }
                    thread::sleep(ACCEPT_POLL);
                }
                thread_alive.store(false, Ordering::Release);
            })?;
        Ok(Self {
            endpoint,
            state,
            shutdown,
            alive,
            thread: Some(thread),
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn keep_alive(&self) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let registry = Arc::clone(&self.state.registry);
        Arc::new(move || !registry.is_empty())
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        // Nonblocking accept polls, so no synthetic unauthenticated connection
        // is needed to wake shutdown.
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.alive.store(false, Ordering::Release);
    }
}

impl Drop for AgentSupervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn handle_client(
    mut stream: AgentIpcStream,
    token: AuthToken,
    state: Arc<SupervisorState>,
    log_dir: Option<PathBuf>,
) {
    let client_id = rand::random::<u64>();
    let mut owned = HashSet::new();
    // Accepted sockets inherit the listener's nonblocking flag on macOS.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    if stream.authenticate_server(token, rand::random()).is_err() {
        return;
    }
    let Ok(sender) = stream.sender() else {
        return;
    };
    let _ = stream.set_read_timeout(None);
    loop {
        let frame = match stream.recv() {
            Ok(frame) => frame,
            Err(TransportError::Closed | TransportError::Io(_)) => break,
            Err(TransportError::Protocol(error)) => {
                let _ = send_reply(&sender, Kind::Error, Reply::error(0, error));
                break;
            }
        };
        let request_id = serde_json::from_slice::<serde_json::Value>(&frame.payload)
            .ok()
            .and_then(|value| value.get("request_id")?.as_u64())
            .unwrap_or(0);
        let result = dispatch(
            &state,
            client_id,
            &mut owned,
            &sender,
            log_dir.clone(),
            frame,
        );
        if let Err(error) = result {
            let _ = send_reply(&sender, Kind::Error, Reply::error(request_id, error));
        }
    }
    detach_owned(&state, client_id, owned);
}

fn event_callback(session_id: String, sender: AgentIpcSender) -> AgentEventCallback {
    Arc::new(move |event| {
        let envelope = EventEnvelope {
            session_id: session_id.clone(),
            event,
        };
        if let Ok(frame) = Frame::json(Kind::Event, &envelope) {
            let _ = sender.send(&frame);
        }
    })
}

fn dispatch(
    state: &SupervisorState,
    client_id: u64,
    owned: &mut HashSet<String>,
    sender: &AgentIpcSender,
    log_dir: Option<PathBuf>,
    frame: Frame,
) -> anyhow::Result<()> {
    match frame.kind {
        Kind::Start => {
            let request: StartRequest = frame.decode_json()?;
            let events = event_callback(request.session_id.clone(), sender.clone());
            let handle = match state
                .registry
                .attach(&request.session_id, Arc::clone(&events))
            {
                Some(handle) => handle,
                None => state.registry.start(
                    request.session_id.clone(),
                    request.cwd,
                    log_dir,
                    events,
                )?,
            };
            state
                .owners
                .lock()
                .unwrap()
                .insert(handle.clone(), client_id);
            owned.insert(handle.clone());
            set_runtime_state(state, &request.session_id, "attached", true)?;
            let mut reply = Reply::ok(request.request_id);
            reply.handle = Some(handle);
            send_reply(sender, Kind::Ack, reply)?;
        }
        Kind::Prompt => {
            let request: PromptRequest = frame.decode_json()?;
            ensure_owner(state, client_id, &request.handle)?;
            state.registry.prompt(&request.handle, request.text)?;
            send_reply(sender, Kind::Ack, Reply::ok(request.request_id))?;
        }
        Kind::Cancel => {
            let request: HandleRequest = frame.decode_json()?;
            ensure_owner(state, client_id, &request.handle)?;
            state.registry.cancel(&request.handle)?;
            send_reply(sender, Kind::Ack, Reply::ok(request.request_id))?;
        }
        Kind::Answer => {
            let request: AnswerRequest = frame.decode_json()?;
            ensure_owner(state, client_id, &request.handle)?;
            let answered = state.registry.answer(
                &request.handle,
                &request.call_id,
                request.allow,
                request.reason,
            )?;
            let mut reply = Reply::ok(request.request_id);
            reply.answered = Some(answered);
            send_reply(sender, Kind::Ack, reply)?;
        }
        Kind::Close => {
            let request: HandleRequest = frame.decode_json()?;
            ensure_owner(state, client_id, &request.handle)?;
            if let Some(session_id) = state.registry.session_id(&request.handle) {
                set_runtime_state(state, &session_id, "stopped", false)?;
            }
            state.registry.close(&request.handle);
            state.owners.lock().unwrap().remove(&request.handle);
            owned.remove(&request.handle);
            send_reply(sender, Kind::Ack, Reply::ok(request.request_id))?;
        }
        Kind::Detach => {
            let request: HandleRequest = frame.decode_json()?;
            ensure_owner(state, client_id, &request.handle)?;
            if let Some(session_id) = state.registry.session_id(&request.handle) {
                set_runtime_state(state, &session_id, "detached", false)?;
            }
            state.owners.lock().unwrap().remove(&request.handle);
            owned.remove(&request.handle);
            send_reply(sender, Kind::Ack, Reply::ok(request.request_id))?;
        }
        other => anyhow::bail!("unexpected Agent request kind {other:?}"),
    }
    Ok(())
}

fn ensure_owner(state: &SupervisorState, client_id: u64, handle: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        state.owners.lock().unwrap().get(handle) == Some(&client_id),
        "stale Agent client for session {handle}"
    );
    Ok(())
}

fn set_runtime_state(
    state: &SupervisorState,
    session_id: &str,
    runtime_state: &str,
    advance: bool,
) -> anyhow::Result<()> {
    let store = &state.store;
    let previous = store.get(session_id)?;
    let generation = match previous {
        Some(record) if advance => record.generation.saturating_add(1),
        Some(record) => record.generation,
        None => 1,
    };
    store.put(&RuntimeRecord {
        id: session_id.to_string(),
        kind: "agent".into(),
        generation,
        state: runtime_state.into(),
        host_instance: state.host_instance.clone(),
        checkpoint_json: None,
    })?;
    Ok(())
}

fn detach_owned(state: &SupervisorState, client_id: u64, owned: HashSet<String>) {
    for handle in owned {
        let still_owned = state.owners.lock().unwrap().get(&handle) == Some(&client_id);
        if !still_owned {
            continue;
        }
        state.owners.lock().unwrap().remove(&handle);
        if let Some(session_id) = state.registry.session_id(&handle) {
            let _ = set_runtime_state(state, &session_id, "detached", false);
        }
    }
}

fn send_reply(sender: &AgentIpcSender, kind: Kind, reply: Reply) -> anyhow::Result<()> {
    sender.send(&Frame::json(kind, &reply)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn receive_until(stream: &mut AgentIpcStream, ready: impl Fn(&Frame) -> bool) -> Frame {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for Agent frame"
            );
            let frame = stream.recv().unwrap();
            if ready(&frame) {
                return frame;
            }
        }
    }

    #[test]
    fn supervisor_owns_a_live_session_and_accepts_semantic_commands() {
        let logs = tempfile::tempdir().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let token = AuthToken::new(rand::random());
        let store = RuntimeStore::open(runtime.path(), "test-supervisor").unwrap();
        let supervisor = AgentSupervisor::start_persistent(
            token,
            Some(logs.path().to_path_buf()),
            store.clone(),
            "test-supervisor".into(),
        )
        .unwrap();
        let mut client =
            AgentIpcStream::connect(supervisor.endpoint(), Duration::from_secs(2)).unwrap();
        client.authenticate_client(token, rand::random()).unwrap();
        client
            .send(
                &Frame::json(
                    Kind::Start,
                    &serde_json::json!({
                        "request_id": 1,
                        "session_id": "agent-tab-1",
                        "cwd": work.path(),
                    }),
                )
                .unwrap(),
            )
            .unwrap();
        let reply: Reply = receive_until(&mut client, |frame| frame.kind == Kind::Ack)
            .decode_json()
            .unwrap();
        let handle = reply.handle.unwrap();
        assert!((supervisor.keep_alive())());
        assert_eq!(store.get("agent-tab-1").unwrap().unwrap().state, "attached");

        client
            .send(
                &Frame::json(
                    Kind::Prompt,
                    &serde_json::json!({
                        "request_id": 2,
                        "handle": handle,
                        "text": "hello",
                    }),
                )
                .unwrap(),
            )
            .unwrap();
        let event = receive_until(&mut client, |frame| {
            frame.kind == Kind::Event
                && frame.decode_json::<EventEnvelope>().is_ok_and(|event| {
                    matches!(
                        event.event,
                        tabverse_agent::event::SessionEvent::UserPrompt { .. }
                    )
                })
        });
        let event: EventEnvelope = event.decode_json().unwrap();
        assert_eq!(event.session_id, "agent-tab-1");
        assert!(supervisor.is_alive());
        client
            .send(
                &Frame::json(
                    Kind::Close,
                    &serde_json::json!({"request_id": 3, "handle": handle}),
                )
                .unwrap(),
            )
            .unwrap();
        receive_until(&mut client, |frame| frame.kind == Kind::Ack);
        assert_eq!(store.get("agent-tab-1").unwrap().unwrap().state, "stopped");
    }
}
