//! Resident terminal helper process mode and lazy GUI connection.

use std::{
    fs, io,
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

pub struct TerminalHelper {
    client: Mutex<Option<Arc<HelperClient>>>,
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
        let token = AuthToken::new(crate::credentials::helper_token()?);
        if let Ok(client) = connect_record(&state, token, Arc::clone(&on_event)) {
            let client = Arc::new(client);
            *self.client.lock().unwrap() = Some(Arc::clone(&client));
            return Ok(client);
        }

        let executable = std::env::current_exe().map_err(|e| format!("helper executable: {e}"))?;
        Command::new(executable)
            .arg("--helper")
            .arg(&state)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("start terminal helper: {e}"))?;

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

    pub fn current(&self) -> Option<Arc<HelperClient>> {
        self.client
            .lock()
            .unwrap()
            .as_ref()
            .filter(|client| client.is_alive())
            .cloned()
    }
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

/// Answer `tabverse --helper <state-dir>` before Tauri or a webview exists.
pub fn from_args(mut args: impl Iterator<Item = String>) -> Option<i32> {
    if args.next().as_deref() != Some("--helper") {
        return None;
    }
    let Some(state) = args.next() else {
        return Some(2);
    };
    let state = PathBuf::from(state);
    crate::credentials::set_vault_dir(state.clone());
    let token = match crate::credentials::helper_token() {
        Ok(token) => AuthToken::new(token),
        Err(_) => return Some(3),
    };
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
