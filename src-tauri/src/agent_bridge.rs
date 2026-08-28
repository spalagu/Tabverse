//! Wiring the agent runtime to the webview.
//!
//! One session per agent tab, each on its own thread, because the turn loop is
//! blocking by nature: a tool that runs a build genuinely takes minutes, and an
//! approval genuinely waits for a person. Putting that on a Tauri command's
//! thread would stall the whole IPC surface.
//!
//! The approval gate is the interesting piece. `ApprovalGate::request` blocks —
//! it must, since returning early would mean running the tool before anyone
//! answered — but the answer arrives from the webview as a separate command.
//! So a request parks a one-shot sender under its call id and waits; the reply
//! command looks the id up and hands the decision over. A request nobody answers
//! times out into a refusal, never into permission.

use anyhow::{anyhow, Result};
use tabverse_agent::codex::provider::CodexProvider;
use tabverse_agent::event::{EventSink, SessionEvent};
use tabverse_agent::log::SessionLog;
use tabverse_agent::memory::{MemoryStore, MemoryTool};
use tabverse_agent::permission::{AllowReadOnly, ApprovalGate, Decision};
use tabverse_agent::provider::DemoProvider;

/// The model an agent tab talks to.
///
/// A constant for now: it is not a per-tab choice, and inventing a setting
/// before anybody has asked for one adds a thing to keep working.
const CODEX_MODEL: &str = "gpt-5.5";
use serde_json::Value;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tabverse_agent::session::Session;
use tabverse_agent_tools::{builtin_tools, env::LocalEnv, CancelToken};
use tauri::ipc::Channel;

/// How long an approval request waits before it is treated as refused. Long
/// enough that a user who stepped away can come back to it, short enough that a
/// forgotten tab does not hold a thread forever.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Forwards session events to the webview and, in the same call, to the log.
///
/// One sink rather than two call sites: an event that reaches the screen but
/// not the disk would come back missing after a restart, and the bug would only
/// show up much later. Writing them together makes that divergence impossible.
/// The screen half is a closure rather than the `Channel` itself, because a
/// `Channel` cannot be built without a running webview and the prompt loop below
/// has rules worth testing on their own.
/// Where a session's events go besides the screen and the log.
///
/// A trait rather than the `Share` itself: the sink needs one verb, and naming
/// only that verb is what lets a test watch the broadcast happen without
/// standing up a network.
pub trait AgentBroadcast: Send + Sync {
    fn agent_event(&self, event: serde_json::Value);
}

impl AgentBroadcast for tabverse_remote::Share {
    fn agent_event(&self, event: serde_json::Value) {
        self.broadcast_agent_event(event);
    }
}

/// The slot a session's broadcast target lives in while it is being shared.
type ShareSlot = Arc<Mutex<Option<Arc<dyn AgentBroadcast>>>>;

struct TeeSink {
    forward: Box<dyn FnMut(SessionEvent) + Send>,
    log: Option<SessionLog>,
    /// Set while this session is being shared. Held behind a lock the sharing
    /// command also holds, so a share that starts mid-run is picked up on the
    /// very next event rather than at the next turn.
    share: ShareSlot,
}

impl EventSink for TeeSink {
    fn emit(&mut self, event: SessionEvent) {
        if let Some(log) = self.log.as_mut() {
            // A log that cannot be written must not take the session down with
            // it — the user would rather keep working than lose the turn.
            let _ = log.append_event(&event);
        }
        // Three destinations, one call site. An event that reached the screen
        // but not the disk would come back missing after a restart; one that
        // reached the screen but not the viewers would leave them quietly
        // behind. Neither divergence is possible if they are written together.
        if let Some(share) = self.share.lock().unwrap().as_ref() {
            if let Ok(json) = serde_json::to_value(&event) {
                share.agent_event(json);
            }
        }
        // A closed channel means the tab went away; the session is being torn
        // down anyway, so dropping the event is the correct response.
        (self.forward)(event);
    }
}

/// Answer prompts until the tab goes away.
///
/// The rearm is the point of the function. Stop is about the turn in front of
/// the user: leaving the token set would make every later prompt end before it
/// began, which reads on screen as a tab that has silently died. Rearming here —
/// after a prompt has arrived, before the turn starts — is the one moment when
/// "nothing is running" is certainly true.
///
/// The loop ends when the sender is dropped, which is what closing the tab does.
/// Cancellation deliberately does not end it.
fn pump_prompts(
    session: &mut Session<'_>,
    sink: &mut TeeSink,
    prompts: &Receiver<String>,
    cancel: &CancelToken,
    resumed: usize,
) {
    // Messages already on disk must not be written again; append-only means
    // tracking how far we have got.
    let mut written = resumed;
    while let Ok(text) = prompts.recv() {
        cancel.reset();
        let _ = session.prompt(&text, sink);
        if let Some(log) = sink.log.as_mut() {
            written = session.append_new_messages(log, written).unwrap_or(written);
        }
    }
}

