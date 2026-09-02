//! Resident terminal helper process mode and lazy GUI connection.

use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tabverse_term::{
    client::{HelperClient, HelperEventCallback},
    helper::HelperServer,
    protocol::AuthToken,
};
use tauri::AppHandle;
use zeroize::Zeroizing;

const ENDPOINT_FILE: &str = "terminal-helper.json";
const CONNECT_DEADLINE: Duration = Duration::from_secs(5);
const DEFAULT_IDLE: Duration = Duration::from_secs(30);
const CAPABILITIES: u64 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct EndpointRecord {
    version: u8,
    pid: u32,
    port: u16,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResidentEndpointRecord {
    schema_version: u16,
    runtime_id: String,
    tab_id: String,
    pid: u32,
    port: u16,
    token_hex: String,
}

pub struct TerminalHelper {
    client: Mutex<Option<Arc<HelperClient>>>,
    resident_clients: Mutex<HashMap<String, Arc<HelperClient>>>,
    session_clients: Mutex<HashMap<String, Arc<HelperClient>>>,
}

impl Default for TerminalHelper {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalHelper {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            resident_clients: Mutex::new(HashMap::new()),
            session_clients: Mutex::new(HashMap::new()),
        }
    }

    pub fn ensure(
        &self,
        app: &AppHandle,
        on_event: HelperEventCallback,
    ) -> Result<Arc<HelperClient>, String> {
        if let Some(client) = self.client.lock().unwrap().as_ref() {
            if client.is_alive() {
                return Ok(Arc::clone(client));
            }
        }
        let state = crate::state_dir(app)?;
        let token_bytes = Zeroizing::new(crate::credentials::helper_token()?);
        let token = AuthToken::new(*token_bytes);
        if let Ok(client) = connect_record(&state, token, Arc::clone(&on_event)) {
            let client = Arc::new(client);
            *self.client.lock().unwrap() = Some(Arc::clone(&client));
            return Ok(client);
        }

        let executable = std::env::current_exe().map_err(|e| format!("helper executable: {e}"))?;
        let mut child = Command::new(executable)
            .arg("--helper")
            .arg(&state)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("start terminal helper: {e}"))?;
        let write_result = child
            .stdin
            .take()
            .ok_or_else(|| "terminal helper stdin pipe is missing".to_string())
            .and_then(|mut stdin| {
                stdin
                    .write_all(token_bytes.as_ref())
                    .and_then(|()| stdin.flush())
                    .map_err(|e| format!("send terminal helper token: {e}"))
            });
        if let Err(error) = write_result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        let deadline = Instant::now() + CONNECT_DEADLINE;
        let mut last_error = "helper endpoint did not appear".to_string();
        while Instant::now() < deadline {
            match connect_record(&state, token, Arc::clone(&on_event)) {
                Ok(client) => {
                    let client = Arc::new(client);
                    *self.client.lock().unwrap() = Some(Arc::clone(&client));
                    return Ok(client);
                }
                Err(error) => last_error = error,
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err(format!(
            "terminal helper did not become ready: {last_error}"
        ))
    }

    pub fn ensure_resident(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        on_event: HelperEventCallback,
    ) -> Result<Arc<HelperClient>, String> {
        validate_runtime_id(runtime_id)?;
        if let Some(client) = self.resident_clients.lock().unwrap().get(runtime_id) {
            if client.is_alive() {
                return Ok(Arc::clone(client));
            }
        }
        let path = crate::state_dir(app)?
            .join("resident/runtime-endpoints")
            .join(format!("{runtime_id}.json"));
        let deadline = Instant::now() + CONNECT_DEADLINE;
        let mut last_error = "resident terminal endpoint did not appear".to_string();
        while Instant::now() < deadline {
            match connect_resident_record(&path, runtime_id, Arc::clone(&on_event)) {
                Ok(client) => {
                    let client = Arc::new(client);
                    self.resident_clients
                        .lock()
                        .unwrap()
                        .insert(runtime_id.to_string(), Arc::clone(&client));
                    return Ok(client);
                }
                Err(error) => last_error = error,
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err(format!(
            "resident terminal worker did not become ready: {last_error}"
        ))
    }

    pub fn register_session(&self, id: &str, client: Arc<HelperClient>) {
        self.session_clients
            .lock()
            .unwrap()
            .insert(id.to_string(), client);
    }

    pub fn session(&self, id: &str) -> Option<Arc<HelperClient>> {
        self.session_clients
            .lock()
            .unwrap()
            .get(id)
            .filter(|client| client.is_alive())
            .cloned()
    }

    pub fn forget_session(&self, id: &str) {
        self.session_clients.lock().unwrap().remove(id);
    }
}

fn connect_resident_record(
    path: &Path,
    expected_runtime_id: &str,
    on_event: HelperEventCallback,
) -> Result<HelperClient, String> {
    owner_only(path)?;
    let bytes = fs::read(path).map_err(|e| format!("read resident terminal endpoint: {e}"))?;
    let record: ResidentEndpointRecord = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse resident terminal endpoint: {e}"))?;
    if record.schema_version != 1 || record.runtime_id != expected_runtime_id {
        return Err("resident terminal endpoint has a different identity".into());
    }
    let token: [u8; 32] = hex::decode(&record.token_hex)
        .map_err(|_| "resident terminal token is invalid".to_string())?
        .try_into()
        .map_err(|_| "resident terminal token has the wrong length".to_string())?;
    let endpoint = SocketAddr::from(([127, 0, 0, 1], record.port));
    let (client, _, _) =
        HelperClient::connect(endpoint, AuthToken::new(token), rand::random(), on_event)
            .map_err(|e| e.to_string())?;
    Ok(client)
}

fn validate_runtime_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("resident terminal runtime id is invalid".into());
    }
    Ok(())
}

#[cfg(unix)]
fn owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)
        .map_err(|e| format!("inspect resident terminal endpoint: {e}"))?
        .permissions()
        .mode()
        & 0o777;
    if mode & 0o077 != 0 {
        return Err("resident terminal endpoint permissions are not owner-only".into());
    }
    Ok(())
}

