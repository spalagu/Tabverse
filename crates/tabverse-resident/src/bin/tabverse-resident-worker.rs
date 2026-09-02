use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tabverse_remote::{join, RemoteHostMsg};
use tabverse_resident::WorkerOutput;
use tabverse_term::{helper::HelperServer, protocol::AuthToken};
use zeroize::Zeroizing;

const CAPABILITIES: u64 = 1;
const IDLE_TIMEOUT: Duration = Duration::from_secs(365 * 24 * 60 * 60);
const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalEndpoint {
    schema_version: u16,
    runtime_id: String,
    tab_id: String,
    pid: u32,
    port: u16,
    token_hex: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Tabverse resident worker failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let kind = parse_kind(env::args().skip(1))?;
    match kind.as_str() {
        "terminal" => run_terminal(worker_environment()?),
        "remote" => run_remote(worker_environment()?),
        "browser-network" => run_browser_network(worker_environment()?),
        _ => bail!("resident-worker-kind-unsupported"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum RemoteInput {
    Initialize {
        checkpoint: serde_json::Value,
    },
    Input {
        data_b64: String,
    },
    Viewport {
        cols: u16,
        rows: u16,
    },
    Ping,
    Leave,
    BrowserOpen {
        request_id: String,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body_b64: Option<String>,
        grant_origin: String,
        grant_expires_at_ms: u64,
        pinned_addrs: Vec<String>,
    },
    BrowserCancel {
        request_id: String,
    },
}

fn run_browser_network(environment: WorkerEnvironment) -> Result<()> {
    validate_id(&environment.runtime_id)?;
    validate_id(&environment.tab_id)?;
    let stdin = io::stdin();
    {
        let mut locked = stdin.lock();
        if !matches!(read_input(&mut locked)?, RemoteInput::Initialize { .. }) {
            bail!("resident-worker-initialize-required")
        }
    }
    let (input_tx, input_rx) = tokio::sync::mpsc::unbounded_channel();
    thread::Builder::new()
        .name(format!(
            "tabverse-browser-network-input-{}",
            environment.runtime_id
        ))
        .spawn(move || {
            let mut locked = stdin.lock();
            while let Ok(input) = read_input(&mut locked) {
                if input_tx.send(input).is_err() {
                    break;
                }
            }
        })?;
    let output = Arc::new(Mutex::new(io::stdout()));
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(browser_network_loop(output, input_rx))
}

async fn browser_network_loop(
    output: Arc<Mutex<io::Stdout>>,
    mut inputs: tokio::sync::mpsc::UnboundedReceiver<RemoteInput>,
) -> Result<()> {
    const MAX_CONCURRENT_REQUESTS: usize = 64;
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut tasks = std::collections::HashMap::<String, tokio::task::AbortHandle>::new();
    loop {
        tokio::select! {
            input = inputs.recv() => {
                let Some(input) = input else {
                    for (_, handle) in tasks.drain() {
                        handle.abort();
                    }
                    return Ok(());
                };
                match input {
                    RemoteInput::BrowserOpen {
                        request_id,
                        method,
                        url,
                        headers,
                        body_b64,
                        grant_origin,
                        grant_expires_at_ms,
                        pinned_addrs,
                    } => {
                        if tasks.contains_key(&request_id) {
                            write_browser_error(
                                &output,
                                &request_id,
                                "browser-network-duplicate-request",
                            )?;
                            continue;
                        }
                        if tasks.len() >= MAX_CONCURRENT_REQUESTS {
                            write_browser_error(
                                &output,
                                &request_id,
                                "browser-network-concurrency-limited",
                            )?;
                            continue;
                        }
                        let request = BrowserNetworkRequest {
                            request_id: request_id.clone(),
                            method,
                            url,
                            headers,
                            body_b64,
                            grant_origin,
                            grant_expires_at_ms,
                            pinned_addrs,
                        };
                        let task_output = Arc::clone(&output);
                        let finished = done_tx.clone();
                        let finished_id = request_id.clone();
                        let task = tokio::spawn(async move {
                            if let Err(error) =
                                execute_browser_request(Arc::clone(&task_output), request).await
                            {
                                let code = error
                                    .to_string()
                                    .split(':')
                                    .next()
                                    .unwrap_or("browser-network-failed")
                                    .to_string();
                                let _ = write_browser_error(&task_output, &finished_id, &code);
                            }
                            let _ = finished.send(finished_id);
                        });
                        tasks.insert(request_id, task.abort_handle());
                    }
                    RemoteInput::BrowserCancel { request_id } => {
                        if let Some(handle) = tasks.remove(&request_id) {
                            if !handle.is_finished() {
                                handle.abort();
                                write_browser_error(
                                    &output,
                                    &request_id,
                                    "browser-network-cancelled",
                                )?;
                            }
                        }
                    }
                    RemoteInput::Leave => {
                        for (_, handle) in tasks.drain() {
                            handle.abort();
                        }
                        return Ok(());
                    }
                    _ => {}
                }
            }
            Some(request_id) = done_rx.recv() => {
                tasks.remove(&request_id);
            }
        }
    }
}

struct BrowserNetworkRequest {
    request_id: String,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
    grant_origin: String,
    grant_expires_at_ms: u64,
    pinned_addrs: Vec<String>,
}

async fn execute_browser_request(
    output: Arc<Mutex<io::Stdout>>,
    request: BrowserNetworkRequest,
) -> Result<()> {
    const RESPONSE_LIMIT: usize = 64 * 1024 * 1024;
    const CHUNK_BYTES: usize = 64 * 1024;
    let BrowserNetworkRequest {
        request_id,
        method,
        url,
        headers,
        body_b64,
        grant_origin,
        grant_expires_at_ms,
        pinned_addrs,
    } = request;
    let target = reqwest::Url::parse(&url).context("parse browser resident URL")?;
    let origin = normalized_origin(&target)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;
    if origin != grant_origin || now_ms > grant_expires_at_ms {
        bail!("browser-network-grant-denied")
    }
    if !matches!(target.scheme(), "http" | "https") {
        bail!("browser-network-scheme-denied")
    }
    let host = target
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("browser-network-host-missing"))?;
    let port = target
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("browser-network-port-missing"))?;
    let addrs = pinned_addrs
        .iter()
        .map(|value| value.parse::<std::net::SocketAddr>())
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if addrs.is_empty()
        || addrs
            .iter()
            .any(|address| address.port() != port || prohibited_worker_address(address.ip()))
    {
        bail!("browser-network-pinned-address-denied")
    }
    let client = tabverse_resident::http::build_pinned(host, &addrs)?;
    let method = reqwest::Method::from_bytes(method.as_bytes())?;
    let mut outgoing = client.request(method, target);
    for (name, value) in headers {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host" | "connection" | "proxy-connection" | "transfer-encoding"
        ) {
            continue;
        }
        outgoing = outgoing.header(&name, &value);
    }
    if let Some(body) = body_b64 {
        outgoing = outgoing.body(data_encoding::BASE64.decode(body.as_bytes())?);
    }
    let mut response = outgoing.send().await?;
    let response_headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect::<Vec<_>>();
    write_output(
        &mut *output.lock().unwrap(),
        &WorkerOutput::Event {
            payload: serde_json::json!({
                "type": "browserResponseHead",
                "requestId": request_id,
                "status": response.status().as_u16(),
                "headers": response_headers,
            }),
        },
    )?;
    let mut total = 0usize;
    let mut seq = 0u64;
    while let Some(chunk) = response.chunk().await? {
        total = total.saturating_add(chunk.len());
        if total > RESPONSE_LIMIT {
            bail!("browser-network-response-too-large")
        }
        for piece in chunk.chunks(CHUNK_BYTES) {
            write_output(
                &mut *output.lock().unwrap(),
                &WorkerOutput::Event {
                    payload: serde_json::json!({
                        "type": "browserResponseChunk",
                        "requestId": request_id,
                        "seq": seq,
                        "b64": data_encoding::BASE64.encode(piece),
                    }),
                },
            )?;
            seq = seq.saturating_add(1);
        }
    }
    write_output(
        &mut *output.lock().unwrap(),
        &WorkerOutput::Event {
            payload: serde_json::json!({
                "type": "browserResponseEnd",
                "requestId": request_id,
            }),
        },
    )?;
    Ok(())
}

