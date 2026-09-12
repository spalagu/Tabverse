//! GUI adapter for Supervisor-owned Agent LiveProcess sessions.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{channel, Sender},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tabverse_agent::{event::SessionEvent, log::SessionLog};
use tabverse_runtime::agent_ipc::{AgentIpcSender, AgentIpcStream, AuthToken, Frame, Kind};

use crate::agent_bridge::{log_path_for, AgentBroadcast, AgentEventCallback};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize)]
struct StartRequest<'a> {
    request_id: u64,
    session_id: &'a str,
    cwd: &'a str,
}

#[derive(Serialize)]
struct PromptRequest<'a> {
    request_id: u64,
    handle: &'a str,
    text: &'a str,
}

#[derive(Serialize)]
struct HandleRequest<'a> {
    request_id: u64,
    handle: &'a str,
}

#[derive(Serialize)]
struct AnswerRequest<'a> {
    request_id: u64,
    handle: &'a str,
    call_id: &'a str,
    allow: bool,
    reason: Option<&'a str>,
}

#[derive(Clone, Deserialize)]
struct Reply {
    request_id: u64,
    handle: Option<String>,
    answered: Option<bool>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct EventEnvelope {
    session_id: String,
    event: SessionEvent,
}

type ShareSlot = Arc<Mutex<Option<Arc<dyn AgentBroadcast>>>>;

#[derive(Clone)]
struct ClientSession {
    session_id: String,
    events: AgentEventCallback,
    share: ShareSlot,
    log_path: Option<PathBuf>,
}

struct Connection {
    sender: AgentIpcSender,
    waiting: Arc<Mutex<HashMap<u64, Sender<Reply>>>>,
    alive: Arc<AtomicBool>,
}

impl Connection {
    fn request(&self, frame: Frame, request_id: u64) -> Result<Reply> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(anyhow!("Agent Supervisor connection is closed"));
        }
        let (tx, rx) = channel();
        self.waiting.lock().unwrap().insert(request_id, tx);
        if let Err(error) = self.sender.send(&frame) {
            self.waiting.lock().unwrap().remove(&request_id);
            return Err(error.into());
        }
        let reply = match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(reply) => reply,
            Err(_) => {
                self.waiting.lock().unwrap().remove(&request_id);
                return Err(anyhow!(
                    "Agent Supervisor did not answer request {request_id}"
                ));
            }
        };
        if let Some(error) = reply.error.as_ref() {
            return Err(anyhow!(error.clone()));
        }
        Ok(reply)
    }
}

struct Inner {
    connection: Mutex<Option<Arc<Connection>>>,
    sessions: Arc<Mutex<HashMap<String, ClientSession>>>,
    next_request: AtomicU64,
}

#[derive(Clone)]
pub struct AgentClientRegistry {
    inner: Arc<Inner>,
}