/// Where a session's log lives. One file per tab, named by the tab's own id so
/// reopening the same tab finds the same history.
pub fn log_path_for(dir: &std::path::Path, session_id: &str) -> std::path::PathBuf {
    // The id comes from the webview; keep it to characters that cannot escape
    // the directory or surprise a filesystem.
    let safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    dir.join("agent-sessions").join(format!("{safe}.jsonl"))
}

/// Stop whatever a session is doing.
///
/// Both halves, always. Setting the token alone leaves a turn that is parked
/// on an approval waiting for an answer that is no longer coming — the exact
/// defect fixed once for the local stop button and then reintroduced by a
/// second stop path that only did half the job. One function so there is only
/// one thing to get right.
fn stop_session(cancel: &CancelToken, gate: &UiGate) {
    cancel.cancel();
    gate.release_all();
}

/// Where an agent's long-term memory for a given folder lives.
///
/// Per folder rather than one file for everything: "this project builds with
/// X" is true of a project, and mixing several projects' facts together would
/// put wrong answers in front of the model in all but one of them.
///
/// The name keeps a readable tail so the file can be found by hand, plus a hash
/// of the whole path so two folders with the same name stay apart.
pub fn memory_path_for(dir: &std::path::Path, cwd: &str) -> std::path::PathBuf {
    let mut segments: Vec<&str> = cwd.rsplit('/').filter(|s| !s.is_empty()).take(2).collect();
    // rsplit hands them back innermost first; a name reads better the way the
    // path does.
    segments.reverse();
    let tail: String = segments
        .join("-")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(60)
        .collect();
    dir.join("agent-memory")
        .join(format!("{tail}-{:08x}.jsonl", fnv1a(cwd)))
}