fn write_browser_error(
    output: &Arc<Mutex<io::Stdout>>,
    request_id: &str,
    code: &str,
) -> Result<()> {
    write_output(
        &mut *output.lock().unwrap(),
        &WorkerOutput::Event {
            payload: serde_json::json!({
                "type": "browserResponseError",
                "requestId": request_id,
                "code": code,
            }),
        },
    )
}

fn normalized_origin(url: &reqwest::Url) -> Result<String> {
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("browser-network-host-missing"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("browser-network-port-missing"))?;
    Ok(format!(
        "{}://{}:{port}",
        url.scheme(),
        host.to_ascii_lowercase()
    ))
}

fn prohibited_worker_address(ip: std::net::IpAddr) -> bool {
    if ip.is_unspecified() || ip.is_multicast() {
        return true;
    }
    match ip {
        std::net::IpAddr::V4(ip) => {
            ip.is_link_local()
                || ip.is_broadcast()
                || ip == std::net::Ipv4Addr::new(169, 254, 169, 254)
                || ip == std::net::Ipv4Addr::new(100, 100, 100, 200)
        }
        std::net::IpAddr::V6(ip) => {
            ip.is_unicast_link_local()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| prohibited_worker_address(std::net::IpAddr::V4(mapped)))
        }
    }
}

