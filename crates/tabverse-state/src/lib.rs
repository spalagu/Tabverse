use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub const MAX_STATE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SCOPE_LEN: usize = 120;
const SCHEMA_VERSION: i64 = 1;

/// The desktop-owned durable store. Workbench talks to this through narrow
/// state commands and never opens SQLite itself.
pub struct AppStateStore {
    path: PathBuf,
}

impl AppStateStore {
    pub fn open(app_data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(app_data_dir)
            .with_context(|| format!("cannot create app data dir {}", app_data_dir.display()))?;
        let store = Self {
            path: app_data_dir.join("app.db"),
        };
        let mut connection = store.connection()?;
        store.initialize(&mut connection, &app_data_dir.join("state"))?;
        Ok(store)
    }

    pub fn save_scope(&self, scope: &str, json: &str) -> Result<()> {
        validate_scope(scope)?;
        validate_json(json)?;
        if json.len() > MAX_STATE_BYTES {
            return Err(anyhow!(
                "state for scope {scope:?} is {} bytes, above the {} MiB limit",
                json.len(),
                MAX_STATE_BYTES / (1024 * 1024)
            ));
        }
        self.connection()?.execute(
            "INSERT INTO state_scopes(scope, json, updated_at) VALUES (?1, ?2, unixepoch())\
             ON CONFLICT(scope) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
            params![scope, json],
        )?;
        Ok(())
    }

    pub fn load_scope(&self, scope: &str) -> Result<Option<String>> {
        validate_scope(scope)?;
        self.connection()?
            .query_row(
                "SELECT json FROM state_scopes WHERE scope=?1",
                [scope],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn delete_scope(&self, scope: &str) -> Result<()> {
        validate_scope(scope)?;
        self.connection()?
            .execute("DELETE FROM state_scopes WHERE scope=?1", [scope])?;
        Ok(())
    }

    pub fn list_scopes(&self) -> Result<Vec<String>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT scope FROM state_scopes ORDER BY scope")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.path)
            .with_context(|| format!("cannot open {}", self.path.display()))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "busy_timeout", 5_000_i64)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        Ok(connection)
    }

    fn initialize(&self, connection: &mut Connection, legacy_dir: &Path) -> Result<()> {
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (\
               version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS workspaces (\
               id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS tabs (\
               id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,\
               kind TEXT NOT NULL, state_version INTEGER NOT NULL, state_json TEXT NOT NULL, position INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS settings (\
               key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS content_preferences (\
               content_type TEXT PRIMARY KEY, handler_id TEXT NOT NULL, updated_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS state_scopes (\
               scope TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL\
             );",
        )?;

        let applied: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=?1)",
            [SCHEMA_VERSION],
            |row| row.get(0),
        )?;
        if !applied {
            import_legacy_scopes(&transaction, legacy_dir)?;
            transaction.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, unixepoch())",
                [SCHEMA_VERSION],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
}

fn validate_scope(scope: &str) -> Result<()> {
    if scope.is_empty() || scope.len() > MAX_SCOPE_LEN {
        return Err(anyhow!("scope must be 1..={MAX_SCOPE_LEN} chars"));
    }
    if scope
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-')))
    {
        return Err(anyhow!("invalid state scope {scope:?}"));
    }
    Ok(())
}

fn validate_json(json: &str) -> Result<()> {
    serde_json::from_str::<serde_json::Value>(json)
        .map(|_| ())
        .context("state payload is not valid JSON")
}

fn import_legacy_scopes(transaction: &Transaction<'_>, legacy_dir: &Path) -> Result<()> {
    let scopes = tabverse_legacy_scopes(legacy_dir)?;
    for (scope, json) in scopes {
        validate_scope(&scope)?;
        transaction.execute(
            "INSERT OR IGNORE INTO state_scopes(scope, json, updated_at) VALUES (?1, ?2, unixepoch())",
            params![scope, json],
        )?;
    }
    Ok(())
}

fn tabverse_legacy_scopes(base: &Path) -> Result<Vec<(String, String)>> {
    let entries = match std::fs::read_dir(base) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(encoded) = name.strip_suffix(".json") else {
            continue;
        };
        let Some(scope) = decode_scope(encoded) else {
            continue;
        };
        if validate_scope(&scope).is_err() {
            continue;
        }
        let json = std::fs::read_to_string(entry.path())?;
        result.push((scope, json));
    }
    Ok(result)
}

fn decode_scope(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            output.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_round_trip_through_app_db() {
        let temp = tempfile::tempdir().unwrap();
        let store = AppStateStore::open(temp.path()).unwrap();
        store.save_scope("files:abc", r#"{"v":1}"#).unwrap();
        assert_eq!(
            store.load_scope("files:abc").unwrap().as_deref(),
            Some(r#"{"v":1}"#)
        );
        assert_eq!(store.list_scopes().unwrap(), ["files:abc"]);
        store.delete_scope("files:abc").unwrap();
        assert!(store.load_scope("files:abc").unwrap().is_none());
    }

    #[test]
    fn legacy_files_import_once_without_being_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("state");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("files%3Aabc.json"), r#"{"old":true}"#).unwrap();

        let store = AppStateStore::open(temp.path()).unwrap();
        assert_eq!(
            store.load_scope("files:abc").unwrap().as_deref(),
            Some(r#"{"old":true}"#)
        );
        store.save_scope("files:abc", r#"{"new":true}"#).unwrap();
        drop(store);

        let reopened = AppStateStore::open(temp.path()).unwrap();
        assert_eq!(
            reopened.load_scope("files:abc").unwrap().as_deref(),
            Some(r#"{"new":true}"#)
        );
        assert!(legacy.join("files%3Aabc.json").exists());
    }

    #[test]
    fn invalid_legacy_json_is_preserved_for_frontend_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("state");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("session.json"), "not json").unwrap();
        let store = AppStateStore::open(temp.path()).unwrap();
        assert_eq!(store.list_scopes().unwrap(), ["session"]);
        assert_eq!(
            store.load_scope("session").unwrap().as_deref(),
            Some("not json")
        );
    }
}