#[cfg(not(unix))]
fn owner_only(path: &Path) -> Result<(), String> {
    fs::metadata(path)
        .map(|_| ())
        .map_err(|e| format!("inspect resident terminal endpoint: {e}"))
}

fn connect_record(
    state: &Path,
    token: AuthToken,
    on_event: HelperEventCallback,
) -> Result<HelperClient, String> {
    let record: EndpointRecord = serde_json::from_slice(
        &fs::read(state.join(ENDPOINT_FILE)).map_err(|e| format!("read helper endpoint: {e}"))?,
    )
    .map_err(|e| format!("parse helper endpoint: {e}"))?;
    if record.version != tabverse_term::protocol::VERSION {
        return Err("helper endpoint has a different protocol version".into());
    }
    let endpoint = SocketAddr::from(([127, 0, 0, 1], record.port));
    let (client, _, _) = HelperClient::connect(endpoint, token, rand::random(), on_event)
        .map_err(|e| e.to_string())?;
    Ok(client)
}

/// Read the helper's one-time bootstrap token from an inherited anonymous
/// pipe. The exact-length check rejects accidental framing changes before a
/// terminal server starts.
fn read_helper_token(mut input: impl Read) -> io::Result<[u8; 32]> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(33));
    input.by_ref().take(33).read_to_end(&mut bytes)?;
    if bytes.len() != 32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("helper token has {} bytes, expected 32", bytes.len()),
        ));
    }
    let mut token = [0u8; 32];
    token.copy_from_slice(&bytes);
    Ok(token)
}

/// Answer `tabverse --helper <state-dir>` before Tauri or a webview exists.
pub fn from_args(mut args: impl Iterator<Item = String>) -> Option<i32> {
    if args.next().as_deref() != Some("--helper") {
        return None;
    }
    let Some(state) = args.next() else {
        return Some(2);
    };
    let state = PathBuf::from(state);
    let token_bytes = match read_helper_token(io::stdin().lock()) {
        Ok(token) => Zeroizing::new(token),
        Err(_) => return Some(3),
    };
    let token = AuthToken::new(*token_bytes);
    Some(run_helper(&state, token, DEFAULT_IDLE).unwrap_or(4))
}