fn run_remote(environment: WorkerEnvironment) -> Result<()> {
    validate_id(&environment.runtime_id)?;
    validate_id(&environment.tab_id)?;
    let stdin = io::stdin();
    let initial: RemoteInput = {
        let mut locked = stdin.lock();
        read_input(&mut locked)?
    };
    let RemoteInput::Initialize { checkpoint } = initial else {
        bail!("resident-worker-initialize-required")
    };
    let ticket = checkpoint
        .get("joinTicket")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("resident-remote-ticket-missing"))?
        .to_string();
    let (input_tx, input_rx) = tokio::sync::mpsc::unbounded_channel();
    thread::Builder::new()
        .name(format!(
            "tabverse-resident-input-{}",
            environment.runtime_id
        ))
        .spawn(move || {
            let mut locked = stdin.lock();
            while let Ok(input) = read_input(&mut locked) {
                if input_tx.send(input).is_err() {
                    break;
                }
            }
        })?;
    let output = Arc::new(Mutex::new(io::stdout()));
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(remote_loop(ticket, output, input_rx))
}

async fn remote_loop(
    ticket: String,
    output: Arc<Mutex<io::Stdout>>,
    mut inputs: tokio::sync::mpsc::UnboundedReceiver<RemoteInput>,
) -> Result<()> {
    let mut attempt = 0u32;
    loop {
        let (ended_tx, mut ended_rx) = tokio::sync::mpsc::unbounded_channel();
        let event_output = Arc::clone(&output);
        let handle = match join(
            &ticket,
            "tabverse-resident",
            Arc::new(move |message| {
                if let RemoteHostMsg::End { reason } = &message {
                    let _ = ended_tx.send(reason.clone());
                }
                if let Ok(payload) = serde_json::to_value(message) {
                    let _ = write_output(
                        &mut *event_output.lock().unwrap(),
                        &WorkerOutput::Event { payload },
                    );
                }
            }),
        )
        .await
        {
            Ok(handle) => {
                attempt = 0;
                handle
            }
            Err(error) => {
                let message = format!("{error:#}");
                if permanent_join_error(&message) {
                    write_output(
                        &mut *output.lock().unwrap(),
                        &WorkerOutput::Event {
                            payload: serde_json::json!({
                                "type": "end",
                                "reason": message,
                            }),
                        },
                    )?;
                    return Ok(());
                }
                attempt = attempt.saturating_add(1);
                write_output(
                    &mut *output.lock().unwrap(),
                    &WorkerOutput::Event {
                        payload: serde_json::json!({
                            "type": "end",
                            "reason": format!("connection lost: {message}"),
                        }),
                    },
                )?;
                tokio::time::sleep(reconnect_delay(attempt)).await;
                continue;
            }
        };

        loop {
            tokio::select! {
                ended = ended_rx.recv() => {
                    handle.leave().await;
                    match ended {
                        Some(reason) if reason.starts_with("connection lost:") => {
                            attempt = attempt.saturating_add(1);
                            tokio::time::sleep(reconnect_delay(attempt)).await;
                            break;
                        }
                        _ => return Ok(()),
                    }
                }
                input = inputs.recv() => match input {
                    Some(RemoteInput::Input { data_b64 }) => {
                        let bytes = data_encoding::BASE64
                            .decode(data_b64.as_bytes())
                            .context("decode remote resident input")?;
                        handle.send_input(&bytes);
                    }
                    Some(RemoteInput::Viewport { cols, rows }) => handle.send_resize(cols, rows),
                    Some(RemoteInput::Ping) => handle.ping(),
                    Some(RemoteInput::Leave) | None => {
                        handle.leave().await;
                        return Ok(());
                    }
                    Some(RemoteInput::Initialize { .. }) => {
                        bail!("resident-worker-already-initialized")
                    }
                    Some(RemoteInput::BrowserOpen { .. } | RemoteInput::BrowserCancel { .. }) => {
                        bail!("resident-worker-kind-mismatch")
                    }
                }
            }
        }
    }
}

