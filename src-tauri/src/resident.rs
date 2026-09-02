use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tabverse_resident::{
    AttachReplay, AuthToken, EnsureRuntime, InstallArtifacts, InstallPlan, PlatformKind,
    ProtocolRange, ResidentClient, RuntimeDescriptor, RuntimeRef, RuntimeStatus,
};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::AppState;

static PACKAGED_ARTIFACT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct ResidentBridge {
    client: Mutex<Option<ResidentClient>>,
    install: Mutex<()>,
    prepared: Mutex<bool>,
    runtimes: Mutex<HashMap<String, RuntimeRef>>,
}

impl ResidentBridge {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            install: Mutex::new(()),
            prepared: Mutex::new(false),
            runtimes: Mutex::new(HashMap::new()),
        }
    }

    fn ensure_ready(&self, app: &AppHandle) -> Result<()> {
        let _install = self.install.lock().unwrap();
        if self.client.lock().unwrap().is_some() {
            return Ok(());
        }

        // Every newly installed App process stages its immutable control
        // plane once before attaching. If an older Supervisor still owns live
        // runtimes, connect to it without a restart; the staged slot is ready
        // for the next cold activation after those runtimes finish.
        let first_prepare = !*self.prepared.lock().unwrap();
        let staged_plan = if first_prepare {
            let plan = stage_control_plane(app)?;
            *self.prepared.lock().unwrap() = true;
            Some(plan)
        } else {
            None
        };
        // An already-running Supervisor owns live workers from its original
        // immutable slot. Updating resources stages the next control-plane
        // slot, but must not restart that owner during an App reinstall.
        if let Ok(client) = connect(app) {
            *self.client.lock().unwrap() = Some(client);
            return Ok(());
        }
        // A cached connection may have failed after initial preparation. In
        // that recovery path re-render the platform unit before activation.
        let plan = match staged_plan {
            Some(plan) => plan,
            None => stage_control_plane(app)?,
        };
        plan.activate_current_user()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut last = anyhow::anyhow!("resident-supervisor-not-ready");
        while Instant::now() < deadline {
            match connect(app) {
                Ok(client) => {
                    *self.client.lock().unwrap() = Some(client);
                    return Ok(());
                }
                Err(error) => last = error,
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err(last.context("resident-supervisor-not-ready"))
    }

    fn call<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce(&ResidentClient) -> Result<T>,
    ) -> Result<T> {
        self.ensure_ready(app)?;
        let mut client = self.client.lock().unwrap();
        let result = operation(client.as_ref().expect("resident client initialized"));
        if result.is_err() {
            // A broken connection must not be cached. Mutating calls are not
            // retried here: requestId makes ensure safe, but attach/stop need
            // the caller to observe the exact outcome before trying again.
            client.take();
        }
        result
    }

    fn remember(&self, runtime: RuntimeRef) -> RuntimeRef {
        self.runtimes
            .lock()
            .unwrap()
            .insert(runtime.runtime_id.clone(), runtime.clone());
        runtime
    }

    fn runtime(&self, runtime_id: &str) -> Result<RuntimeRef> {
        self.runtimes
            .lock()
            .unwrap()
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("resident-runtime-not-attached"))
    }

    pub fn browser_exchange(
        &self,
        app: &AppHandle,
        tab_id: &str,
        request: crate::remote_proxy::ResidentBrowserRequest,
    ) -> Option<Result<crate::remote_proxy::ResidentBrowserResponse, String>> {
        let runtime = self
            .runtimes
            .lock()
            .unwrap()
            .values()
            .find(|runtime| runtime.tab_id == tab_id && runtime.kind == "browser-network")
            .cloned()?;
        Some(
            self.browser_exchange_inner(app, runtime, request)
                .map_err(stable_error),
        )
    }

    fn browser_exchange_inner(
        &self,
        app: &AppHandle,
        runtime: RuntimeRef,
        request: crate::remote_proxy::ResidentBrowserRequest,
    ) -> Result<crate::remote_proxy::ResidentBrowserResponse> {
        let request_id = request.request_id.clone();
        let cancelled = std::sync::Arc::clone(&request.cancelled);
        let initial = self.call(app, |client| client.poll(runtime.clone(), 0))?;
        let mut cursor = initial
            .events
            .last()
            .map(|event| event.seq)
            .unwrap_or(initial.checkpoint_seq);
        let intent = serde_json::to_vec(&serde_json::json!({
            "type": "browserOpen",
            "requestId": request.request_id,
            "method": request.method,
            "url": request.url,
            "headers": request.headers,
            "bodyB64": request.body_b64,
            "grantOrigin": request.grant_origin,
            "grantExpiresAtMs": request.grant_expires_at_ms,
            "pinnedAddrs": request.pinned_addrs,
        }))?;
        self.call(app, |client| client.send_intent(runtime.clone(), intent))?;

        let deadline = Instant::now() + Duration::from_secs(125);
        let mut status = None;
        let mut headers = Vec::new();
        let mut body = Vec::new();
        let mut expected_seq = 0u64;
        while Instant::now() < deadline {
            if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                let cancel = serde_json::to_vec(&serde_json::json!({
                    "type": "browserCancel",
                    "requestId": request_id,
                }))?;
                self.call(app, |client| client.send_intent(runtime.clone(), cancel))?;
                bail!("resident-browser-cancelled")
            }
            let replay = self.call(app, |client| client.poll(runtime.clone(), cursor))?;
            for event in replay.events {
                cursor = cursor.max(event.seq);
                if event
                    .payload
                    .get("requestId")
                    .and_then(serde_json::Value::as_str)
                    != Some(request_id.as_str())
                {
                    continue;
                }
                match event
                    .payload
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                {
                    Some("browserResponseHead") => {
                        status = event
                            .payload
                            .get("status")
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|value| u16::try_from(value).ok());
                        headers = serde_json::from_value(
                            event.payload.get("headers").cloned().unwrap_or_default(),
                        )?;
                    }
                    Some("browserResponseChunk") => {
                        let seq = event
                            .payload
                            .get("seq")
                            .and_then(serde_json::Value::as_u64)
                            .ok_or_else(|| anyhow::anyhow!("resident-browser-chunk-invalid"))?;
                        if seq != expected_seq {
                            bail!("resident-browser-chunk-gap")
                        }
                        let b64 = event
                            .payload
                            .get("b64")
                            .and_then(serde_json::Value::as_str)
                            .ok_or_else(|| anyhow::anyhow!("resident-browser-chunk-invalid"))?;
                        body.extend(base64::engine::general_purpose::STANDARD.decode(b64)?);
                        if body.len() > 64 * 1024 * 1024 {
                            bail!("resident-browser-response-too-large")
                        }
                        expected_seq = expected_seq.saturating_add(1);
                    }
                    Some("browserResponseEnd") => {
                        return Ok(crate::remote_proxy::ResidentBrowserResponse {
                            status: status
                                .ok_or_else(|| anyhow::anyhow!("resident-browser-head-missing"))?,
                            headers,
                            body,
                        });
                    }
                    Some("browserResponseError") => {
                        let code = event
                            .payload
                            .get("code")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("resident-browser-failed");
                        bail!(code.to_string())
                    }
                    _ => {}
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
        bail!("resident-browser-timeout")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResidentEnsureInput {
    tab_id: String,
    kind: String,
    descriptor: RuntimeDescriptor,
    expected_catalog_revision: u64,
    request_id: String,
    initial_checkpoint: serde_json::Value,
}

#[tauri::command]
pub fn resident_descriptor(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime_kind: String,
) -> Result<RuntimeDescriptor, String> {
    state
        .resident
        .ensure_ready(&app)
        .and_then(|()| descriptor_path(&app, &runtime_kind))
        .and_then(|path| {
            serde_json::from_slice(
                &fs::read(&path)
                    .with_context(|| format!("read resident descriptor {}", path.display()))?,
            )
            .context("parse resident descriptor")
        })
        .map_err(stable_error)
}

fn stage_control_plane(app: &AppHandle) -> Result<InstallPlan> {
    let resources = app.path().resource_dir()?.join("resident/control");
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let supervisor = resources.join(format!("tabverse-resident-supervisor{suffix}"));
    let launcher = resources.join(format!("tabverse-resident-launcher{suffix}"));
    let trusted_keys = resources.join("trusted-keys.json");
    let resident_root = crate::state_dir(app)
        .map_err(|error| anyhow::anyhow!(error))?
        .join("resident");
    let plan = InstallPlan::render(
        PlatformKind::current()?,
        resident_root,
        resident_user_config_root(app)?,
    )?;
    plan.stage(&InstallArtifacts {
        supervisor_hash: hash_file(&supervisor)?,
        supervisor_source: supervisor,
        supervisor_version: env!("CARGO_PKG_VERSION").into(),
        launcher_hash: hash_file(&launcher)?,
        launcher_source: launcher,
        trusted_keys_json: fs::read(&trusted_keys)
            .with_context(|| format!("read resident trusted keys {}", trusted_keys.display()))?,
    })?;
    Ok(plan)
}

fn resident_user_config_root(app: &AppHandle) -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Ok(app.path().home_dir()?.join("Library"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(app.path().config_dir()?)
    }
}

fn hash_file(path: &Path) -> Result<String> {
    Ok(hex::encode(Sha256::digest(fs::read(path).with_context(
        || format!("read resident artifact {}", path.display()),
    )?)))
}

#[tauri::command]
pub fn resident_ensure(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ResidentEnsureInput,
) -> Result<RuntimeRef, String> {
    let source = artifact_path(&app, &request.kind, &request.descriptor).map_err(stable_error)?;
    let runtime = state
        .resident
        .call(&app, |client| {
            client.sync_catalog_revision(request.expected_catalog_revision)?;
            client.ensure_runtime(EnsureRuntime {
                tab_id: request.tab_id,
                kind: request.kind,
                descriptor: request.descriptor,
                artifact_source: source,
                expected_catalog_revision: request.expected_catalog_revision,
                request_id: request.request_id,
                initial_checkpoint: request.initial_checkpoint,
            })
        })
        .map_err(stable_error)?;
    Ok(state.resident.remember(runtime))
}

#[tauri::command]
pub fn resident_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<RuntimeRef>, String> {
    state
        .resident
        .call(&app, |client| {
            Ok(client
                .list()?
                .into_iter()
                .filter_map(|(runtime, status)| {
                    (status == RuntimeStatus::Running).then_some(runtime)
                })
                .collect())
        })
        .map_err(stable_error)
}

#[tauri::command]
pub fn resident_attach(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime_id: String,
    last_ack_seq: u64,
) -> Result<AttachReplay, String> {
    let replay = state
        .resident
        .call(&app, |client| client.attach(runtime_id, last_ack_seq))
        .map_err(stable_error)?;
    state.resident.remember(replay.runtime.clone());
    Ok(replay)
}

#[tauri::command]
pub fn resident_poll(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime_id: String,
    last_ack_seq: u64,
) -> Result<AttachReplay, String> {
    let runtime = state.resident.runtime(&runtime_id).map_err(stable_error)?;
    state
        .resident
        .call(&app, |client| client.poll(runtime, last_ack_seq))
        .map_err(stable_error)
}

#[tauri::command]
pub fn resident_intent(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime_id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let runtime = state.resident.runtime(&runtime_id).map_err(stable_error)?;
    let bytes = serde_json::to_vec(&payload).map_err(|_| "resident-intent-invalid".to_string())?;
    state
        .resident
        .call(&app, |client| client.send_intent(runtime, bytes))
        .map_err(stable_error)
}

#[tauri::command]
pub fn resident_detach(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: RuntimeRef,
) -> Result<RuntimeRef, String> {
    let detached = state
        .resident
        .call(&app, |client| client.detach(runtime))
        .map_err(stable_error)?;
    Ok(state.resident.remember(detached))
}

#[tauri::command]
pub fn resident_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: RuntimeRef,
) -> Result<(), String> {
    state
        .resident
        .call(&app, |client| client.stop(runtime.clone()))
        .map_err(stable_error)?;
    state
        .resident
        .runtimes
        .lock()
        .unwrap()
        .remove(&runtime.runtime_id);
    Ok(())
}

fn connect(app: &AppHandle) -> Result<ResidentClient> {
    let root = crate::state_dir(app)
        .map_err(|error| anyhow::anyhow!(error))?
        .join("resident");
    let token = read_token(&root.join("auth-token"))?;
    ResidentClient::connect(
        root,
        AuthToken::new(*token),
        env!("CARGO_PKG_VERSION"),
        ProtocolRange::supervisor(),
    )
}

fn read_token(path: &Path) -> Result<Zeroizing<[u8; 32]>> {
    owner_only(path)?;
    let bytes = Zeroizing::new(
        fs::read(path).with_context(|| format!("read resident token {}", path.display()))?,
    );
    let token: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("resident token must contain exactly 32 bytes"))?;
    Ok(Zeroizing::new(token))
}

