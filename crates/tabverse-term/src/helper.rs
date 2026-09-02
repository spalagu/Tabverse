//! Authenticated loopback server and helper-owned session dispatch.

use std::{
    collections::HashMap,
    io,
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::{
    backend::{HelperRuntime, SessionMeta, SessionSink},
    protocol::{AuthToken, Frame, Kind, SessionId},
    transport::{FrameSender, FramedStream, TransportError},
    SpawnOpts,
};

const ACCEPT_POLL: Duration = Duration::from_millis(10);

#[derive(Debug, Deserialize)]
struct SpawnRequest {
    shell: Option<String>,
    cwd: Option<String>,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
    #[serde(default)]
    env: Vec<(String, String)>,
    #[serde(default)]
    shell_integration: bool,
    run_on_start: Option<String>,
    owner_key: Option<String>,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

impl From<SpawnRequest> for SpawnOpts {
    fn from(value: SpawnRequest) -> Self {
        Self {
            shell: value.shell,
            cwd: value.cwd,
            cols: value.cols,
            rows: value.rows,
            env: value.env,
            shell_integration: value.shell_integration,
            run_on_start: value.run_on_start,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ResizeRequest {
    cols: u16,
    rows: u16,
}

#[derive(Debug, Serialize)]
struct ExitPayload {
    code: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionWire {
    id: [u8; 16],
    generation: u64,
    cwd: Option<String>,
    #[serde(rename = "ownerKey")]
    owner_key: Option<String>,
    exited: Option<Option<u32>>,
    attached: bool,
}

impl From<SessionMeta> for SessionWire {
    fn from(value: SessionMeta) -> Self {
        Self {
            id: value.id.0,
            generation: value.generation,
            cwd: value.cwd,
            owner_key: value.owner_key,
            exited: value.exited,
            attached: value.attached,
        }
    }
}

pub struct HelperServer {
    endpoint: SocketAddr,
    runtime: Arc<HelperRuntime>,
    shutdown: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

#[derive(Clone, Copy)]
enum DisconnectPolicy {
    Terminate,
    Detach,
}

impl HelperServer {
    /// Start a short-lived helper owned by one GUI process. If that GUI
    /// disappears without an explicit detach, its attached shells must not
    /// become orphaned background processes.
    pub fn start(
        token: AuthToken,
        helper_nonce: [u8; 32],
        capabilities: u64,
        idle_timeout: Duration,
    ) -> io::Result<Self> {
        Self::start_with_policy(
            token,
            helper_nonce,
            capabilities,
            idle_timeout,
            DisconnectPolicy::Terminate,
        )
    }

    /// Start a helper whose process is owned by ResidentSupervisor rather
    /// than the GUI. A lost GUI connection detaches its shells so a
    /// replacement GUI can replay and take them over.
    pub fn start_resident(
        token: AuthToken,
        helper_nonce: [u8; 32],
        capabilities: u64,
        idle_timeout: Duration,
    ) -> io::Result<Self> {
        Self::start_with_policy(
            token,
            helper_nonce,
            capabilities,
            idle_timeout,
            DisconnectPolicy::Detach,
        )
    }

    fn start_with_policy(
        token: AuthToken,
        helper_nonce: [u8; 32],
        capabilities: u64,
        idle_timeout: Duration,
        disconnect_policy: DisconnectPolicy,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let endpoint = listener.local_addr()?;
        let runtime = Arc::new(HelperRuntime::new());
        let shutdown = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let clients = Arc::new(AtomicUsize::new(0));
        let last_activity = Arc::new(Mutex::new(Instant::now()));

        let thread_shutdown = Arc::clone(&shutdown);
        let thread_alive = Arc::clone(&alive);
        let thread_clients = Arc::clone(&clients);
        let thread_runtime = Arc::clone(&runtime);
        let thread_activity = Arc::clone(&last_activity);
        let thread = thread::Builder::new()
            .name("tabverse-helper-listener".into())
            .spawn(move || {
                while !thread_shutdown.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, peer)) => {
                            if !peer.ip().is_loopback() {
                                continue;
                            }
                            thread_clients.fetch_add(1, Ordering::AcqRel);
                            *thread_activity.lock().unwrap() = Instant::now();
                            let client_count = Arc::clone(&thread_clients);
                            let activity = Arc::clone(&thread_activity);
                            let runtime = Arc::clone(&thread_runtime);
                            thread::Builder::new()
                                .name("tabverse-helper-client".into())
                                .spawn(move || {
                                    handle_client(
                                        stream,
                                        token,
                                        helper_nonce,
                                        capabilities,
                                        runtime,
                                        &activity,
                                        disconnect_policy,
                                    );
                                    client_count.fetch_sub(1, Ordering::AcqRel);
                                    *activity.lock().unwrap() = Instant::now();
                                })
                                .ok();
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                        Err(_) => break,
                    }
                    let idle = thread_clients.load(Ordering::Acquire) == 0
                        && thread_runtime.list().is_empty()
                        && thread_activity.lock().unwrap().elapsed() >= idle_timeout;
                    if idle {
                        break;
                    }
                    thread::sleep(ACCEPT_POLL);
                }
                thread_alive.store(false, Ordering::Release);
            })?;

        Ok(Self {
            endpoint,
            runtime,
            shutdown,
            alive,
            thread: Some(thread),
        })
    }

    pub fn endpoint(&self) -> SocketAddr {
        self.endpoint
    }

    pub fn runtime(&self) -> Arc<HelperRuntime> {
        Arc::clone(&self.runtime)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.endpoint);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.alive.store(false, Ordering::Release);
    }
}

impl Drop for HelperServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn session_sink(id: SessionId, generation: u64, sender: FrameSender) -> SessionSink {
    let output = sender.clone();
    SessionSink::new(
        move |bytes| {
            let _ = output.send(&Frame::new(Kind::Output, id, generation, bytes.to_vec()));
        },
        move |code| {
            let payload = serde_json::to_vec(&ExitPayload { code }).unwrap_or_default();
            let _ = sender.send(&Frame::new(Kind::Exit, id, generation, payload));
        },
    )
}

fn handle_client(
    stream: TcpStream,
    token: AuthToken,
    helper_nonce: [u8; 32],
    capabilities: u64,
    runtime: Arc<HelperRuntime>,
    last_activity: &Mutex<Instant>,
    disconnect_policy: DisconnectPolicy,
) {
    // Accepted sockets inherit O_NONBLOCK from the listener on macOS.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut framed = FramedStream::new(stream);
    if framed
        .authenticate_server(token, helper_nonce, capabilities)
        .is_err()
    {
        return;
    }
    let sender = match framed.sender() {
        Ok(sender) => sender,
        Err(_) => return,
    };
    let _ = framed.set_read_timeout(None);
    let mut owned = HashMap::<SessionId, u64>::new();
    loop {
        let request = match framed.recv() {
            Ok(request) => request,
            Err(TransportError::Closed) => break,
            Err(error) => {
                eprintln!("[helper] client frame failed after authentication: {error}");
                break;
            }
        };
        *last_activity.lock().unwrap() = Instant::now();
        if let Err(error) = dispatch(&runtime, &sender, &request, &mut owned) {
            let _ = sender.send(&Frame::new(
                Kind::Error,
                request.session_id,
                request.generation,
                error.to_string().into_bytes(),
            ));
        }
    }
    release_owned_sessions(&runtime, disconnect_policy, owned);
}

fn release_owned_sessions(
    runtime: &HelperRuntime,
    policy: DisconnectPolicy,
    owned: HashMap<SessionId, u64>,
) {
    for (id, generation) in owned {
        match policy {
            DisconnectPolicy::Terminate => {
                let _ = runtime.terminate(id, generation);
            }
            DisconnectPolicy::Detach => {
                let _ = runtime.detach(id, generation);
            }
        }
    }
}

fn dispatch(
    runtime: &HelperRuntime,
    sender: &FrameSender,
    request: &Frame,
    owned: &mut HashMap<SessionId, u64>,
) -> anyhow::Result<()> {
    match request.kind {
        Kind::Spawn => {
            let spawn: SpawnRequest = serde_json::from_slice(&request.payload)?;
            let owner_key = spawn.owner_key.clone();
            let buffered = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
            let active = Arc::new(AtomicBool::new(false));
            let output_sender = sender.clone();
            let output_buffer = Arc::clone(&buffered);
            let output_active = Arc::clone(&active);
            let exit_sender = sender.clone();
            let id = runtime.spawn_with_sink_owned(spawn.into(), owner_key, move |id| {
                SessionSink::new(
                    move |bytes| {
                        if output_active.load(Ordering::Acquire) {
                            let _ = output_sender.send(&Frame::new(
                                Kind::Output,
                                id,
                                1,
                                bytes.to_vec(),
                            ));
                        } else {
                            output_buffer.lock().unwrap().push(bytes.to_vec());
                        }
                    },
                    move |code| {
                        let payload = serde_json::to_vec(&ExitPayload { code }).unwrap_or_default();
                        let _ = exit_sender.send(&Frame::new(Kind::Exit, id, 1, payload));
                    },
                )
            })?;
            // Record ownership before touching the socket again. If the peer
            // vanished while Spawn was running, disconnect cleanup still
            // applies the server's lifetime policy to the new shell.
            owned.insert(id, 1);
            sender.send(&Frame::new(Kind::Spawn, id, 1, Vec::new()))?;
            active.store(true, Ordering::Release);
            for bytes in buffered.lock().unwrap().drain(..) {
                sender.send(&Frame::new(Kind::Output, id, 1, bytes))?;
            }
        }
        Kind::Input => runtime.write(request.session_id, request.generation, &request.payload)?,
        Kind::Resize => {
            let size: ResizeRequest = serde_json::from_slice(&request.payload)?;
            runtime.resize(request.session_id, request.generation, size.cols, size.rows)?;
        }
        Kind::Detach => {
            let next = runtime.detach(request.session_id, request.generation)?;
            owned.remove(&request.session_id);
            sender.send(&Frame::new(
                Kind::Detach,
                request.session_id,
                next,
                Vec::new(),
            ))?;
        }
        Kind::Attach => {
            let generation = runtime.begin_attach(request.session_id)?;
            // A takeover supersedes any older generation this client may
            // have held. Record it before replay writes can discover a dead
            // socket.
            owned.insert(request.session_id, generation);
            let sink = session_sink(request.session_id, generation, sender.clone());
            runtime.complete_attach(request.session_id, generation, sink, |batch| {
                sender.send(&Frame::new(
                    Kind::Snapshot,
                    request.session_id,
                    generation,
                    batch.snapshot.clone(),
                ))?;
                if !batch.delta.is_empty() {
                    sender.send(&Frame::new(
                        Kind::Output,
                        request.session_id,
                        generation,
                        batch.delta.clone(),
                    ))?;
                }
                Ok(())
            })?;
        }
        Kind::List => {
            let list: Vec<SessionWire> = runtime.list().into_iter().map(Into::into).collect();
            sender.send(&Frame::new(
                Kind::List,
                SessionId::default(),
                request.generation,
                serde_json::to_vec(&list)?,
            ))?;
        }
        Kind::Terminate => {
            runtime.terminate(request.session_id, request.generation)?;
            owned.remove(&request.session_id);
            sender.send(&Frame::new(
                Kind::Terminate,
                request.session_id,
                request.generation,
                Vec::new(),
            ))?;
        }
        Kind::KillAll => {
            runtime.kill_all();
            owned.clear();
            sender.send(&Frame::new(
                Kind::KillAll,
                SessionId::default(),
                request.generation,
                Vec::new(),
            ))?;
        }
        _ => anyhow::bail!("unsupported helper request"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ProtocolError;

    const TOKEN: AuthToken = AuthToken::new([0x44; 32]);

    fn connect(endpoint: SocketAddr) -> FramedStream {
        let framed = FramedStream::connect(endpoint, Duration::from_secs(2)).unwrap();
        framed
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        framed
    }

    fn recv_kind(client: &mut FramedStream, wanted: Kind) -> Frame {
        for _ in 0..30 {
            let frame = client.recv().unwrap();
            if frame.kind == wanted {
                return frame;
            }
        }
        panic!("helper never sent {wanted:?}");
    }

    #[cfg(unix)]
    fn spawn_shell(client: &mut FramedStream) -> Frame {
        let spawn = serde_json::json!({
            "shell": "/bin/sh", "cols": 80, "rows": 24,
            "shell_integration": false
        });
        client
            .send(&Frame::new(
                Kind::Spawn,
                SessionId::default(),
                0,
                serde_json::to_vec(&spawn).unwrap(),
            ))
            .unwrap();
        recv_kind(client, Kind::Spawn)
    }

    #[cfg(unix)]
    fn wait_until(mut predicate: impl FnMut() -> bool, message: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !predicate() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(predicate(), "{message}");
    }

    #[test]
    fn authenticated_client_can_list_and_wrong_token_learns_nothing() {
        let mut server = HelperServer::start(TOKEN, [0x55; 32], 7, Duration::from_secs(5)).unwrap();
        let mut wrong = connect(server.endpoint());
        let error = wrong
            .authenticate_client(AuthToken::new([0x45; 32]), [1; 32])
            .unwrap_err();
        assert!(matches!(
            error,
            TransportError::Protocol(ProtocolError::Unauthorized)
        ));

        let mut client = connect(server.endpoint());
        let (capabilities, nonce) = client.authenticate_client(TOKEN, [2; 32]).unwrap();
        assert_eq!(capabilities, 7);
        assert_eq!(nonce, [0x55; 32]);
        client
            .send(&Frame::new(Kind::List, SessionId::default(), 3, vec![]))
            .unwrap();
        let list = recv_kind(&mut client, Kind::List);
        assert_eq!(list.payload, b"[]");
        server.stop();
    }

    #[test]
    fn every_bad_first_frame_has_the_same_wire_answer() {
        let mut server = HelperServer::start(TOKEN, [3; 32], 0, Duration::from_secs(5)).unwrap();
        let bad_frames = [
            Frame::new(Kind::List, SessionId::default(), 0, vec![]),
            Frame::new(Kind::Hello, SessionId::default(), 0, vec![0; 64]),
            Frame::new(Kind::Hello, SessionId::default(), 0, vec![0x44; 31]),
        ];
        for bad in bad_frames {
            let mut client = connect(server.endpoint());
            client.send(&bad).unwrap();
            let answer = client.recv().unwrap();
            assert_eq!(answer.kind, Kind::Error);
            assert_eq!(answer.payload, b"unauthorized");
        }
        server.stop();
    }

    #[test]
    fn empty_helper_exits_after_its_idle_window() {
        let mut server = HelperServer::start(TOKEN, [4; 32], 0, Duration::from_millis(40)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while server.is_alive() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !server.is_alive(),
            "an empty helper must not become a daemon"
        );
        server.stop();
    }

    #[cfg(unix)]
    #[test]
    fn protocol_spawns_detaches_lists_and_terminates_a_helper_owned_shell() {
        let mut server = HelperServer::start(TOKEN, [5; 32], 0, Duration::from_secs(5)).unwrap();
        let mut client = connect(server.endpoint());
        client.authenticate_client(TOKEN, [6; 32]).unwrap();
        let spawned = spawn_shell(&mut client);
        assert_ne!(spawned.session_id, SessionId::default());
        assert_eq!(spawned.generation, 1);
        client
            .send(&Frame::new(
                Kind::Input,
                spawned.session_id,
                1,
                b"printf 'WIRE-OK\\n'\n".to_vec(),
            ))
            .unwrap();
        let output = recv_kind(&mut client, Kind::Output);
        assert!(output.payload.windows(7).any(|w| w == b"WIRE-OK"));
        client
            .send(&Frame::new(Kind::Detach, spawned.session_id, 1, vec![]))
            .unwrap();
        let detached = recv_kind(&mut client, Kind::Detach);
        assert_eq!(detached.generation, 2);
        client
            .send(&Frame::new(Kind::List, SessionId::default(), 0, vec![]))
            .unwrap();
        let listed = recv_kind(&mut client, Kind::List);
        let rows: Vec<SessionWire> = serde_json::from_slice(&listed.payload).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].attached);
        client
            .send(&Frame::new(Kind::Terminate, spawned.session_id, 2, vec![]))
            .unwrap();
        recv_kind(&mut client, Kind::Terminate);
        assert!(server.runtime().list().is_empty());
        server.stop();
    }

    #[cfg(unix)]
    #[test]
    fn legacy_helper_terminates_sessions_when_its_gui_disconnects() {
        let mut server = HelperServer::start(TOKEN, [7; 32], 0, Duration::from_secs(5)).unwrap();
        let runtime = server.runtime();
        let mut client = connect(server.endpoint());
        client.authenticate_client(TOKEN, [8; 32]).unwrap();
        let spawned = spawn_shell(&mut client);
        assert_eq!(runtime.list().len(), 1);

        drop(client);

        wait_until(
            || runtime.list().is_empty(),
            "a legacy GUI disconnect must terminate its attached shell",
        );
        assert!(runtime.replay_snapshot(spawned.session_id).is_err());
        server.stop();
    }

    #[cfg(unix)]
    #[test]
    fn resident_helper_detaches_and_allows_takeover_after_gui_disconnect() {
        let mut server =
            HelperServer::start_resident(TOKEN, [9; 32], 0, Duration::from_secs(5)).unwrap();
        let runtime = server.runtime();
        let mut first = connect(server.endpoint());
        first.authenticate_client(TOKEN, [10; 32]).unwrap();
        let spawned = spawn_shell(&mut first);
        first
            .send(&Frame::new(
                Kind::Input,
                spawned.session_id,
                spawned.generation,
                b"sleep 0.1; printf 'RESIDENT-DETACHED\\n'\n".to_vec(),
            ))
            .unwrap();

        drop(first);

        wait_until(
            || {
                let sessions = runtime.list();
                sessions.len() == 1 && !sessions[0].attached && sessions[0].generation == 2
            },
            "a resident GUI disconnect must detach rather than terminate its shell",
        );
        wait_until(
            || {
                runtime
                    .replay_snapshot(spawned.session_id)
                    .is_ok_and(|bytes| {
                        bytes
                            .windows(17)
                            .any(|window| window == b"RESIDENT-DETACHED")
                    })
            },
            "detached terminal output must enter the resident replay ring",
        );

        let mut replacement = connect(server.endpoint());
        replacement.authenticate_client(TOKEN, [11; 32]).unwrap();
        replacement
            .send(&Frame::new(Kind::Attach, spawned.session_id, 2, Vec::new()))
            .unwrap();
        let snapshot = recv_kind(&mut replacement, Kind::Snapshot);
        assert_eq!(snapshot.generation, 3);
        replacement
            .send(&Frame::new(
                Kind::Input,
                spawned.session_id,
                snapshot.generation,
                b"printf 'RESIDENT-TAKEOVER\\n'\n".to_vec(),
            ))
            .unwrap();
        let output = recv_kind(&mut replacement, Kind::Output);
        assert!(output
            .payload
            .windows(17)
            .any(|window| window == b"RESIDENT-TAKEOVER"));

        runtime.terminate(spawned.session_id, 3).unwrap();
        server.stop();
    }
}