fn run_helper(state: &Path, token: AuthToken, idle: Duration) -> io::Result<i32> {
    fs::create_dir_all(state)?;
    let server = HelperServer::start(token, rand::random(), CAPABILITIES, idle)?;
    let record = EndpointRecord {
        version: tabverse_term::protocol::VERSION,
        pid: std::process::id(),
        port: server.endpoint().port(),
    };
    write_endpoint(state, &record)?;
    while server.is_alive() {
        thread::sleep(Duration::from_millis(25));
    }
    remove_own_endpoint(state, record.pid);
    Ok(0)
}

fn write_endpoint(state: &Path, record: &EndpointRecord) -> io::Result<()> {
    let path = state.join(ENDPOINT_FILE);
    let temp = state.join(format!("{ENDPOINT_FILE}.tmp"));
    fs::write(&temp, serde_json::to_vec(record).map_err(io::Error::other)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temp, path)
}

fn remove_own_endpoint(state: &Path, pid: u32) {
    let path = state.join(ENDPOINT_FILE);
    let ours = fs::read(&path)
        .ok()
        .and_then(|data| serde_json::from_slice::<EndpointRecord>(&data).ok())
        .is_some_and(|record| record.pid == pid);
    if ours {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tabverse_term::protocol::Kind;

    #[test]
    fn helper_token_pipe_requires_exactly_32_bytes() {
        assert_eq!(
            read_helper_token(io::Cursor::new(vec![0x5a; 32])).unwrap(),
            [0x5a; 32]
        );
        assert_eq!(
            read_helper_token(io::Cursor::new(vec![0x5a; 31]))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            read_helper_token(io::Cursor::new(vec![0x5a; 33]))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn resident_runtime_id_cannot_escape_the_endpoint_directory() {
        for invalid in ["", "../runtime", "nested/runtime", "/runtime", "has space"] {
            assert!(validate_runtime_id(invalid).is_err(), "{invalid}");
        }
        for valid in ["runtime-1", "runtime_2", "runtime.3"] {
            validate_runtime_id(valid).unwrap();
        }
    }

    #[test]
    fn gui_is_the_only_helper_token_reader_and_the_child_stdin_is_piped() {
        let source = include_str!("terminal_helper.rs");
        let credential_read = ["credentials::", "helper_token()"].concat();
        let piped_stdin = [".stdin(Stdio::", "piped())"].concat();
        assert_eq!(
            source.matches(&credential_read).count(),
            1,
            "only TerminalHelper::ensure may read the cached bundle field"
        );
        assert!(source.contains(&piped_stdin));

        let helper_mode = source
            .split("pub fn from_args")
            .nth(1)
            .unwrap()
            .split("fn run_helper")
            .next()
            .unwrap();
        assert!(!helper_mode.contains("credentials::"));
        assert!(helper_mode.contains("read_helper_token(io::stdin().lock())"));
    }

    #[test]
    fn endpoint_file_is_owner_only_and_removed_by_its_owner() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().to_path_buf();
        let token = AuthToken::new([0x77; 32]);
        let helper_state = state.clone();
        let helper =
            thread::spawn(move || run_helper(&helper_state, token, Duration::from_millis(80)));
        let endpoint = state.join(ENDPOINT_FILE);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !endpoint.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(endpoint.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&endpoint).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let client = connect_record(&state, token, Arc::new(|_| {})).unwrap();
        client
            .request(
                &tabverse_term::protocol::Frame::new(
                    Kind::List,
                    tabverse_term::protocol::SessionId::default(),
                    0,
                    vec![],
                ),
                Kind::List,
                None,
                Duration::from_secs(1),
            )
            .unwrap();
        drop(client);
        assert_eq!(helper.join().unwrap().unwrap(), 0);
        assert!(
            !endpoint.exists(),
            "only the helper that wrote the file removes it"
        );
    }
}