fn descriptor_path(app: &AppHandle, runtime_kind: &str) -> Result<PathBuf> {
    validate_segment("runtime kind", runtime_kind)?;
    Ok(app
        .path()
        .resource_dir()?
        .join("resident")
        .join(runtime_kind)
        .join("descriptor.json"))
}

fn artifact_path(
    app: &AppHandle,
    runtime_kind: &str,
    descriptor: &RuntimeDescriptor,
) -> Result<PathBuf> {
    validate_segment("runtime kind", runtime_kind)?;
    validate_segment("entrypoint", &descriptor.entrypoint)?;
    validate_artifact_hash(&descriptor.artifact_hash)?;
    let directory = app
        .path()
        .resource_dir()?
        .join("resident")
        .join(runtime_kind);
    let path = directory.join(&descriptor.entrypoint);
    if path.is_file() {
        return Ok(path);
    }
    let encoded = path.with_file_name(format!("{}.b64", descriptor.entrypoint));
    if !encoded.is_file() {
        bail!("resident-artifact-missing")
    }
    let state = crate::state_dir(app).map_err(|error| anyhow::anyhow!(error))?;
    materialize_packaged_artifact(&encoded, &state, descriptor)
}

fn materialize_packaged_artifact(
    encoded_source: &Path,
    state_root: &Path,
    descriptor: &RuntimeDescriptor,
) -> Result<PathBuf> {
    validate_segment("entrypoint", &descriptor.entrypoint)?;
    validate_artifact_hash(&descriptor.artifact_hash)?;
    let encoded = fs::read_to_string(encoded_source).context("read resident packaged artifact")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .context("decode resident packaged artifact")?;
    if hex::encode(Sha256::digest(&bytes)) != descriptor.artifact_hash.to_ascii_lowercase() {
        bail!("resident-artifact-hash-mismatch")
    }

    let directory = state_root
        .join("resident/package-artifacts")
        .join(descriptor.artifact_hash.to_ascii_lowercase());
    fs::create_dir_all(&directory)?;
    owner_only_artifact_directory(&directory)?;
    let target = directory.join(&descriptor.entrypoint);
    if target.is_file() && hash_file(&target)? == descriptor.artifact_hash.to_ascii_lowercase() {
        return Ok(target);
    }

    let sequence = PACKAGED_ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(
        ".{}.tmp-{}-{sequence}",
        descriptor.entrypoint,
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    owner_only_artifact_file(&temporary)?;
    if target.exists() {
        fs::remove_file(&target)?;
    }
    fs::rename(&temporary, &target)?;
    Ok(target)
}

fn validate_artifact_hash(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("resident-artifact-hash-invalid")
    }
    Ok(())
}

