use crate::{
    authenticate_hello, AttachReplay, AuthToken, ClientHello, EnsureRuntime, ProtocolRange,
    ProtocolWelcome, RuntimeRef, RuntimeStatus, Supervisor,
};
use anyhow::{anyhow, bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

const ENDPOINT_SCHEMA: u16 = 1;
const MAX_WIRE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EndpointRecord {
    schema_version: u16,
    pid: u32,
    port: u16,
    protocol: ProtocolRange,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Request {
    Hello {
        hello: ClientHello,
    },
    Ensure {
        request: EnsureRuntime,
    },
    SyncCatalog {
        revision: u64,
    },
    List,
    Attach {
        runtime_id: String,
        last_ack_seq: u64,
    },
    Poll {
        runtime: RuntimeRef,
        last_ack_seq: u64,
    },
    Ack {
        runtime: RuntimeRef,
        seq: u64,
    },
    Detach {
        runtime: RuntimeRef,
    },
    Intent {
        runtime: RuntimeRef,
        payload: Vec<u8>,
    },
    Stop {
        runtime: RuntimeRef,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Response {
    Welcome {
        welcome: ProtocolWelcome,
    },
    Runtime {
        runtime: RuntimeRef,
    },
    Runtimes {
        runtimes: Vec<(RuntimeRef, RuntimeStatus)>,
    },
    Replay {
        replay: AttachReplay,
    },
    Ok,
    Error {
        code: String,
    },
}

pub struct ResidentServer {
    endpoint: SocketAddr,
    endpoint_path: PathBuf,
    shutdown: Arc<AtomicBool>,
    connections: Arc<Mutex<Vec<TcpStream>>>,
    client_threads: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ResidentServer {
    pub fn start(
        state_dir: impl Into<PathBuf>,
        token: AuthToken,
        supervisor_version: impl Into<String>,
        supervisor: Arc<Supervisor>,
    ) -> Result<Self> {
        let state_dir = state_dir.into();
        fs::create_dir_all(&state_dir)?;
        owner_only_dir(&state_dir)?;
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let endpoint = listener.local_addr()?;
        let endpoint_path = state_dir.join("resident-endpoint.json");
        write_endpoint(
            &endpoint_path,
            &EndpointRecord {
                schema_version: ENDPOINT_SCHEMA,
                pid: std::process::id(),
                port: endpoint.port(),
                protocol: ProtocolRange::supervisor(),
            },
        )?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let connections = Arc::new(Mutex::new(Vec::new()));
        let client_threads = Arc::new(Mutex::new(Vec::new()));
        let thread_shutdown = shutdown.clone();
        let thread_connections = connections.clone();
        let thread_clients = client_threads.clone();
        let thread_version = supervisor_version.into();
        let thread_path = endpoint_path.clone();
        let thread = thread::Builder::new()
            .name("tabverse-resident-listener".into())
            .spawn(move || {
                while !thread_shutdown.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            if let Ok(shutdown_stream) = stream.try_clone() {
                                thread_connections.lock().unwrap().push(shutdown_stream);
                            }
                            let supervisor = supervisor.clone();
                            let version = thread_version.clone();
                            if let Ok(client) = thread::Builder::new()
                                .name("tabverse-resident-client".into())
                                .spawn(move || handle_client(stream, token, &version, supervisor))
                            {
                                thread_clients.lock().unwrap().push(client);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
                remove_own_endpoint(&thread_path, std::process::id());
            })?;
        Ok(Self {
            endpoint,
            endpoint_path,
            shutdown,
            connections,
            client_threads,
            thread: Some(thread),
        })
    }

    pub fn endpoint(&self) -> SocketAddr {
        self.endpoint
    }

    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.endpoint);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        for stream in self.connections.lock().unwrap().drain(..) {
            let _ = stream.shutdown(Shutdown::Both);
        }
        for client in self.client_threads.lock().unwrap().drain(..) {
            let _ = client.join();
        }
        remove_own_endpoint(&self.endpoint_path, std::process::id());
    }
}

impl Drop for ResidentServer {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct ResidentClient {
    stream: Mutex<TcpStream>,
    pub welcome: ProtocolWelcome,
}

impl ResidentClient {
    pub fn connect(
        state_dir: impl AsRef<Path>,
        token: AuthToken,
        app_version: impl Into<String>,
        protocol: ProtocolRange,
    ) -> Result<Self> {
        let endpoint_path = state_dir.as_ref().join("resident-endpoint.json");
        let record: EndpointRecord = serde_json::from_slice(
            &fs::read(&endpoint_path)
                .with_context(|| format!("read resident endpoint {}", endpoint_path.display()))?,
        )?;
        if record.schema_version != ENDPOINT_SCHEMA || record.protocol.negotiate(protocol).is_none()
        {
            bail!("resident-endpoint-incompatible")
        }
        let endpoint = SocketAddr::from(([127, 0, 0, 1], record.port));
        let mut stream = TcpStream::connect_timeout(&endpoint, Duration::from_secs(3))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        send_wire(
            &mut stream,
            &Request::Hello {
                hello: ClientHello {
                    protocol,
                    app_version: app_version.into(),
                    token: token.ipc_bytes(),
                },
            },
        )?;
        let welcome = match recv_wire::<Response>(&mut stream)? {
            Response::Welcome { welcome } => welcome,
            Response::Error { code } => bail!(code),
            _ => bail!("resident-handshake-invalid"),
        };
        stream.set_read_timeout(Some(Duration::from_secs(30)))?;
        Ok(Self {
            stream: Mutex::new(stream),
            welcome,
        })
    }

    pub fn ensure_runtime(&self, request: EnsureRuntime) -> Result<RuntimeRef> {
        match self.call(Request::Ensure { request })? {
            Response::Runtime { runtime } => Ok(runtime),
            _ => bail!("resident-response-invalid"),
        }
    }

    pub fn sync_catalog_revision(&self, revision: u64) -> Result<()> {
        self.expect_ok(Request::SyncCatalog { revision })
    }

    pub fn list(&self) -> Result<Vec<(RuntimeRef, RuntimeStatus)>> {
        match self.call(Request::List)? {
            Response::Runtimes { runtimes } => Ok(runtimes),
            _ => bail!("resident-response-invalid"),
        }
    }

    pub fn attach(&self, runtime_id: String, last_ack_seq: u64) -> Result<AttachReplay> {
        match self.call(Request::Attach {
            runtime_id,
            last_ack_seq,
        })? {
            Response::Replay { replay } => Ok(replay),
            _ => bail!("resident-response-invalid"),
        }
    }

    pub fn ack(&self, runtime: RuntimeRef, seq: u64) -> Result<()> {
        self.expect_ok(Request::Ack { runtime, seq })
    }

    pub fn poll(&self, runtime: RuntimeRef, last_ack_seq: u64) -> Result<AttachReplay> {
        match self.call(Request::Poll {
            runtime,
            last_ack_seq,
        })? {
            Response::Replay { replay } => Ok(replay),
            _ => bail!("resident-response-invalid"),
        }
    }

    pub fn detach(&self, runtime: RuntimeRef) -> Result<RuntimeRef> {
        match self.call(Request::Detach { runtime })? {
            Response::Runtime { runtime } => Ok(runtime),
            _ => bail!("resident-response-invalid"),
        }
    }

    pub fn send_intent(&self, runtime: RuntimeRef, payload: Vec<u8>) -> Result<()> {
        self.expect_ok(Request::Intent { runtime, payload })
    }

    pub fn stop(&self, runtime: RuntimeRef) -> Result<()> {
        self.expect_ok(Request::Stop { runtime })
    }

    fn expect_ok(&self, request: Request) -> Result<()> {
        match self.call(request)? {
            Response::Ok => Ok(()),
            _ => bail!("resident-response-invalid"),
        }
    }

    fn call(&self, request: Request) -> Result<Response> {
        let mut stream = self.stream.lock().unwrap();
        send_wire(&mut stream, &request)?;
        match recv_wire(&mut stream)? {
            Response::Error { code } => bail!(code),
            response => Ok(response),
        }
    }
}

fn handle_client(
    mut stream: TcpStream,
    token: AuthToken,
    supervisor_version: &str,
    supervisor: Arc<Supervisor>,
) {
    // Accepted sockets inherit O_NONBLOCK from the listener on macOS.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let first = match recv_wire::<Request>(&mut stream) {
        Ok(Request::Hello { hello }) => hello,
        _ => {
            let _ = send_wire(
                &mut stream,
                &Response::Error {
                    code: "resident-auth-denied".into(),
                },
            );
            return;
        }
    };
    let welcome = match authenticate_hello(token, &first, supervisor_version) {
        Ok(welcome) => welcome,
        Err(_) => {
            let _ = send_wire(
                &mut stream,
                &Response::Error {
                    code: "resident-auth-denied".into(),
                },
            );
            return;
        }
    };
    if send_wire(&mut stream, &Response::Welcome { welcome }).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(None);
    loop {
        let request = match recv_wire::<Request>(&mut stream) {
            Ok(request) => request,
            Err(error) => {
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_none_or(|io| io.kind() != std::io::ErrorKind::UnexpectedEof)
                {
                    eprintln!("[resident] client frame rejected: {error}");
                }
                break;
            }
        };
        let response = dispatch(&supervisor, request).unwrap_or_else(|error| Response::Error {
            code: stable_code(&error),
        });
        if send_wire(&mut stream, &response).is_err() {
            break;
        }
    }
}

fn dispatch(supervisor: &Supervisor, request: Request) -> Result<Response> {
    match request {
        Request::Hello { .. } => bail!("resident-handshake-already-complete"),
        Request::Ensure { request } => Ok(Response::Runtime {
            runtime: supervisor.ensure_runtime(request)?,
        }),
        Request::SyncCatalog { revision } => {
            supervisor.sync_catalog_revision(revision)?;
            Ok(Response::Ok)
        }
        Request::List => Ok(Response::Runtimes {
            runtimes: supervisor.list(),
        }),
        Request::Attach {
            runtime_id,
            last_ack_seq,
        } => Ok(Response::Replay {
            replay: supervisor.attach(&runtime_id, last_ack_seq)?,
        }),
        Request::Poll {
            runtime,
            last_ack_seq,
        } => Ok(Response::Replay {
            replay: supervisor.poll(&runtime, last_ack_seq)?,
        }),
        Request::Ack { runtime, seq } => {
            supervisor.ack(&runtime, seq)?;
            Ok(Response::Ok)
        }
        Request::Detach { runtime } => Ok(Response::Runtime {
            runtime: supervisor.detach(&runtime)?,
        }),
        Request::Intent { runtime, payload } => {
            supervisor.send_intent(&runtime, &payload)?;
            Ok(Response::Ok)
        }
        Request::Stop { runtime } => {
            supervisor.stop(&runtime)?;
            Ok(Response::Ok)
        }
    }
}

fn stable_code(error: &anyhow::Error) -> String {
    error
        .to_string()
        .split(':')
        .next()
        .filter(|code| code.starts_with("resident-"))
        .unwrap_or("resident-request-failed")
        .to_string()
}

fn send_wire<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_WIRE_BYTES {
        bail!("resident-frame-too-large")
    }
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}

fn recv_wire<T: DeserializeOwned>(stream: &mut TcpStream) -> Result<T> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_WIRE_BYTES {
        bail!("resident-frame-too-large")
    }
    let mut bytes = vec![0u8; length];
    stream.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(Into::into)
}

fn write_endpoint(path: &Path, record: &EndpointRecord) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("resident endpoint has no parent"))?;
    let temp = parent.join(format!(".resident-endpoint-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    file.write_all(&serde_json::to_vec(record)?)?;
    file.sync_all()?;
    owner_only_file(&temp)?;
    fs::rename(&temp, path)?;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn remove_own_endpoint(path: &Path, pid: u32) {
    let ours = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<EndpointRecord>(&bytes).ok())
        .is_some_and(|record| record.pid == pid);
    if ours {
        let _ = fs::remove_file(path);
    }
}

#[cfg(unix)]
fn owner_only_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn owner_only_dir(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn owner_only_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn owner_only_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ArtifactVerifier, RunningWorker, SignatureVerifier, SpawnedWorker, WorkerContext,
        WorkerFactory,
    };
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Instant;

    struct Signature;
    impl SignatureVerifier for Signature {
        fn verify(&self, descriptor: &crate::RuntimeDescriptor, digest: &[u8]) -> Result<()> {
            (descriptor.signature == format!("fixture:{}", hex::encode(digest)))
                .then_some(())
                .ok_or_else(|| anyhow!("invalid"))
        }
    }

    struct Worker(AtomicBool, Arc<AtomicUsize>);
    impl RunningWorker for Worker {
        fn send(&self, _: &[u8]) -> Result<()> {
            self.1.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn terminate(&self) -> Result<()> {
            self.0.store(false, Ordering::SeqCst);
            Ok(())
        }
        fn is_alive(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct Factory(Arc<AtomicUsize>);
    impl WorkerFactory for Factory {
        fn spawn(&self, _: WorkerContext) -> Result<SpawnedWorker> {
            let (_output, receiver) = std::sync::mpsc::channel();
            Ok(SpawnedWorker {
                worker: Arc::new(Worker(AtomicBool::new(true), self.0.clone())),
                output: receiver,
            })
        }
    }

    fn wait_for_endpoint(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !path.join("resident-endpoint.json").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(path.join("resident-endpoint.json").exists());
    }

    #[test]
    fn authenticated_real_ipc_negotiates_and_keeps_old_leases_out() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("ipc");
        let artifact = dir.path().join("worker-source");
        fs::write(&artifact, b"resident-ipc-worker").unwrap();
        let hash = hex::encode(Sha256::digest(b"resident-ipc-worker"));
        let sends = Arc::new(AtomicUsize::new(0));
        let supervisor = Arc::new(
            Supervisor::open(
                dir.path().join("resident"),
                ArtifactVerifier::new(Arc::new(Signature)),
                Arc::new(Factory(sends.clone())),
            )
            .unwrap(),
        );
        let token = AuthToken::new([0x42; 32]);
        let mut server = ResidentServer::start(&state_dir, token, "2.0.0", supervisor).unwrap();
        wait_for_endpoint(&state_dir);
        let client =
            ResidentClient::connect(&state_dir, token, "1.0.0", ProtocolRange { min: 1, max: 1 })
                .unwrap();
        assert_eq!(client.welcome.protocol, 1);
        let created = client
            .ensure_runtime(EnsureRuntime {
                tab_id: "tab-ipc".into(),
                kind: "fixture".into(),
                descriptor: crate::RuntimeDescriptor {
                    plugin_id: "tabverse.fixture".into(),
                    plugin_version: "1.0.0".into(),
                    artifact_hash: hash.clone(),
                    entrypoint: "worker".into(),
                    permissions: vec![],
                    protocol_range: ProtocolRange::supervisor(),
                    signature: format!("fixture:{hash}"),
                },
                artifact_source: artifact,
                expected_catalog_revision: 0,
                request_id: "ipc-request".into(),
                initial_checkpoint: serde_json::json!({}),
            })
            .unwrap();
        assert_eq!(client.list().unwrap().len(), 1);
        let attached = client
            .attach(created.runtime_id.clone(), 0)
            .unwrap()
            .runtime;
        assert!(client.send_intent(created, b"stale".to_vec()).is_err());
        client
            .send_intent(attached.clone(), b"current".to_vec())
            .unwrap();
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        client.stop(attached).unwrap();
        server.stop();
        assert!(!state_dir.join("resident-endpoint.json").exists());
    }

    #[test]
    fn wrong_token_and_future_client_learn_no_supervisor_details() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("ipc");
        let supervisor = Arc::new(
            Supervisor::open(
                dir.path().join("resident"),
                ArtifactVerifier::new(Arc::new(Signature)),
                Arc::new(Factory(Arc::new(AtomicUsize::new(0)))),
            )
            .unwrap(),
        );
        let token = AuthToken::new([1; 32]);
        let _server =
            ResidentServer::start(&state_dir, token, "secret-version", supervisor).unwrap();
        wait_for_endpoint(&state_dir);
        let wrong = ResidentClient::connect(
            &state_dir,
            AuthToken::new([2; 32]),
            "client",
            ProtocolRange::supervisor(),
        )
        .err()
        .unwrap()
        .to_string();
        assert_eq!(wrong, "resident-auth-denied");
        let future = ResidentClient::connect(
            &state_dir,
            token,
            "future",
            ProtocolRange { min: 3, max: 3 },
        )
        .err()
        .unwrap()
        .to_string();
        assert_eq!(future, "resident-endpoint-incompatible");
        assert!(!wrong.contains("secret-version"));
    }
}