/// FNV-1a. A hash, not a cryptographic one: the only requirement is that two
/// different paths rarely collide, and it avoids a dependency for eight bytes.
fn fnv1a(text: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in text.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// The approval gate backed by the UI.
pub struct UiGate {
    waiting: Mutex<HashMap<String, Sender<Decision>>>,
    timeout: Duration,
}

impl UiGate {
    fn new() -> Self {
        Self::with_timeout(APPROVAL_TIMEOUT)
    }

    /// Tests use a short one; nothing else should.
    fn with_timeout(timeout: Duration) -> Self {
        Self {
            waiting: Mutex::new(HashMap::new()),
            timeout,
        }
    }

    /// Called by the reply command. Returns false when nothing was waiting on
    /// this id — a stale click, or an approval that already timed out.
    fn answer(&self, call_id: &str, decision: Decision) -> bool {
        let sender = self.waiting.lock().unwrap().remove(call_id);
        match sender {
            Some(tx) => tx.send(decision).is_ok(),
            None => false,
        }
    }

    /// Refuse everything still parked. Used when the tab closes so no thread is
    /// left blocked on an answer that can no longer arrive.
    fn release_all(&self) {
        for (_, tx) in self.waiting.lock().unwrap().drain() {
            let _ = tx.send(Decision::Deny("the session was closed".to_string()));
        }
    }
}

impl ApprovalGate for UiGate {
    fn request(&self, call_id: &str, _tool_name: &str, _input: &Value) -> Decision {
        let (tx, rx) = channel();
        self.waiting.lock().unwrap().insert(call_id.to_string(), tx);
        // The PermissionRequested event has already gone to the webview from the
        // loop, so the UI is showing the prompt by the time we block here.
        match rx.recv_timeout(self.timeout) {
            Ok(decision) => decision,
            Err(_) => {
                self.waiting.lock().unwrap().remove(call_id);
                Decision::Deny("no answer within the approval timeout".to_string())
            }
        }
    }
}

struct SessionHandle {
    /// The tab's own id this session runs for — the reverse of the map key
    /// (the handle id), and what the app-level share routes by: its active
    // tab names the session a viewer's prompt is for.
    session_id: String,
    prompts: Sender<String>,
    cancel: CancelToken,
    gate: Arc<UiGate>,
    /// The share this session is being broadcast to, if any. Shared with the
    /// sink so attaching one takes effect immediately.
    share: ShareSlot,
    /// Where this session's events are written, which is also where a viewer's
    /// catch-up is read from.
    log_path: Option<std::path::PathBuf>,
}

#[derive(Default)]
pub struct AgentRegistry {
    sessions: Mutex<HashMap<String, SessionHandle>>,
    counter: Mutex<u64>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_id(&self) -> String {
        let mut counter = self.counter.lock().unwrap();
        *counter += 1;
        format!("agent-{counter}")
    }

    /// Start a session for a tab and return its handle id.
    ///
    /// `session_id` is the tab's own id, which is what makes a reopened tab find
    /// its history. When a log for it already exists, its events are replayed to
    /// the webview before anything new happens, and its messages become the
    /// conversation the model continues from.
    pub fn start(
        &self,
        session_id: String,
        cwd: String,
        log_dir: Option<std::path::PathBuf>,
        events: Channel<SessionEvent>,
    ) -> Result<String> {
        let id = self.next_id();
        let log_path = log_dir.as_ref().map(|dir| log_path_for(dir, &session_id));
        let memory_path = log_dir.as_ref().map(|dir| memory_path_for(dir, &cwd));

        let mut history = Vec::new();
        if let Some(path) = log_path.as_ref() {
            if let Ok(replay) = SessionLog::replay(path) {
                // Replay to the screen first: the tab should look the way it did
                // before it was closed, not empty until the next turn.
                for event in &replay.events {
                    let _ = events.send(event.clone());
                }
                history = replay.messages;
            }
        }
        let (prompt_tx, prompt_rx): (Sender<String>, Receiver<String>) = channel();
        let gate = Arc::new(UiGate::new());
        let cancel = CancelToken::new();
        let share_slot: ShareSlot = Arc::new(Mutex::new(None));

        let cache_session_id = session_id.clone();
        let thread_gate = Arc::clone(&gate);
        let thread_share = Arc::clone(&share_slot);
        let thread_cancel = cancel.clone();
        let thread_log = log_path.clone();
        std::thread::Builder::new()
            .name(format!("tabverse-{id}"))
            .spawn(move || {
                let env = LocalEnv::new(cwd);
                // A folder with no state directory still runs; it simply
                // remembers nothing, which beats refusing to start.
                let memory = memory_path.map(|p| std::sync::Arc::new(MemoryStore::open(p)));
                let mut tools = builtin_tools();
                if let Some(store) = &memory {
                    tools.push(Box::new(MemoryTool::new(std::sync::Arc::clone(store))));
                }
                let preamble = memory.as_ref().and_then(|s| s.preamble());
                // Codex when there is a sign-in, the scripted provider when
                // there is not.
                //
                // The fallback is deliberate rather than a leftover: without it
                // a user with no ChatGPT subscription could not open an agent
                // tab at all, and every other part of this — tools, approvals,
                // compaction, sharing — would become unreachable for them too.
                // Which one is in use is not announced here; the interface asks
                // agent_login_status and says so itself, in one place.
                // The sign-in is looked up first, and the HTTP client is only
                // built when there is one. Building it unconditionally would
                // mean a tab with no subscription still has to have a working
                // TLS stack to open — which is exactly what it does not need.
                let tokens = crate::agent_http::token_source().ok();
                let transport = tokens
                    .as_ref()
                    .and_then(|_| crate::agent_http::ReqwestTransport::new().ok());
                let demo = DemoProvider::new();
                let sockets = crate::agent_http::TokioWsTransport;
                let codex;
                let provider: &dyn tabverse_agent::provider::Provider =
                    match (transport.as_ref(), tokens.as_ref()) {
                        (Some(transport), Some(tokens)) => {
                            codex = CodexProvider::new(transport, tokens, CODEX_MODEL)
                                // The tab's own id, which is what makes the
                                // provider's prompt_cache_key stable across
                                // turns and what a pooled socket is keyed on.
                                // Without it the cache discipline built into
                                // the request builder never reaches the wire.
                                .with_options(tabverse_agent::codex::request::RequestOptions {
                                    session_id: Some(cache_session_id.clone()),
                                    ..Default::default()
                                })
                                .with_sockets(&sockets);
                            &codex
                        }
                        _ => &demo,
                    };
                let policy = AllowReadOnly;
                let resumed = history.len();
                let mut session =
                    Session::new(provider, tools, &policy, thread_gate.as_ref(), &env)
                        .with_memory(preamble)
                        .with_history(history)
                        // The same token the registry hands to agent_cancel. Two
                        // separate ones would mean the stop button never reaches the
                        // loop that is actually running.
                        .with_cancel(thread_cancel.clone());
                let mut sink = TeeSink {
                    forward: Box::new(move |event| {
                        let _ = events.send(event);
                    }),
                    log: thread_log.and_then(|p| SessionLog::open(p).ok()),
                    share: thread_share,
                };
                pump_prompts(&mut session, &mut sink, &prompt_rx, &thread_cancel, resumed);
            })
            .map_err(|e| anyhow!("failed to start the agent session thread: {e}"))?;

        self.sessions.lock().unwrap().insert(
            id.clone(),
            SessionHandle {
                session_id: session_id.clone(),
                prompts: prompt_tx,
                cancel,
                gate,
                share: share_slot,
                log_path,
            },
        );
        Ok(id)
    }

    pub fn prompt(&self, id: &str, text: String) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions.get(id).ok_or_else(|| anyhow!("no session {id}"))?;
        handle
            .prompts
            .send(text)
            .map_err(|_| anyhow!("session {id} is no longer running"))
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions.get(id).ok_or_else(|| anyhow!("no session {id}"))?;
        stop_session(&handle.cancel, &handle.gate);
        Ok(())
    }

    /// The handle id running a tab's session, if one is — what the app-level
    /// share's routing needs (its active tab is a tab id, the registry's own
    /// keys are handle ids).
    pub fn handle_for_session(&self, session_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .iter()
            .find(|(_, h)| h.session_id == session_id)
            .map(|(id, _)| id.clone())
    }

    pub fn answer(
        &self,
        id: &str,
        call_id: &str,
        allow: bool,
        reason: Option<String>,
    ) -> Result<bool> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions.get(id).ok_or_else(|| anyhow!("no session {id}"))?;
        let decision = if allow {
            Decision::Allow
        } else {
            Decision::Deny(reason.unwrap_or_else(|| "the user declined".to_string()))
        };
        Ok(handle.gate.answer(call_id, decision))
    }

    /// The hooks a session's `AgentSource` is built from — how a share
    /// speaks to this session, and how the session's fan-out finds the share.
    ///
    /// They are produced here rather than at the call site because each one
    /// has to be able to reach back into this registry, and because getting
    /// one of them wrong — an approval handler that always claims success,
    /// say — would be invisible from outside.
    pub fn agent_hooks(&self, id: &str) -> Option<tabverse_remote::source::agent::AgentHooks> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions.get(id)?;
        let prompts = handle.prompts.clone();
        let cancel = handle.cancel.clone();
        let gate = Arc::clone(&handle.gate);
        let gate_for_cancel = Arc::clone(&handle.gate);
        let log_path = handle.log_path.clone();
        let slot = handle.share.clone();
        drop(sessions);

        Some(tabverse_remote::source::agent::AgentHooks {
            prompt: Arc::new(move |text| {
                let _ = prompts.send(text.to_string());
            }),
            answer: Arc::new(move |call_id, allow, reason| {
                let decision = if allow {
                    Decision::Allow
                } else {
                    Decision::Deny(reason.unwrap_or_else(|| "a viewer declined".to_string()))
                };
                // `answer` reports whether anything was still waiting on that
                // id, which is exactly the race result the viewer needs: false
                // means somebody — the host, or a faster viewer — got there
                // first.
                gate.answer(call_id, decision)
            }),
            cancel: Arc::new(move || {
                stop_session(&cancel, &gate_for_cancel);
            }),
            history: Arc::new(move || {
                // Read from the log rather than kept in memory: it is already
                // the authoritative record, it survives a restart, and a second
                // copy would be one more thing that can disagree.
                let Some(path) = log_path.as_ref() else {
                    return Vec::new();
                };
                let Ok(replay) = SessionLog::replay(path) else {
                    return Vec::new();
                };
                replay
                    .events
                    .iter()
                    .filter_map(|e| serde_json::to_value(e).ok())
                    .collect()
            }),
            set_broadcast: Arc::new(move |target| {
                // The coercion is the whole body: the slot speaks the
                // one-verb broadcast trait, and a `Share` is one of its
                // implementors. Some points the fan-out at the share
                // (bind), None away from it (unbind); the session itself
                // carries on either way.
                *slot.lock().unwrap() = target.map(|share| share as Arc<dyn AgentBroadcast>);
            }),
        })
    }

    /// Tear a session down. Dropping the prompt sender ends its thread.
    pub fn close(&self, id: &str) {
        if let Some(handle) = self.sessions.lock().unwrap().remove(id) {
            stop_session(&handle.cancel, &handle.gate);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tabverse_agent::permission::Policy;

    struct ApproveForTest;

    impl Policy for ApproveForTest {
        fn decide(&self, _tool_name: &str, _input: &Value) -> Decision {
            Decision::Allow
        }
    }

    impl ApprovalGate for ApproveForTest {
        fn request(&self, _call_id: &str, _tool_name: &str, _input: &Value) -> Decision {
            Decision::Allow
        }
    }

    #[test]
    fn a_session_id_cannot_escape_the_log_directory() {
        // The id comes from the webview. Even though tab ids are generated
        // locally today, a path built from untrusted text must not be able to
        // point outside the directory it belongs in.
        let dir = std::path::Path::new("/state");
        let escaped = log_path_for(dir, "../../etc/passwd");
        assert!(
            escaped.starts_with("/state/agent-sessions"),
            "got {}",
            escaped.display()
        );
        assert!(!escaped.to_string_lossy().contains(".."));
    }

    #[test]
    fn the_same_session_id_maps_to_the_same_file() {
        let dir = std::path::Path::new("/state");
        assert_eq!(log_path_for(dir, "tab-7"), log_path_for(dir, "tab-7"));
        assert_ne!(log_path_for(dir, "tab-7"), log_path_for(dir, "tab-8"));
    }

    #[test]
    fn stopping_a_turn_leaves_the_session_able_to_answer_the_next_prompt() {
        // What the user does after pressing stop is type something else. If the
        // stop stayed in effect, that prompt would vanish without a reply and
        // the tab would look dead while still being open.
        use tabverse_agent::provider::{turn_saying, ScriptedProvider};

        // Nothing here touches the filesystem: the scripted turn calls no tools.
        let env = LocalEnv::new(std::env::temp_dir());
        let provider = ScriptedProvider::new(vec![turn_saying("here you go")]);
        let cancel = CancelToken::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        let mut sink = TeeSink {
            forward: Box::new(move |event| recorder.lock().unwrap().push(event)),
            log: None,
            share: Arc::new(Mutex::new(None)),
        };
        let mut session = Session::new(
            &provider,
            builtin_tools(),
            &ApproveForTest,
            &ApproveForTest,
            &env,
        )
        .with_cancel(cancel.clone());

        let (tx, rx) = channel();
        cancel.cancel(); // the stop button, pressed on the previous turn
        tx.send("and now this".to_string()).unwrap();
        drop(tx); // closing the tab is what ends the loop

        pump_prompts(&mut session, &mut sink, &rx, &cancel, 0);

        assert_eq!(
            provider.request_count(),
            1,
            "the prompt after a stop must reach the model"
        );
        let events = seen.lock().unwrap();
        assert!(
            events.iter().any(
                |e| matches!(e, SessionEvent::AssistantText { delta } if delta == "here you go")
            ),
            "the answer must reach the screen, got {events:?}"
        );
    }

    #[test]
    fn an_unanswered_request_is_refused_not_granted() {
        // Same shape as the real gate, with a timeout short enough to test.
        let gate = UiGate::new();
        let (tx, rx) = channel();
        gate.waiting.lock().unwrap().insert("c1".into(), tx);
        drop(rx); // nobody is listening — the request cannot be answered
        assert!(
            !gate.answer("c1", Decision::Allow),
            "a dead receiver is not an approval"
        );
    }

    #[test]
    fn answering_an_unknown_call_reports_that_nothing_was_waiting() {
        let gate = UiGate::new();
        assert!(!gate.answer("never-existed", Decision::Allow));
    }

    #[test]
    fn an_approval_nobody_answers_times_out_into_a_refusal() {
        // The judgement this encodes: an unanswered request must never become
        // permission. A user who walked away has not said yes.
        let gate = UiGate::with_timeout(Duration::from_millis(120));
        let started = std::time::Instant::now();
        let decision = gate.request("c1", "bash", &json!({ "command": "rm -rf /" }));
        match decision {
            Decision::Deny(reason) => assert!(
                reason.contains("timeout"),
                "the refusal must say why, got {reason:?}"
            ),
            other => panic!("silence must not authorise anything, got {other:?}"),
        }
        assert!(
            started.elapsed() >= Duration::from_millis(100),
            "it must actually wait first"
        );
        assert!(
            gate.waiting.lock().unwrap().is_empty(),
            "a timed-out request must stop occupying the table"
        );
    }

    #[test]
    fn a_parked_request_receives_the_decision_it_was_given() {
        let gate = Arc::new(UiGate::new());
        let asker = Arc::clone(&gate);
        let handle = std::thread::spawn(move || asker.request("c1", "bash", &json!({})));
        // Wait for the request to park itself before answering.
        for _ in 0..200 {
            if gate.waiting.lock().unwrap().contains_key("c1") {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(gate.answer("c1", Decision::Deny("no".into())));
        assert_eq!(handle.join().unwrap(), Decision::Deny("no".into()));
    }

    #[test]
    fn closing_releases_everyone_still_waiting() {
        let gate = Arc::new(UiGate::new());
        let asker = Arc::clone(&gate);
        let handle = std::thread::spawn(move || asker.request("c1", "bash", &json!({})));
        for _ in 0..200 {
            if gate.waiting.lock().unwrap().contains_key("c1") {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        gate.release_all();
        match handle.join().unwrap() {
            Decision::Deny(reason) => assert!(reason.contains("closed")),
            other => panic!("closing must refuse, not authorise: {other:?}"),
        }
    }

    // ── the registry, end to end ──────────────────────────────────────────
    //
    // `Channel` turns out to be constructible without a webview: `Channel::new`
    // takes the callback itself. That closes most of the gap between the unit
    // tests above and the desktop app — a real registry, a real session thread,
    // real tools on a real directory, and the same events the webview would get.
    // What it still does not prove is that the tab on screen renders them; that
    // stays on the queue as its own item.

    /// Collects what the webview would have received, and holds a handle that
    /// only goes away when the session thread does.
    struct Recorder {
        events: Arc<Mutex<Vec<SessionEvent>>>,
        alive: Arc<()>,
    }

    impl Recorder {
        fn new() -> (Self, Channel<SessionEvent>) {
            let events = Arc::new(Mutex::new(Vec::new()));
            let alive = Arc::new(());
            let sink_events = Arc::clone(&events);
            // Moved into the channel's callback, which the session thread owns
            // through its sink. When the count falls back to one, the thread has
            // dropped everything it held.
            let sink_alive = Arc::clone(&alive);
            let channel = Channel::new(move |body| {
                let _keepalive = &sink_alive;
                if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                    if let Ok(event) = serde_json::from_str::<SessionEvent>(&text) {
                        sink_events.lock().unwrap().push(event);
                    }
                }
                Ok(())
            });
            (Self { events, alive }, channel)
        }

        /// Wait for the session to reach some state. Polling rather than a
        /// fixed sleep: a slow machine should make the test slower, not red.
        fn wait_for(&self, what: &str, ready: impl Fn(&[SessionEvent]) -> bool) {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                {
                    let seen = self.events.lock().unwrap();
                    if ready(&seen) {
                        return;
                    }
                    if std::time::Instant::now() > deadline {
                        panic!("timed out waiting for {what}; saw {seen:#?}");
                    }
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn snapshot(&self) -> Vec<SessionEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    fn tool_finished_containing<'a>(events: &'a [SessionEvent], needle: &str) -> Option<&'a str> {
        events.iter().find_map(|e| match e {
            SessionEvent::ToolFinished { result, .. } if result.contains(needle) => {
                Some(result.as_str())
            }
            _ => None,
        })
    }

    #[test]
    fn a_prompt_runs_the_whole_path_and_the_thread_lets_go_when_the_tab_closes() {
        let work = tempfile::tempdir().unwrap();
        std::fs::write(work.path().join("hello.txt"), "hi\n").unwrap();
        let logs = tempfile::tempdir().unwrap();
        let (recorder, channel) = Recorder::new();
        let registry = AgentRegistry::new();

        let id = registry
            .start(
                "tab-1".to_string(),
                work.path().display().to_string(),
                Some(logs.path().to_path_buf()),
                channel,
            )
            .unwrap();
        registry
            .prompt(&id, "what is in here?".to_string())
            .unwrap();

        // Act one is a read-only tool, so the policy lets it through untouched.
        recorder.wait_for("the listing to come back", |events| {
            tool_finished_containing(events, "hello.txt").is_some()
        });
        // Act two is a command, which must stop and ask.
        recorder.wait_for("the command to be put to the user", |events| {
            events.iter().any(|e| {
                matches!(e, SessionEvent::PermissionRequested(call) if call.call_id == "demo-2")
            })
        });
        assert!(
            registry.answer(&id, "demo-2", true, None).unwrap(),
            "the waiting request must accept the answer"
        );
        recorder.wait_for("the command's output", |events| {
            tool_finished_containing(events, "hello from the agent").is_some()
        });

        // Everything on screen is also on disk, in order.
        let log = log_path_for(logs.path(), "tab-1");
        let replay = SessionLog::replay(&log).expect("the log must be readable");
        let on_screen = recorder.snapshot();
        assert_eq!(
            replay.events.len(),
            on_screen.len(),
            "the log and the screen must have seen the same events"
        );
        assert!(
            !replay.messages.is_empty(),
            "the conversation must have been written too"
        );

        assert_eq!(
            Arc::strong_count(&recorder.alive),
            2,
            "the thread still holds the channel"
        );
        registry.close(&id);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while Arc::strong_count(&recorder.alive) > 1 {
            assert!(
                std::time::Instant::now() < deadline,
                "the session thread outlived its tab"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(registry.prompt(&id, "anyone there?".to_string()).is_err());
    }

    #[test]
    fn reopening_a_tab_puts_its_history_back_on_the_screen() {
        let work = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let registry = AgentRegistry::new();

        let (first, channel) = Recorder::new();
        let id = registry
            .start(
                "tab-7".to_string(),
                work.path().display().to_string(),
                Some(logs.path().to_path_buf()),
                channel,
            )
            .unwrap();
        registry.prompt(&id, "remember this".to_string()).unwrap();
        first.wait_for("the first act to finish", |events| {
            events
                .iter()
                .any(|e| matches!(e, SessionEvent::PermissionRequested(call) if call.call_id == "demo-2"))
        });
        // Closed with the approval still parked: the thread is blocked on an
        // answer that can no longer come, and closing has to free it. Otherwise
        // a shut tab keeps a thread and its workspace for the whole approval
        // timeout, with nothing on screen to say so.
        registry.close(&id);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while Arc::strong_count(&first.alive) > 1 {
            assert!(
                std::time::Instant::now() < deadline,
                "closing a tab with an approval waiting left its thread behind"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let before = first.snapshot();

        // The same tab id is what makes a reopened tab find its own history.
        let (second, channel) = Recorder::new();
        registry
            .start(
                "tab-7".to_string(),
                work.path().display().to_string(),
                Some(logs.path().to_path_buf()),
                channel,
            )
            .unwrap();
        second.wait_for("the replay", |events| {
            events
                .iter()
                .any(|e| matches!(e, SessionEvent::UserPrompt { text } if text == "remember this"))
        });
        let replayed = second.snapshot();
        assert!(
            replayed.len() >= before.len(),
            "reopening must show at least what the first session showed: {} vs {}",
            replayed.len(),
            before.len()
        );
    }

    #[test]
    fn two_folders_with_the_same_name_do_not_share_a_memory() {
        // The failure this guards: "builds with pnpm" learned in one project
        // showing up as fact in another that happens to have the same basename.
        let dir = std::path::Path::new("/state");
        let a = memory_path_for(dir, "/Users/x/work/api");
        let b = memory_path_for(dir, "/Users/x/archive/api");
        assert_ne!(a, b);
        assert!(
            a.to_string_lossy().contains("work-api"),
            "the name should stay readable: {a:?}"
        );

        // And the case the readable tail cannot separate on its own, which is
        // the whole reason the hash is there: same last two segments, different
        // path. Two checkouts of the same repo is the everyday version of this.
        let mine = memory_path_for(dir, "/Users/x/work/api");
        let theirs = memory_path_for(dir, "/Users/y/work/api");
        assert_ne!(
            mine, theirs,
            "identical tails must still be told apart by the full path"
        );
    }

    #[test]
    fn the_same_folder_always_finds_the_same_memory() {
        let dir = std::path::Path::new("/state");
        assert_eq!(
            memory_path_for(dir, "/Users/x/work/api"),
            memory_path_for(dir, "/Users/x/work/api")
        );
    }

    #[test]
    fn a_folder_name_cannot_escape_the_memory_directory() {
        let dir = std::path::Path::new("/state");
        let path = memory_path_for(dir, "/tmp/../../etc/../passwd");
        assert!(path.starts_with("/state/agent-memory"), "got {path:?}");
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(!name.contains(".."), "got {name}");
        assert!(!name.contains('/'), "got {name}");
    }

    /// Records what a share would have been sent.
    #[derive(Default)]
    struct SpyBroadcast {
        events: Mutex<Vec<serde_json::Value>>,
    }

    impl AgentBroadcast for SpyBroadcast {
        fn agent_event(&self, event: serde_json::Value) {
            self.events.lock().unwrap().push(event);
        }
    }

    #[test]
    fn every_event_that_reaches_the_screen_also_goes_to_the_viewers() {
        // The third destination, asserted rather than assumed. Screen, disk and
        // wire leave from one call precisely so they cannot diverge — a viewer
        // silently a few events behind is the failure this prevents.
        let work = tempfile::tempdir().unwrap();
        let (recorder, channel) = Recorder::new();
        let registry = AgentRegistry::new();
        let id = registry
            .start(
                "tab-spy".to_string(),
                work.path().display().to_string(),
                None,
                channel,
            )
            .unwrap();

        let spy = Arc::new(SpyBroadcast::default());
        let hooks = registry
            .agent_hooks(&id)
            .expect("a running session must be able to describe its hooks");
        // The spy stands in for a share, so it enters through the slot the
        // hooks' set_broadcast writes — the hook itself only takes a real
        // `Share`, and what this test watches is the fan-out, not the wire.
        let slot = registry
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .expect("the session is running")
            .share
            .clone();
        *slot.lock().unwrap() = Some(spy.clone());
        registry.prompt(&id, "look".to_string()).unwrap();

        recorder.wait_for("the approval request", |events| {
            events.iter().any(|e| {
                matches!(e, SessionEvent::PermissionRequested(call) if call.call_id == "demo-2")
            })
        });

        let on_screen = recorder.snapshot();
        let broadcast = spy.events.lock().unwrap().clone();
        assert!(
            !broadcast.is_empty(),
            "viewers must have been sent something"
        );
        assert_eq!(
            broadcast.len(),
            on_screen.len(),
            "a viewer must not be a single event behind what the screen shows"
        );
        let first_screen = serde_json::to_value(&on_screen[0]).unwrap();
        assert_eq!(
            broadcast[0], first_screen,
            "and it is the same event, not a summary of it"
        );

        // Detaching stops it without stopping the session — through the same
        // hook `AgentSource::unbind` pulls when a share ends.
        (hooks.set_broadcast)(None);
        let before = spy.events.lock().unwrap().len();
        registry.answer(&id, "demo-2", true, None).unwrap();
        recorder.wait_for("the command to finish", |events| {
            events.iter().any(|e| {
                matches!(e, SessionEvent::ToolFinished { result, .. } if result.contains("hello from the agent"))
            })
        });
        assert_eq!(
            spy.events.lock().unwrap().len(),
            before,
            "a detached share must stop receiving, while the session carries on"
        );

        registry.close(&id);
    }

    #[test]
    fn a_shared_session_writes_the_same_history_a_late_viewer_would_read() {
        // The third destination. What the screen sees and what a viewer sees
        // must not be able to diverge, so they leave from the same call.
        use tabverse_proto::Access;
        use tabverse_remote::source::agent::AgentSource;
        use tabverse_remote::{RemoteHub, ShareOpts};

        let work = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let (recorder, channel) = Recorder::new();
        let registry = AgentRegistry::new();
        let id = registry
            .start(
                "tab-shared".to_string(),
                work.path().display().to_string(),
                Some(logs.path().to_path_buf()),
                channel,
            )
            .unwrap();

        let hub = RemoteHub::new();
        let hooks = registry
            .agent_hooks(&id)
            .expect("a running session must be able to describe its hooks");
        // The real adapter: bind() points the session's fan-out at the share
        // from inside hub.share_start, before any ticket exists.
        let source = AgentSource::new(hooks);
        let (share, _ticket) = tauri::async_runtime::block_on(hub.share_start(ShareOpts {
            title: "Agent".into(),
            source: Arc::new(source),
            on_presence: Arc::new(|_| {}),
            ttl: None,
            access: Access::Approve,
        }))
        .unwrap();

        registry.prompt(&id, "what is here?".to_string()).unwrap();
        recorder.wait_for("the command to be put to the user", |events| {
            events.iter().any(|e| {
                matches!(e, SessionEvent::PermissionRequested(call) if call.call_id == "demo-2")
            })
        });

        // The share's own view of the run: the log is what a late viewer would
        // be given, and it must hold what the screen was shown.
        let history = SessionLog::replay(log_path_for(logs.path(), "tab-shared")).unwrap();
        assert!(
            history.events.len() >= recorder.snapshot().len(),
            "everything on screen must also be where a viewer would read it"
        );

        registry.close(&id);
        hub.share_stop(&share.id);
    }

    #[test]
    fn a_viewers_answer_reaches_the_gate_and_only_the_first_one_counts() {
        // The race, from the registry's side: the hooks a share is given must
        // report truthfully whether an answer took effect, because that report
        // is what tells the loser it lost.
        let work = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let (recorder, channel) = Recorder::new();
        let registry = AgentRegistry::new();
        let id = registry
            .start(
                "tab-race".to_string(),
                work.path().display().to_string(),
                Some(logs.path().to_path_buf()),
                channel,
            )
            .unwrap();
        let hooks = registry.agent_hooks(&id).unwrap();

        registry.prompt(&id, "go".to_string()).unwrap();
        recorder.wait_for("the approval request", |events| {
            events.iter().any(|e| {
                matches!(e, SessionEvent::PermissionRequested(call) if call.call_id == "demo-2")
            })
        });

        let first = (hooks.answer)("demo-2", true, None);
        let second = (hooks.answer)("demo-2", false, None);
        assert!(first, "the first answer must take effect");
        assert!(
            !second,
            "the second must report that it did not, or nobody can tell the loser"
        );

        recorder.wait_for("the command to run after approval", |events| {
            events.iter().any(|e| {
                matches!(e, SessionEvent::ToolFinished { result, .. } if result.contains("hello from the agent"))
            })
        });

        registry.close(&id);
    }

    #[test]
    fn a_viewers_prompt_and_cancel_reach_the_session() {
        let work = tempfile::tempdir().unwrap();
        let (recorder, channel) = Recorder::new();
        let registry = AgentRegistry::new();
        let id = registry
            .start(
                "tab-steer".to_string(),
                work.path().display().to_string(),
                None,
                channel,
            )
            .unwrap();
        let hooks = registry.agent_hooks(&id).unwrap();

        (hooks.prompt)("look around");
        recorder.wait_for("the viewer's prompt to be answered", |events| {
            events
                .iter()
                .any(|e| matches!(e, SessionEvent::UserPrompt { text } if text == "look around"))
        });

        (hooks.cancel)();
        // Cancelling releases the gate too, so the parked approval resolves and
        // the turn can end rather than sitting there.
        recorder.wait_for("the turn to stop", |events| {
            events
                .iter()
                .any(|e| matches!(e, SessionEvent::TurnEnded { .. }))
        });

        registry.close(&id);
    }

    #[test]
    fn hooks_cannot_be_taken_for_a_session_that_is_gone() {
        let registry = AgentRegistry::new();
        assert!(registry.agent_hooks("nope").is_none());
    }

    #[test]
    fn a_tab_opens_and_works_with_no_sign_in_at_all() {
        // The fallback, asserted rather than assumed. Without it a user with no
        // ChatGPT subscription could not open an agent tab, and every other
        // part of this — tools, approvals, compaction, sharing — would be
        // unreachable for them too.
        let vault = tempfile::tempdir().unwrap();
        let _vault = crate::credentials::test_vault_guard(vault.path().to_path_buf());
        assert!(
            crate::agent_http::stored_token().is_none(),
            "this test is about there being no sign-in"
        );

        let work = tempfile::tempdir().unwrap();
        std::fs::write(work.path().join("hello.txt"), "hi\n").unwrap();
        let (recorder, channel) = Recorder::new();
        let registry = AgentRegistry::new();
        let id = registry
            .start(
                "tab-nologin".to_string(),
                work.path().display().to_string(),
                None,
                channel,
            )
            .unwrap();

        registry.prompt(&id, "what is here?".to_string()).unwrap();
        // The whole path still runs: text, a tool that the policy allows, and
        // a command that stops to ask.
        recorder.wait_for("the listing", |events| {
            events.iter().any(|e| {
                matches!(e, SessionEvent::ToolFinished { result, .. } if result.contains("hello.txt"))
            })
        });
        recorder.wait_for("the approval request", |events| {
            events.iter().any(|e| {
                matches!(e, SessionEvent::PermissionRequested(call) if call.call_id == "demo-2")
            })
        });

        registry.close(&id);
    }
}
