use crate::ProtocolRange;
use anyhow::{anyhow, bail, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const STATE_SCHEMA: u16 = 1;
const MAX_EVENTS_PER_RUNTIME: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRequest {
    pub capability: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub optional: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDescriptor {
    pub plugin_id: String,
    pub plugin_version: String,
    pub artifact_hash: String,
    pub entrypoint: String,
    pub permissions: Vec<CapabilityRequest>,
    pub protocol_range: ProtocolRange,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRef {
    pub runtime_id: String,
    pub tab_id: String,
    pub kind: String,
    pub generation: u64,
    pub plugin_version: String,
    pub artifact_slot: String,
    pub lease_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeStatus {
    Running,
    Stopped,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub seq: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachReplay {
    pub runtime: RuntimeRef,
    pub checkpoint_seq: u64,
    pub checkpoint: Value,
    pub events: Vec<EventRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeRecord {
    pub reference: RuntimeRef,
    pub descriptor: RuntimeDescriptor,
    pub status: RuntimeStatus,
    pub checkpoint_seq: u64,
    pub checkpoint: Value,
    pub last_event_seq: u64,
    pub events: Vec<EventRecord>,
    pub last_ack_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreationJournal {
    pub request_id: String,
    pub runtime_id: String,
    pub tab_id: String,
    pub artifact_slot: String,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub(crate) enum RequestOutcome {
    Created { runtime: RuntimeRef },
    Failed { code: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedState {
    pub schema_version: u16,
    pub catalog_revision: u64,
    pub runtimes: BTreeMap<String, RuntimeRecord>,
    pub tab_runtimes: BTreeMap<String, String>,
    pub requests: BTreeMap<String, RequestOutcome>,
    pub creation_journal: Option<CreationJournal>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA,
            catalog_revision: 0,
            runtimes: BTreeMap::new(),
            tab_runtimes: BTreeMap::new(),
            requests: BTreeMap::new(),
            creation_journal: None,
        }
    }
}

pub struct ResidentStore {
    root: PathBuf,
    _owner_lock: File,
}

impl ResidentStore {
    /// Open the application-directory-external resident root and take the one
    /// process owner lock. A second supervisor receives a structured error;
    /// it must attach to the first owner, never create a competing registry.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("slots"))?;
        fs::create_dir_all(root.join("current"))?;
        owner_only_dir(&root)?;
        let lock_path = root.join("supervisor.lock");
        let owner_lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)?;
        owner_only_file(&lock_path)?;
        owner_lock
            .try_lock_exclusive()
            .map_err(|_| anyhow!("resident-owner-exists"))?;
        Ok(Self {
            root,
            _owner_lock: owner_lock,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn load(&self) -> Result<PersistedState> {
        let path = self.root.join("registry.json");
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PersistedState::default())
            }
            Err(error) => return Err(error.into()),
        };
        let state: PersistedState = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse resident registry {}", path.display()))?;
        if state.schema_version != STATE_SCHEMA {
            bail!(
                "resident-state-incompatible: expected {STATE_SCHEMA}, received {}",
                state.schema_version
            );
        }
        Ok(state)
    }

    pub(crate) fn commit(&self, state: &PersistedState) -> Result<()> {
        let bytes = serde_json::to_vec(state)?;
        atomic_write(&self.root.join("registry.json"), &bytes)
    }

    pub(crate) fn install_artifact(
        &self,
        descriptor: &RuntimeDescriptor,
        source: &Path,
    ) -> Result<(String, PathBuf)> {
        validate_segment("plugin id", &descriptor.plugin_id)?;
        validate_segment("plugin version", &descriptor.plugin_version)?;
        validate_segment("artifact hash", &descriptor.artifact_hash)?;
        validate_segment("entrypoint", &descriptor.entrypoint)?;
        let bytes = fs::read(source)
            .with_context(|| format!("read resident artifact {}", source.display()))?;
        let digest = hex::encode(Sha256::digest(&bytes));
        if digest != descriptor.artifact_hash.to_ascii_lowercase() {
            bail!("resident-artifact-hash-mismatch")
        }
        let slot_id = format!(
            "{}@{}/{}",
            descriptor.plugin_id, descriptor.plugin_version, descriptor.artifact_hash
        );
        let slot = self
            .root
            .join("slots")
            .join(format!(
                "{}@{}",
                descriptor.plugin_id, descriptor.plugin_version
            ))
            .join(&descriptor.artifact_hash);
        let target = slot.join(&descriptor.entrypoint);
        if target.exists() {
            let installed = fs::read(&target)?;
            if hex::encode(Sha256::digest(installed)) != descriptor.artifact_hash {
                bail!("resident-slot-corrupt")
            }
            return Ok((slot_id, target));
        }
        let parent = slot
            .parent()
            .ok_or_else(|| anyhow!("resident-slot-invalid"))?;
        fs::create_dir_all(parent)?;
        let temp = parent.join(format!(".install-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temp)?;
        owner_only_dir(&temp)?;
        let temp_target = temp.join(&descriptor.entrypoint);
        fs::write(&temp_target, bytes)?;
        let permissions = fs::metadata(source)?.permissions();
        fs::set_permissions(&temp_target, permissions)?;
        owner_executable(&temp_target)?;
        fs::rename(&temp, &slot)?;
        atomic_write(
            &self.root.join("current").join(&descriptor.plugin_id),
            slot_id.as_bytes(),
        )?;
        Ok((slot_id, target))
    }

    pub(crate) fn trim_events(record: &mut RuntimeRecord) {
        if record.events.len() > MAX_EVENTS_PER_RUNTIME {
            let remove = record.events.len() - MAX_EVENTS_PER_RUNTIME;
            record.events.drain(..remove);
        }
    }
}

fn validate_segment(label: &str, value: &str) -> Result<()> {
    let legal = !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !legal {
        bail!("invalid resident {label}")
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("resident path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state"),
        uuid::Uuid::new_v4()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    owner_only_file(&temp)?;
    fs::rename(&temp, path)?;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
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

#[cfg(unix)]
fn owner_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn owner_executable(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_root_has_exactly_one_supervisor_owner() {
        let dir = tempfile::tempdir().unwrap();
        let first = ResidentStore::open(dir.path()).unwrap();
        let error = ResidentStore::open(dir.path()).err().unwrap().to_string();
        assert_eq!(error, "resident-owner-exists");
        drop(first);
        ResidentStore::open(dir.path()).unwrap();
    }

    #[test]
    fn corrupt_or_future_registry_is_never_reset() {
        let dir = tempfile::tempdir().unwrap();
        let store = ResidentStore::open(dir.path()).unwrap();
        fs::write(dir.path().join("registry.json"), b"not-json").unwrap();
        assert!(store.load().is_err());
        fs::write(
            dir.path().join("registry.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 99,
                "catalogRevision": 0,
                "runtimes": {},
                "tabRuntimes": {},
                "requests": {},
                "creationJournal": null
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(store
            .load()
            .unwrap_err()
            .to_string()
            .starts_with("resident-state-incompatible:"));
    }

    #[test]
    fn artifact_slots_are_immutable_and_path_segments_are_strict() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("worker-source");
        fs::write(&source, b"worker-v1").unwrap();
        let hash = hex::encode(Sha256::digest(b"worker-v1"));
        let descriptor = RuntimeDescriptor {
            plugin_id: "tabverse.test".into(),
            plugin_version: "1.0.0".into(),
            artifact_hash: hash.clone(),
            entrypoint: "worker".into(),
            permissions: vec![],
            protocol_range: ProtocolRange::supervisor(),
            signature: "fixture".into(),
        };
        let store = ResidentStore::open(dir.path().join("resident")).unwrap();
        let (slot, target) = store.install_artifact(&descriptor, &source).unwrap();
        assert_eq!(slot, format!("tabverse.test@1.0.0/{hash}"));
        assert_eq!(fs::read(&target).unwrap(), b"worker-v1");
        store.install_artifact(&descriptor, &source).unwrap();

        let mut traversal = descriptor;
        traversal.entrypoint = "../worker".into();
        assert!(store.install_artifact(&traversal, &source).is_err());
    }

    #[test]
    fn runtime_descriptor_json_matches_the_typescript_contract() {
        let descriptor: RuntimeDescriptor = serde_json::from_value(serde_json::json!({
            "pluginId": "tabverse.fixture",
            "pluginVersion": "1.0.0",
            "artifactHash": "a".repeat(64),
            "entrypoint": "fixture-worker",
            "permissions": [{
                "capability": "fixture.echo",
                "reason": "exercise the resident protocol"
            }],
            "protocolRange": { "min": 1, "max": 2 },
            "signature": "fixture-signature"
        }))
        .unwrap();
        assert!(!descriptor.permissions[0].optional);
        let encoded = serde_json::to_value(descriptor).unwrap();
        assert_eq!(
            encoded["protocolRange"],
            serde_json::json!({"min": 1, "max": 2})
        );
        assert!(encoded.get("protocol").is_none());
        assert!(encoded["permissions"][0].get("optional").is_none());
    }
}
