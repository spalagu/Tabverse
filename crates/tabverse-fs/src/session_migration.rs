//! One-time, crash-safe retirement of the legacy Agent tab session shape.
//!
//! The original v1 bytes are content-addressed and made durable before the
//! v2 payload is published. A crash can therefore leave either the untouched
//! v1 session or the complete v2 session, always with a byte-exact rollback
//! source once migration has started.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::state;

const SESSION_SCOPE: &str = "session";
const BACKUP_DIR: &str = "migration-backups/pre-agent-removal";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub status: MigrationStatus,
    pub backup_sha256: Option<String>,
    pub removed_agent_tabs: usize,
    pub surviving_tabs: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationStatus {
    Missing,
    AlreadyCurrent,
    Migrated,
}

pub fn migrate_session_v1_to_v2(base: &Path) -> Result<MigrationReport> {
    let Some(original) = state::load(base, SESSION_SCOPE)? else {
        return Ok(MigrationReport {
            status: MigrationStatus::Missing,
            backup_sha256: None,
            removed_agent_tabs: 0,
            surviving_tabs: 0,
        });
    };
    let parsed: Value = serde_json::from_str(&original).context("session state is invalid JSON")?;
    let version = parsed
        .as_object()
        .and_then(|root| root.get("version"))
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("session state has no numeric version"))?;
    if version == 2 {
        let surviving_tabs = parsed
            .get("tabs")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        return Ok(MigrationReport {
            status: MigrationStatus::AlreadyCurrent,
            backup_sha256: None,
            removed_agent_tabs: 0,
            surviving_tabs,
        });
    }
    if version != 1 {
        bail!("unsupported session version {version}");
    }

    let (migrated, removed_agent_tabs, surviving_tabs) = migrate_value(parsed)?;
    let hash = sha256_hex(original.as_bytes());
    persist_backup(base, &hash, original.as_bytes())?;
    let json = serde_json::to_string(&migrated).context("cannot serialize migrated session")?;
    state::save(base, SESSION_SCOPE, &json)?;

    Ok(MigrationReport {
        status: MigrationStatus::Migrated,
        backup_sha256: Some(hash),
        removed_agent_tabs,
        surviving_tabs,
    })
}

pub fn restore_session_backup(base: &Path, sha256: &str) -> Result<()> {
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("backup hash must be 64 lowercase hexadecimal characters");
    }
    let path = backup_path(base, sha256);
    let bytes = std::fs::read(&path)
        .with_context(|| format!("cannot read session backup {}", path.display()))?;
    if sha256_hex(&bytes) != sha256 {
        bail!("session backup hash mismatch for {}", path.display());
    }
    let json = std::str::from_utf8(&bytes).context("session backup is not UTF-8")?;
    state::save(base, SESSION_SCOPE, json)
}

fn migrate_value(value: Value) -> Result<(Value, usize, usize)> {
    let mut root = value
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("session state must be an object"))?;
    let original_tabs = root
        .get("tabs")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| anyhow!("session state tabs must be an array"))?;

    let mut kept = Vec::with_capacity(original_tabs.len());
    let mut kept_positions = Vec::with_capacity(original_tabs.len());
    let mut live_ids = HashSet::new();
    let mut removed = 0;
    for (position, tab) in original_tabs.iter().enumerate() {
        let mut object = tab
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow!("session tab at index {position} must be an object"))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("session tab at index {position} has no string id"))?
            .to_string();
        let kind = object
            .get("kind")
            .or_else(|| object.get("type"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("session tab {id} has no string kind/type"))?
            .to_string();
        if kind == "agent" {
            removed += 1;
            continue;
        }
        if !live_ids.insert(id) {
            bail!("session contains duplicate tab id");
        }
        object.remove("type");
        object.insert("kind".to_string(), Value::String(kind));
        kept.push(Value::Object(object));
        kept_positions.push(position);
    }

    repair_group_references(&mut kept, &root);
    repair_active_tab(&mut root, &original_tabs, &kept_positions, &live_ids);
    repair_split(&mut root, &live_ids);
    root.insert("version".to_string(), Value::from(2));
    root.insert("tabs".to_string(), Value::Array(kept));
    Ok((Value::Object(root), removed, live_ids.len()))
}