#[cfg(unix)]
fn owner_only_artifact_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn owner_only_artifact_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn owner_only_artifact_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn owner_only_artifact_file(_path: &Path) -> Result<()> {
    Ok(())
}

fn validate_segment(label: &str, value: &str) -> Result<()> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("invalid resident {label}")
    }
    Ok(())
}

#[cfg(unix)]
fn owner_only(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)?.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!("resident token permissions are not owner-only")
    }
    Ok(())
}

#[cfg(not(unix))]
fn owner_only(path: &Path) -> Result<()> {
    let _ = fs::metadata(path)?;
    Ok(())
}

fn stable_error(error: anyhow::Error) -> String {
    error
        .to_string()
        .split(':')
        .next()
        .filter(|code| code.starts_with("resident-"))
        .unwrap_or("resident-request-failed")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor_for(bytes: &[u8]) -> RuntimeDescriptor {
        serde_json::from_value(serde_json::json!({
            "pluginId": "tabverse.fixture",
            "pluginVersion": "1.0.0",
            "artifactHash": hex::encode(Sha256::digest(bytes)),
            "entrypoint": "fixture-worker",
            "permissions": [],
            "protocolRange": { "min": 1, "max": 2 },
            "signature": "00"
        }))
        .unwrap()
    }

    #[test]
    fn artifact_coordinates_are_single_segments() {
        for invalid in ["", "../worker", "nested/worker", "/absolute", "has space"] {
            assert!(validate_segment("fixture", invalid).is_err(), "{invalid}");
        }
        for valid in ["terminal", "tabverse-worker.exe", "worker_1.0"] {
            validate_segment("fixture", valid).unwrap();
        }
    }

    #[test]
    fn stable_errors_do_not_echo_paths_or_json() {
        assert_eq!(
            stable_error(anyhow::anyhow!("resident-artifact-missing: /private/path")),
            "resident-artifact-missing"
        );
        assert_eq!(
            stable_error(anyhow::anyhow!("parse failed: secret payload")),
            "resident-request-failed"
        );
    }

    #[test]
    fn packaged_worker_materializes_the_original_signed_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let resources = directory.path().join("resources");
        let state = directory.path().join("state");
        fs::create_dir_all(&resources).unwrap();
        let bytes = b"signed-worker-bytes";
        let descriptor = descriptor_for(bytes);
        let encoded = resources.join("fixture-worker.b64");
        fs::write(
            &encoded,
            base64::engine::general_purpose::STANDARD.encode(bytes),
        )
        .unwrap();

        let materialized = materialize_packaged_artifact(&encoded, &state, &descriptor).unwrap();
        assert_eq!(fs::read(materialized).unwrap(), bytes);
    }

    #[test]
    fn packaged_worker_rejects_bytes_outside_the_signed_hash() {
        let directory = tempfile::tempdir().unwrap();
        let encoded = directory.path().join("fixture-worker.b64");
        fs::write(
            &encoded,
            base64::engine::general_purpose::STANDARD.encode(b"mutated"),
        )
        .unwrap();
        let error = materialize_packaged_artifact(
            &encoded,
            &directory.path().join("state"),
            &descriptor_for(b"signed"),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .starts_with("resident-artifact-hash-mismatch"));
    }
}
