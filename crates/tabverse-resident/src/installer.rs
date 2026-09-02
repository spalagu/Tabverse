use crate::{Ed25519SignatureVerifier, InstallPlan, TrustedKeySet};
use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

pub struct InstallArtifacts {
    pub supervisor_source: PathBuf,
    pub supervisor_version: String,
    pub supervisor_hash: String,
    pub launcher_source: PathBuf,
    pub launcher_hash: String,
    pub trusted_keys_json: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedInstall {
    pub supervisor_slot: PathBuf,
    pub launcher: PathBuf,
    pub auth_token: PathBuf,
    pub current_pointer: PathBuf,
    pub service_files: Vec<PathBuf>,
}

impl InstallPlan {
    /// Stage a signed-installer payload without activating the platform
    /// service. The current pointer is the final write, so an interrupted
    /// install leaves the previous supervisor selected and running.
    pub fn stage(&self, artifacts: &InstallArtifacts) -> Result<StagedInstall> {
        validate_segment("supervisor version", &artifacts.supervisor_version)?;
        validate_hash(&artifacts.supervisor_source, &artifacts.supervisor_hash)?;
        validate_hash(&artifacts.launcher_source, &artifacts.launcher_hash)?;
        let keys: TrustedKeySet = serde_json::from_slice(&artifacts.trusted_keys_json)
            .context("parse resident trusted keys")?;
        if keys.schema_version != 1 {
            bail!("resident-trusted-keys-incompatible")
        }
        let _ = Ed25519SignatureVerifier::new(keys)?;

        fs::create_dir_all(&self.resident_root)?;
        owner_only_dir(&self.resident_root)?;
        let supervisor_name = if self.platform == crate::PlatformKind::Windows {
            "tabverse-resident-supervisor.exe"
        } else {
            "tabverse-resident-supervisor"
        };
        let relative_slot = PathBuf::from("slots")
            .join(format!("supervisor@{}", artifacts.supervisor_version))
            .join(&artifacts.supervisor_hash)
            .join(supervisor_name);
        let supervisor_slot = self.resident_root.join(&relative_slot);
        install_executable(
            &artifacts.supervisor_source,
            &supervisor_slot,
            &artifacts.supervisor_hash,
        )?;
        install_executable(
            &artifacts.launcher_source,
            &self.launcher,
            &artifacts.launcher_hash,
        )?;

        let auth_token = self.resident_root.join("auth-token");
        if !auth_token.exists() {
            let mut token = [0u8; 32];
            getrandom::fill(&mut token)?;
            atomic_write(&auth_token, &token, false)?;
        }
        atomic_write(
            &self.resident_root.join("trusted-keys.json"),
            &artifacts.trusted_keys_json,
            false,
        )?;
        let mut service_files = Vec::new();
        for file in &self.files {
            let contents = service_file_bytes(self.platform, &file.contents);
            atomic_write(&file.path, &contents, false)?;
            service_files.push(file.path.clone());
        }
        let current_pointer = self.resident_root.join("current/supervisor");
        atomic_write(
            &current_pointer,
            relative_slot.to_string_lossy().as_bytes(),
            false,
        )?;
        Ok(StagedInstall {
            supervisor_slot,
            launcher: self.launcher.clone(),
            auth_token,
            current_pointer,
            service_files,
        })
    }
}

fn service_file_bytes(platform: crate::PlatformKind, contents: &str) -> Vec<u8> {
    if platform != crate::PlatformKind::Windows {
        return contents.as_bytes().to_vec();
    }
    let mut bytes = vec![0xff, 0xfe];
    for code_unit in contents.encode_utf16() {
        bytes.extend_from_slice(&code_unit.to_le_bytes());
    }
    bytes
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

fn validate_hash(source: &Path, expected: &str) -> Result<()> {
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("resident-install-hash-invalid")
    }
    let actual =
        hex::encode(Sha256::digest(fs::read(source).with_context(|| {
            format!("read install artifact {}", source.display())
        })?));
    if actual != expected.to_ascii_lowercase() {
        bail!("resident-install-hash-mismatch")
    }
    Ok(())
}

fn install_executable(source: &Path, target: &Path, expected_hash: &str) -> Result<()> {
    if target.exists() {
        let actual = hex::encode(Sha256::digest(fs::read(target)?));
        if actual == expected_hash.to_ascii_lowercase() {
            return Ok(());
        }
    }
    let bytes = fs::read(source)?;
    atomic_write(target, &bytes, true)
}

fn atomic_write(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("resident install path has no parent"))?;
    fs::create_dir_all(parent)?;
    owner_only_dir(parent)?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("install"),
        uuid::Uuid::new_v4()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    owner_only_file(&temp, executable)?;
    replace(&temp, path)?;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both paths are owned, NUL-terminated UTF-16 buffers that live
    // through the call. MOVEFILE_REPLACE_EXISTING gives the pointer update one
    // Windows filesystem operation instead of a remove/rename gap.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> Result<()> {
    fs::rename(source, target)?;
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
fn owner_only_file(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if executable { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

#[cfg(not(unix))]
fn owner_only_file(_path: &Path, _executable: bool) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PlatformKind;
    use ed25519_dalek::SigningKey;

    fn artifacts(dir: &Path, version: &str, body: &[u8]) -> InstallArtifacts {
        let signing = SigningKey::from_bytes(&[0x2a; 32]);
        let supervisor = dir.join(format!("supervisor-{version}"));
        let launcher = dir.join("launcher-source");
        fs::write(&supervisor, body).unwrap();
        fs::write(&launcher, b"stable-launcher").unwrap();
        InstallArtifacts {
            supervisor_source: supervisor,
            supervisor_version: version.into(),
            supervisor_hash: hex::encode(Sha256::digest(body)),
            launcher_source: launcher,
            launcher_hash: hex::encode(Sha256::digest(b"stable-launcher")),
            trusted_keys_json: serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "plugins": {
                    "tabverse.fixture": [hex::encode(signing.verifying_key().as_bytes())]
                }
            }))
            .unwrap(),
        }
    }

    #[test]
    fn reinstall_switches_current_last_and_preserves_token_and_old_slot() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("resident");
        let config = dir.path().join("config");
        let plan = InstallPlan::render(PlatformKind::Linux, &root, &config).unwrap();
        let first = plan
            .stage(&artifacts(dir.path(), "1.0.0", b"supervisor-v1"))
            .unwrap();
        let token = fs::read(&first.auth_token).unwrap();
        let first_slot = first.supervisor_slot.clone();
        let second = plan
            .stage(&artifacts(dir.path(), "2.0.0", b"supervisor-v2"))
            .unwrap();
        assert_eq!(fs::read(&second.auth_token).unwrap(), token);
        assert!(first_slot.exists());
        assert!(second.supervisor_slot.exists());
        assert_eq!(
            crate::resolve_current_supervisor(&root).unwrap(),
            second.supervisor_slot
        );
        assert!(second.service_files[0].exists());
    }

    #[test]
    fn bad_hash_fails_before_creating_the_resident_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("resident");
        let plan =
            InstallPlan::render(PlatformKind::MacOs, &root, dir.path().join("config")).unwrap();
        let mut payload = artifacts(dir.path(), "1.0.0", b"supervisor");
        payload.supervisor_hash = "0".repeat(64);
        assert!(plan.stage(&payload).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn failed_reinstall_does_not_switch_the_current_supervisor() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("resident");
        let config = dir.path().join("config");
        let plan = InstallPlan::render(PlatformKind::Linux, &root, &config).unwrap();
        let first = plan
            .stage(&artifacts(dir.path(), "1.0.0", b"supervisor-v1"))
            .unwrap();

        let blocker = dir.path().join("not-a-directory");
        fs::write(&blocker, b"block service file staging").unwrap();
        let mut failing_plan = plan.clone();
        failing_plan.files[0].path = blocker.join("tabverse-resident.service");
        assert!(failing_plan
            .stage(&artifacts(dir.path(), "2.0.0", b"supervisor-v2"))
            .is_err());
        assert_eq!(
            crate::resolve_current_supervisor(&root).unwrap(),
            first.supervisor_slot
        );
    }

    #[test]
    fn windows_task_xml_is_written_as_declared_utf16le_with_a_bom() {
        let contents = "<?xml version=\"1.0\" encoding=\"UTF-16\"?><Task/>";
        let bytes = service_file_bytes(PlatformKind::Windows, contents);
        assert_eq!(&bytes[..2], &[0xff, 0xfe]);
        let encoded = contents
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(&bytes[2..], encoded);
        assert_eq!(
            service_file_bytes(PlatformKind::Linux, contents),
            contents.as_bytes()
        );
    }
}