fn repair_group_references(tabs: &mut [Value], root: &Map<String, Value>) {
    let valid_groups: HashSet<&str> = root
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|group| group.get("id").and_then(Value::as_str))
        .collect();
    for tab in tabs {
        let Some(object) = tab.as_object_mut() else {
            continue;
        };
        let valid = object
            .get("groupId")
            .and_then(Value::as_str)
            .is_some_and(|id| valid_groups.contains(id));
        if object.get("groupId").is_some_and(|value| !value.is_null()) && !valid {
            object.insert("groupId".to_string(), Value::Null);
        }
    }
}

fn repair_active_tab(
    root: &mut Map<String, Value>,
    original_tabs: &[Value],
    kept_positions: &[usize],
    live_ids: &HashSet<String>,
) {
    let old_active = root
        .get("activeTabId")
        .and_then(Value::as_str)
        .map(str::to_string);
    if old_active.as_ref().is_some_and(|id| live_ids.contains(id)) {
        return;
    }
    let removed_position = old_active.as_ref().and_then(|active| {
        original_tabs
            .iter()
            .position(|tab| tab.get("id").and_then(Value::as_str) == Some(active))
    });
    let chosen_position = removed_position
        .and_then(|position| {
            kept_positions
                .iter()
                .copied()
                .find(|candidate| *candidate >= position)
                .or_else(|| kept_positions.last().copied())
        })
        .or_else(|| kept_positions.first().copied());
    let chosen = chosen_position.and_then(|position| {
        original_tabs[position]
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    root.insert(
        "activeTabId".to_string(),
        chosen.map_or(Value::Null, Value::String),
    );
}

fn repair_split(root: &mut Map<String, Value>, live_ids: &HashSet<String>) {
    let (ids, ratios, vertical) = if let Some(split) = root.get("split") {
        let ids = split
            .get("ids")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let ratios = split
            .get("ratios")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let vertical = split
            .get("vertical")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        (ids, ratios, vertical)
    } else if let Some(pair) = root.get("splitPair") {
        let ids = ["leftId", "rightId"]
            .iter()
            .filter_map(|key| pair.get(key).and_then(Value::as_str))
            .map(|id| Value::String(id.to_string()))
            .collect();
        let ratio = pair.get("ratio").and_then(Value::as_f64).unwrap_or(0.5);
        (
            ids,
            vec![Value::from(ratio), Value::from(1.0 - ratio)],
            false,
        )
    } else {
        root.remove("splitPair");
        return;
    };

    let mut seen = HashSet::new();
    let mut repaired_ids = Vec::new();
    let mut repaired_ratios = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        let Some(id) = id.as_str() else { continue };
        if !live_ids.contains(id) || !seen.insert(id.to_string()) {
            continue;
        }
        repaired_ids.push(Value::String(id.to_string()));
        let weight = ratios
            .get(index)
            .and_then(Value::as_f64)
            .filter(|weight| weight.is_finite() && *weight > 0.0)
            .unwrap_or(1.0);
        repaired_ratios.push(weight);
    }
    root.remove("splitPair");
    if repaired_ids.len() < 2 {
        root.remove("split");
        return;
    }
    let total: f64 = repaired_ratios.iter().sum();
    let ratios: Vec<Value> = repaired_ratios
        .into_iter()
        .map(|weight| Value::from(weight / total))
        .collect();
    root.insert(
        "split".to_string(),
        serde_json::json!({ "ids": repaired_ids, "ratios": ratios, "vertical": vertical }),
    );
}

fn persist_backup(base: &Path, hash: &str, bytes: &[u8]) -> Result<()> {
    let directory = base.join(BACKUP_DIR);
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("cannot create migration backup dir {}", directory.display()))?;
    let destination = backup_path(base, hash);
    if destination.exists() {
        let existing = std::fs::read(&destination)?;
        if existing != bytes {
            bail!("existing migration backup does not match its content hash");
        }
        return Ok(());
    }
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = directory.join(format!(".{hash}.{}.{}.tmp", std::process::id(), sequence));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, &destination)?;
        state::sync_dir(&directory)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.with_context(|| format!("cannot persist session backup {}", destination.display()))
}