impl Default for AgentClientRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentClientRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                connection: Mutex::new(None),
                sessions: Arc::new(Mutex::new(HashMap::new())),
                next_request: AtomicU64::new(1),
            }),
        }
    }

    pub fn connect(&self, endpoint: &str, token: AuthToken) -> Result<()> {
        if self
            .inner
            .connection
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|connection| connection.alive.load(Ordering::Acquire))
        {
            return Ok(());
        }
        let mut stream = AgentIpcStream::connect(endpoint, REQUEST_TIMEOUT)?;
        stream.set_read_timeout(Some(REQUEST_TIMEOUT))?;
        stream.authenticate_client(token, rand::random())?;
        let sender = stream.sender()?;
        stream.set_read_timeout(None)?;
        let waiting = Arc::new(Mutex::new(HashMap::<u64, Sender<Reply>>::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let connection = Arc::new(Connection {
            sender,
            waiting: Arc::clone(&waiting),
            alive: Arc::clone(&alive),
        });
        let sessions = Arc::clone(&self.inner.sessions);
        thread::Builder::new()
            .name("tabverse-agent-client".into())
            .spawn(move || read_frames(&mut stream, &sessions, &waiting, &alive))?;
        *self.inner.connection.lock().unwrap() = Some(connection);
        Ok(())
    }

    fn connection(&self) -> Result<Arc<Connection>> {
        self.inner
            .connection
            .lock()
            .unwrap()
            .as_ref()
            .filter(|connection| connection.alive.load(Ordering::Acquire))
            .cloned()
            .ok_or_else(|| anyhow!("Agent Supervisor is not connected"))
    }

    fn next_request(&self) -> u64 {
        self.inner.next_request.fetch_add(1, Ordering::Relaxed)
    }

    pub fn start(
        &self,
        session_id: String,
        cwd: String,
        log_dir: Option<PathBuf>,
        events: AgentEventCallback,
    ) -> Result<String> {
        let pending_key = format!("pending:{session_id}");
        let session = ClientSession {
            session_id: session_id.clone(),
            events,
            share: Arc::new(Mutex::new(None)),
            log_path: log_dir.as_ref().map(|dir| log_path_for(dir, &session_id)),
        };
        let previous = {
            let mut sessions = self.inner.sessions.lock().unwrap();
            let keys = sessions
                .iter()
                .filter(|(_, existing)| existing.session_id == session_id)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            let previous = keys
                .into_iter()
                .filter_map(|key| sessions.remove(&key).map(|value| (key, value)))
                .collect::<Vec<_>>();
            sessions.insert(pending_key.clone(), session.clone());
            previous
        };
        let result = (|| {
            let request_id = self.next_request();
            let frame = Frame::json(
                Kind::Start,
                &StartRequest {
                    request_id,
                    session_id: &session_id,
                    cwd: &cwd,
                },
            )?;
            self.connection()?.request(frame, request_id)
        })();
        let mut sessions = self.inner.sessions.lock().unwrap();
        sessions.remove(&pending_key);
        let reply = match result {
            Ok(reply) => reply,
            Err(error) => {
                sessions.extend(previous);
                return Err(error);
            }
        };
        let Some(handle) = reply.handle else {
            sessions.extend(previous);
            return Err(anyhow!("Agent Supervisor returned no session handle"));
        };
        sessions.insert(handle.clone(), session);
        Ok(handle)
    }

    pub fn prompt(&self, handle: &str, text: String) -> Result<()> {
        let request_id = self.next_request();
        let frame = Frame::json(
            Kind::Prompt,
            &PromptRequest {
                request_id,
                handle,
                text: &text,
            },
        )?;
        self.connection()?.request(frame, request_id)?;
        Ok(())
    }

    pub fn cancel(&self, handle: &str) -> Result<()> {
        self.handle_request(Kind::Cancel, handle)
    }

    fn handle_request(&self, kind: Kind, handle: &str) -> Result<()> {
        let request_id = self.next_request();
        let frame = Frame::json(kind, &HandleRequest { request_id, handle })?;
        self.connection()?.request(frame, request_id)?;
        Ok(())
    }

    pub fn answer(
        &self,
        handle: &str,
        call_id: &str,
        allow: bool,
        reason: Option<String>,
    ) -> Result<bool> {
        let request_id = self.next_request();
        let frame = Frame::json(
            Kind::Answer,
            &AnswerRequest {
                request_id,
                handle,
                call_id,
                allow,
                reason: reason.as_deref(),
            },
        )?;
        Ok(self
            .connection()?
            .request(frame, request_id)?
            .answered
            .unwrap_or(false))
    }

    pub fn close(&self, handle: &str) {
        let _ = self.handle_request(Kind::Close, handle);
        self.inner.sessions.lock().unwrap().remove(handle);
    }

    pub fn detach(&self, handle: &str) {
        let _ = self.handle_request(Kind::Detach, handle);
        self.inner.sessions.lock().unwrap().remove(handle);
    }

    pub fn handle_for_session(&self, session_id: &str) -> Option<String> {
        self.inner
            .sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(_, session)| session.session_id == session_id)
            .map(|(handle, _)| handle.clone())
    }

    pub fn agent_hooks(&self, handle: &str) -> Option<tabverse_remote::source::agent::AgentHooks> {
        let session = self.inner.sessions.lock().unwrap().get(handle)?.clone();
        let prompt_client = self.clone();
        let prompt_handle = handle.to_string();
        let answer_client = self.clone();
        let answer_handle = handle.to_string();
        let cancel_client = self.clone();
        let cancel_handle = handle.to_string();
        let log_path = session.log_path;
        let share = session.share;
        Some(tabverse_remote::source::agent::AgentHooks {
            prompt: Arc::new(move |text| {
                let _ = prompt_client.prompt(&prompt_handle, text.to_string());
            }),
            answer: Arc::new(move |call_id, allow, reason| {
                answer_client
                    .answer(&answer_handle, call_id, allow, reason)
                    .unwrap_or(false)
            }),
            cancel: Arc::new(move || {
                let _ = cancel_client.cancel(&cancel_handle);
            }),
            history: Arc::new(move || {
                log_path
                    .as_ref()
                    .map_or_else(Vec::new, |path| match SessionLog::replay(path) {
                        Ok(replay) => replay
                            .events
                            .iter()
                            .filter_map(|event| serde_json::to_value(event).ok())
                            .collect(),
                        Err(error) => {
                            eprintln!("[agent] cannot replay transcript for sharing: {error:#}");
                            vec![serde_json::to_value(
                                tabverse_agent::event::SessionEvent::TurnEnded {
                                    turn: 0,
                                    reason: tabverse_agent::event::StopReason::Error(format!(
                                        "Cannot read the current transcript: {error:#}"
                                    )),
                                },
                            )
                            .expect("the fixed transcript error event serializes")]
                        }
                    })
            }),
            set_broadcast: Arc::new(move |target| {
                *share.lock().unwrap() = target.map(|share| share as Arc<dyn AgentBroadcast>);
            }),
        })
    }
}