fn permanent_join_error(message: &str) -> bool {
    message.to_ascii_lowercase().contains("ticket")
}

fn reconnect_delay(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.saturating_sub(1).min(5))
}

fn read_input(reader: &mut impl Read) -> Result<RemoteInput> {
    let mut length = [0u8; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_INPUT_BYTES {
        bail!("resident-worker-input-too-large")
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_output(writer: &mut impl Write, output: &WorkerOutput) -> Result<()> {
    let bytes = serde_json::to_vec(output)?;
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

#[derive(Debug)]
struct WorkerEnvironment {
    root: PathBuf,
    runtime_id: String,
    tab_id: String,
}

fn worker_environment() -> Result<WorkerEnvironment> {
    let root: PathBuf = required_env("TABVERSE_RESIDENT_ROOT")?.into();
    validate_supervisor_parent(&root)?;
    Ok(WorkerEnvironment {
        root,
        runtime_id: required_env("TABVERSE_RUNTIME_ID")?,
        tab_id: required_env("TABVERSE_TAB_ID")?,
    })
}

fn validate_supervisor_parent(root: &Path) -> Result<()> {
    let declared_parent: u32 = required_env("TABVERSE_RESIDENT_SUPERVISOR_PID")?
        .parse()
        .context("resident-worker-supervisor-pid-invalid")?;
    let (actual_parent, executable) = supervisor_parent()?;
    if declared_parent != actual_parent {
        bail!("resident-worker-supervisor-parent-mismatch")
    }
    #[cfg(debug_assertions)]
    if env::var("TABVERSE_RESIDENT_IN_PROCESS_TEST_PARENT").as_deref() == Ok("1") {
        return Ok(());
    }
    let slots = fs::canonicalize(root.join("slots"))
        .context("resident-worker-supervisor-slots-unavailable")?;
    let executable = fs::canonicalize(executable)
        .context("resident-worker-supervisor-executable-unavailable")?;
    let expected_name = if cfg!(windows) {
        "tabverse-resident-supervisor.exe"
    } else {
        "tabverse-resident-supervisor"
    };
    let actual_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !executable.starts_with(&slots) || !actual_name.eq_ignore_ascii_case(expected_name) {
        bail!("resident-worker-supervisor-parent-untrusted")
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn supervisor_parent() -> Result<(u32, PathBuf)> {
    let pid = unsafe { libc::getppid() } as u32;
    let executable = fs::read_link(format!("/proc/{pid}/exe"))
        .context("resident-worker-supervisor-parent-path-unavailable")?;
    Ok((pid, executable))
}

#[cfg(target_os = "macos")]
fn supervisor_parent() -> Result<(u32, PathBuf)> {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    let pid = unsafe { libc::getppid() } as u32;
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        bail!("resident-worker-supervisor-parent-path-unavailable")
    }
    buffer.truncate(length as usize);
    Ok((pid, PathBuf::from(OsString::from_vec(buffer))))
}

#[cfg(windows)]
fn supervisor_parent() -> Result<(u32, PathBuf)> {
    use std::{ffi::OsString, mem::size_of, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };

    let current_pid = std::process::id();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        bail!("resident-worker-supervisor-parent-unavailable")
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = None;
    let mut available = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while available {
        if entry.th32ProcessID == current_pid {
            found = Some(entry.th32ParentProcessID);
            break;
        }
        available = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    let pid =
        found.ok_or_else(|| anyhow::anyhow!("resident-worker-supervisor-parent-unavailable"))?;

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        bail!("resident-worker-supervisor-parent-path-unavailable")
    }
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    let queried =
        unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe { CloseHandle(handle) };
    if queried == 0 {
        bail!("resident-worker-supervisor-parent-path-unavailable")
    }
    buffer.truncate(length as usize);
    Ok((pid, PathBuf::from(OsString::from_wide(&buffer))))
}

fn required_env(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("resident-worker-env-missing:{name}"))
}

fn parse_kind(mut args: impl Iterator<Item = String>) -> Result<String> {
    if args.next().as_deref() != Some("--resident-worker") {
        bail!("--resident-worker is required")
    }
    let kind = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("resident worker kind is required"))?;
    if args.next().is_some() {
        bail!("unsupported resident worker argument")
    }
    Ok(kind)
}

fn run_terminal(environment: WorkerEnvironment) -> Result<()> {
    validate_id(&environment.runtime_id)?;
    validate_id(&environment.tab_id)?;
    let mut token = Zeroizing::new([0u8; 32]);
    getrandom::fill(token.as_mut())?;
    let server = HelperServer::start_resident(
        AuthToken::new(*token),
        rand_nonce()?,
        CAPABILITIES,
        IDLE_TIMEOUT,
    )?;
    let endpoints = environment.root.join("runtime-endpoints");
    fs::create_dir_all(&endpoints)?;
    owner_only_dir(&endpoints)?;
    let path = endpoints.join(format!("{}.json", environment.runtime_id));
    let endpoint = TerminalEndpoint {
        schema_version: 1,
        runtime_id: environment.runtime_id,
        tab_id: environment.tab_id,
        pid: std::process::id(),
        port: server.endpoint().port(),
        token_hex: hex::encode(token.as_ref()),
    };
    write_endpoint(&path, &endpoint)?;
    while server.is_alive() {
        thread::sleep(Duration::from_millis(25));
    }
    remove_own_endpoint(&path, endpoint.pid);
    Ok(())
}

fn rand_nonce() -> Result<[u8; 32]> {
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce)?;
    Ok(nonce)
}

fn validate_id(value: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("resident-worker-id-invalid")
    }
    Ok(())
}

fn write_endpoint(path: &Path, endpoint: &TerminalEndpoint) -> Result<()> {
    let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    fs::write(&temp, serde_json::to_vec(endpoint)?)?;
    owner_only_file(&temp)?;
    fs::rename(temp, path)?;
    Ok(())
}

fn remove_own_endpoint(path: &Path, pid: u32) {
    let ours = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<TerminalEndpoint>(&bytes).ok())
        .is_some_and(|endpoint| endpoint.pid == pid);
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

    #[test]
    fn arguments_and_ids_are_strict() {
        assert_eq!(
            parse_kind(["--resident-worker".into(), "terminal".into()].into_iter()).unwrap(),
            "terminal"
        );
        assert!(parse_kind(["--resident-worker".into()].into_iter()).is_err());
        assert!(parse_kind(["--helper".into(), "terminal".into()].into_iter()).is_err());
        for bad in ["", "../runtime", "runtime/id", "has space"] {
            assert!(validate_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn malformed_tickets_are_terminal_but_transport_failures_retry() {
        assert!(permanent_join_error("ticket base32 decode failed"));
        assert!(permanent_join_error("not a Tabverse ticket"));
        assert!(!permanent_join_error("connect timeout"));
        assert!(!permanent_join_error("connection reset"));
    }

    #[test]
    fn endpoint_is_owner_only_and_only_its_writer_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        let endpoint = TerminalEndpoint {
            schema_version: 1,
            runtime_id: "runtime-1".into(),
            tab_id: "tab-1".into(),
            pid: 41,
            port: 2345,
            token_hex: "00".repeat(32),
        };
        write_endpoint(&path, &endpoint).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        remove_own_endpoint(&path, 42);
        assert!(path.exists());
        remove_own_endpoint(&path, 41);
        assert!(!path.exists());
    }
}