fn backup_path(base: &Path, hash: &str) -> PathBuf {
    base.join(BACKUP_DIR).join(format!("{hash}.json"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "tabverse-session-migration-{tag}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&base);
        base
    }

    fn mixed_session() -> &'static str {
        include_str!("../tests/fixtures/session-v1/mixed.json").trim_end()
    }

    #[test]
    fn migration_backs_up_exact_bytes_filters_agent_and_repairs_references() {
        let base = temp_base("mixed");
        state::save(&base, SESSION_SCOPE, mixed_session()).unwrap();

        let report = migrate_session_v1_to_v2(&base).unwrap();
        assert_eq!(report.status, MigrationStatus::Migrated);
        assert_eq!(report.removed_agent_tabs, 1);
        assert_eq!(report.surviving_tabs, 2);
        let hash = report.backup_sha256.unwrap();
        assert_eq!(
            std::fs::read_to_string(backup_path(&base, &hash)).unwrap(),
            mixed_session()
        );

        let current: Value =
            serde_json::from_str(&state::load(&base, SESSION_SCOPE).unwrap().unwrap()).unwrap();
        assert_eq!(current["version"], 2);
        assert_eq!(current["activeTabId"], "browser");
        assert_eq!(current["tabs"][0]["kind"], "terminal");
        assert!(current["tabs"][0].get("type").is_none());
        assert_eq!(current["tabs"][1]["groupId"], Value::Null);
        assert_eq!(
            current["split"]["ids"],
            serde_json::json!(["terminal", "browser"])
        );
        let ratios = current["split"]["ratios"].as_array().unwrap();
        assert!((ratios[0].as_f64().unwrap() - 2.0 / 7.0).abs() < f64::EPSILON);
        assert!((ratios[1].as_f64().unwrap() - 5.0 / 7.0).abs() < f64::EPSILON);

        let second = migrate_session_v1_to_v2(&base).unwrap();
        assert_eq!(second.status, MigrationStatus::AlreadyCurrent);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn restore_drill_recovers_the_byte_exact_v1_session() {
        let base = temp_base("restore");
        state::save(&base, SESSION_SCOPE, mixed_session()).unwrap();
        let report = migrate_session_v1_to_v2(&base).unwrap();
        restore_session_backup(&base, report.backup_sha256.as_deref().unwrap()).unwrap();
        assert_eq!(
            state::load(&base, SESSION_SCOPE).unwrap().as_deref(),
            Some(mixed_session())
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn agent_only_session_becomes_empty_without_dangling_layout() {
        let base = temp_base("agent-only");
        let input = include_str!("../tests/fixtures/session-v1/agent-only.json").trim_end();
        state::save(&base, SESSION_SCOPE, input).unwrap();
        migrate_session_v1_to_v2(&base).unwrap();
        let current: Value =
            serde_json::from_str(&state::load(&base, SESSION_SCOPE).unwrap().unwrap()).unwrap();
        assert_eq!(current["tabs"], serde_json::json!([]));
        assert_eq!(current["activeTabId"], Value::Null);
        assert!(current.get("split").is_none());
        assert!(current.get("splitPair").is_none());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn invalid_or_future_state_is_never_replaced() {
        for (tag, input) in [
            ("invalid", "not-json"),
            ("future", r#"{"version":9,"tabs":[]}"#),
        ] {
            let base = temp_base(tag);
            state::save(&base, SESSION_SCOPE, input).unwrap();
            assert!(migrate_session_v1_to_v2(&base).is_err());
            assert_eq!(
                state::load(&base, SESSION_SCOPE).unwrap().as_deref(),
                Some(input)
            );
            assert!(!base.join(BACKUP_DIR).exists());
            let _ = std::fs::remove_dir_all(base);
        }
    }

    #[test]
    fn all_non_agent_payload_fields_survive_except_the_type_to_kind_upgrade() {
        let base = temp_base("non-agent");
        let input = include_str!("../tests/fixtures/session-v1/non-agent.json").trim_end();
        state::save(&base, SESSION_SCOPE, input).unwrap();
        migrate_session_v1_to_v2(&base).unwrap();
        let migrated: Value =
            serde_json::from_str(&state::load(&base, SESSION_SCOPE).unwrap().unwrap()).unwrap();
        let mut expected: Value = serde_json::from_str(input).unwrap();
        expected["version"] = Value::from(2);
        for tab in expected["tabs"].as_array_mut().unwrap() {
            let object = tab.as_object_mut().unwrap();
            let kind = object.remove("type").unwrap();
            object.insert("kind".to_string(), kind);
        }
        assert_eq!(migrated, expected);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn backup_failure_leaves_the_original_session_untouched() {
        let base = temp_base("backup-failure");
        state::save(&base, SESSION_SCOPE, mixed_session()).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("migration-backups"), b"blocks directory creation").unwrap();

        assert!(migrate_session_v1_to_v2(&base).is_err());
        assert_eq!(
            state::load(&base, SESSION_SCOPE).unwrap().as_deref(),
            Some(mixed_session())
        );
        let _ = std::fs::remove_dir_all(base);
    }
}