fn read_frames(
    stream: &mut AgentIpcStream,
    sessions: &Mutex<HashMap<String, ClientSession>>,
    waiting: &Mutex<HashMap<u64, Sender<Reply>>>,
    alive: &AtomicBool,
) {
    while let Ok(frame) = stream.recv() {
        match frame.kind {
            Kind::Event => {
                let Ok(envelope) = frame.decode_json::<EventEnvelope>() else {
                    continue;
                };
                let session = sessions
                    .lock()
                    .unwrap()
                    .values()
                    .find(|session| session.session_id == envelope.session_id)
                    .cloned();
                if let Some(session) = session {
                    if let Some(share) = session.share.lock().unwrap().as_ref() {
                        if let Ok(event) = serde_json::to_value(&envelope.event) {
                            share.agent_event(event);
                        }
                    }
                    (session.events)(envelope.event);
                }
            }
            Kind::Ack | Kind::Error => {
                let Ok(reply) = frame.decode_json::<Reply>() else {
                    continue;
                };
                if let Some(sender) = waiting.lock().unwrap().remove(&reply.request_id) {
                    let _ = sender.send(reply);
                }
            }
            _ => {}
        }
    }
    alive.store(false, Ordering::Release);
    let parked = std::mem::take(&mut *waiting.lock().unwrap());
    for (request_id, sender) in parked {
        let _ = sender.send(Reply {
            request_id,
            handle: None,
            answered: None,
            error: Some("Agent Supervisor connection closed".into()),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_supervisor::AgentSupervisor;

    struct Recorder {
        events: Arc<Mutex<Vec<SessionEvent>>>,
    }

    impl Recorder {
        fn callback() -> (Self, AgentEventCallback) {
            let events = Arc::new(Mutex::new(Vec::new()));
            let target = Arc::clone(&events);
            (
                Self { events },
                Arc::new(move |event| target.lock().unwrap().push(event)),
            )
        }

        fn wait_for_prompt(&self, text: &str) {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if self.events.lock().unwrap().iter().any(
                    |event| matches!(event, SessionEvent::UserPrompt { text: seen } if seen == text),
                ) {
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "timed out waiting for prompt {text:?}"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    #[test]
    fn failed_reattach_restores_the_existing_gui_session() {
        let client = AgentClientRegistry::new();
        let (_, original_callback) = Recorder::callback();
        client.inner.sessions.lock().unwrap().insert(
            "existing-handle".into(),
            ClientSession {
                session_id: "tab-existing".into(),
                events: original_callback,
                share: Arc::new(Mutex::new(None)),
                log_path: None,
            },
        );
        let (_, replacement_callback) = Recorder::callback();

        let error = client
            .start(
                "tab-existing".into(),
                ".".into(),
                None,
                replacement_callback,
            )
            .unwrap_err();

        assert!(error.to_string().contains("not connected"));
        assert_eq!(
            client.handle_for_session("tab-existing").as_deref(),
            Some("existing-handle")
        );
        assert!(!client
            .inner
            .sessions
            .lock()
            .unwrap()
            .contains_key("pending:tab-existing"));
    }

    #[test]
    fn a_new_gui_reattaches_the_same_supervisor_live_process() {
        let logs = tempfile::tempdir().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let _vault = crate::credentials::test_vault_guard(logs.path().to_path_buf());
        let token = AuthToken::new([0x29; 32]);
        let store = tabverse_runtime::RuntimeStore::open(runtime.path(), "agent-test").unwrap();
        let supervisor = AgentSupervisor::start_persistent(
            token,
            Some(logs.path().to_path_buf()),
            store.clone(),
            "agent-test".into(),
        )
        .unwrap();

        let first = AgentClientRegistry::new();
        first.connect(supervisor.endpoint(), token).unwrap();
        let error = first.prompt("missing-handle", "hello".into()).unwrap_err();
        assert!(error.to_string().contains("stale Agent client"));
        let (first_events, callback) = Recorder::callback();
        let first_handle = first
            .start(
                "tab-reattach".into(),
                work.path().display().to_string(),
                Some(logs.path().to_path_buf()),
                callback,
            )
            .unwrap();
        first.prompt(&first_handle, "persist me".into()).unwrap();
        first_events.wait_for_prompt("persist me");

        // A fresh registry stands in for a restarted GUI. Start is an attach
        // when the Supervisor already owns this tab id, so the handle and the
        // running provider loop both remain the same.
        let second = AgentClientRegistry::new();
        second.connect(supervisor.endpoint(), token).unwrap();
        let (second_events, callback) = Recorder::callback();
        let second_handle = second
            .start(
                "tab-reattach".into(),
                work.path().display().to_string(),
                Some(logs.path().to_path_buf()),
                callback,
            )
            .unwrap();
        assert_eq!(second_handle, first_handle);
        assert_eq!(store.get("tab-reattach").unwrap().unwrap().generation, 2);
        second_events.wait_for_prompt("persist me");
        let stale = first
            .prompt(&first_handle, "must not run".into())
            .unwrap_err();
        assert!(stale.to_string().contains("stale Agent client"));
        second.close(&second_handle);
        assert!(!(supervisor.keep_alive())());
    }
}
