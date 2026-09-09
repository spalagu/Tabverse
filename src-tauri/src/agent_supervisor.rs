//! Windowless Agent LiveProcess server hosted by the Runtime Supervisor.

use std::{
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tabverse_runtime::agent_ipc::{
    AgentIpcListener, AgentIpcSender, AgentIpcStream, AuthToken, Frame, Kind, TransportError,
};

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
    registry: Arc<AgentRegistry>,
    shutdown: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl AgentSupervisor {
    pub fn start(token: AuthToken, log_dir: Option<PathBuf>) -> io::Result<Self> {
        let endpoint = format!(
            "tabverse-agent-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        );
        let listener = AgentIpcListener::bind(&endpoint)?;
        let registry = Arc::new(AgentRegistry::new());
        let shutdown = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let thread_registry = Arc::clone(&registry);
        let thread_shutdown = Arc::clone(&shutdown);
        let thread_alive = Arc::clone(&alive);
        let thread = thread::Builder::new()
            .name("tabverse-agent-supervisor".into())
            .spawn(move || {
                while !thread_shutdown.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok(stream) => {
                            let registry = Arc::clone(&thread_registry);
                            let log_dir = log_dir.clone();
                            thread::Builder::new()
                                .name("tabverse-agent-supervisor-client".into())
                                .spawn(move || handle_client(stream, token, registry, log_dir))
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
            registry,
            shutdown,
            alive,
            thread: Some(thread),
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn keep_alive(&self) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let registry = Arc::clone(&self.registry);
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
    registry: Arc<AgentRegistry>,
    log_dir: Option<PathBuf>,
) {
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
        let result = dispatch(&registry, &sender, log_dir.clone(), frame);
        if let Err(error) = result {
            let _ = send_reply(&sender, Kind::Error, Reply::error(0, error));
        }
    }
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
    registry: &AgentRegistry,
    sender: &AgentIpcSender,
    log_dir: Option<PathBuf>,
    frame: Frame,
) -> anyhow::Result<()> {
    match frame.kind {
        Kind::Start => {
            let request: StartRequest = frame.decode_json()?;
            let events = event_callback(request.session_id.clone(), sender.clone());
            let handle = match registry.attach(&request.session_id, Arc::clone(&events)) {
                Some(handle) => handle,
                None => registry.start(request.session_id, request.cwd, log_dir, events)?,
            };
            let mut reply = Reply::ok(request.request_id);
            reply.handle = Some(handle);
            send_reply(sender, Kind::Ack, reply)?;
        }
        Kind::Prompt => {
            let request: PromptRequest = frame.decode_json()?;
            registry.prompt(&request.handle, request.text)?;
            send_reply(sender, Kind::Ack, Reply::ok(request.request_id))?;
        }
        Kind::Cancel => {
            let request: HandleRequest = frame.decode_json()?;
            registry.cancel(&request.handle)?;
            send_reply(sender, Kind::Ack, Reply::ok(request.request_id))?;
        }
        Kind::Answer => {
            let request: AnswerRequest = frame.decode_json()?;
            let answered = registry.answer(
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
            registry.close(&request.handle);
            send_reply(sender, Kind::Ack, Reply::ok(request.request_id))?;
        }
        other => anyhow::bail!("unexpected Agent request kind {other:?}"),
    }
    Ok(())
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
        let work = tempfile::tempdir().unwrap();
        let token = AuthToken::new([0x62; 32]);
        let supervisor = AgentSupervisor::start(token, Some(logs.path().to_path_buf())).unwrap();
        let mut client =
            AgentIpcStream::connect(supervisor.endpoint(), Duration::from_secs(2)).unwrap();
        client.authenticate_client(token, [0x72; 32]).unwrap();
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
    }
}
