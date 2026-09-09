use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub const MAX_STATE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SCOPE_LEN: usize = 120;
const SCHEMA_VERSION: i64 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceRecord {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub tabs: Vec<TabRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabRecord {
    pub id: String,
    pub kind: String,
    pub state_version: u32,
    pub state_json: String,
    pub position: i64,
}

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

    /// Replace one workspace and its ordered tabs atomically. Tab state stays
    /// opaque: only the owning Feature Module may decode or migrate it.
    pub fn save_workspace(&self, workspace: &WorkspaceRecord) -> Result<()> {
        validate_identifier("workspace", &workspace.id)?;
        if workspace.title.trim().is_empty() {
            return Err(anyhow!("workspace title must not be empty"));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO workspaces(id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)\
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at",
            params![
                workspace.id,
                workspace.title,
                workspace.created_at,
                workspace.updated_at
            ],
        )?;
        transaction.execute("DELETE FROM tabs WHERE workspace_id=?1", [&workspace.id])?;
        for (index, tab) in workspace.tabs.iter().enumerate() {
            validate_identifier("tab", &tab.id)?;
            validate_identifier("tab kind", &tab.kind)?;
            validate_json(&tab.state_json).with_context(|| format!("tab {:?}", tab.id))?;
            let position = i64::try_from(index).context("too many tabs in workspace")?;
            transaction.execute(
                "INSERT INTO tabs(id, workspace_id, kind, state_version, state_json, position)\
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    tab.id,
                    workspace.id,
                    tab.kind,
                    tab.state_version,
                    tab.state_json,
                    position
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn load_workspace(&self, workspace_id: &str) -> Result<Option<WorkspaceRecord>> {
        validate_identifier("workspace", workspace_id)?;
        let connection = self.connection()?;
        let workspace = connection
            .query_row(
                "SELECT id, title, created_at, updated_at FROM workspaces WHERE id=?1",
                [workspace_id],
                |row| {
                    Ok(WorkspaceRecord {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        created_at: row.get(2)?,
                        updated_at: row.get(3)?,
                        tabs: Vec::new(),
                    })
                },
            )
            .optional()?;
        let Some(mut workspace) = workspace else {
            return Ok(None);
        };
        let mut statement = connection.prepare(
            "SELECT id, kind, state_version, state_json, position FROM tabs \
             WHERE workspace_id=?1 ORDER BY position, id",
        )?;
        workspace.tabs = statement
            .query_map([workspace_id], |row| {
                Ok(TabRecord {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    state_version: row.get(2)?,
                    state_json: row.get(3)?,
                    position: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(workspace))
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

fn validate_identifier(label: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 255 {
        return Err(anyhow!("{label} identifier must be 1..=255 characters"));
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

    #[test]
    fn workspace_and_versioned_opaque_tabs_replace_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let store = AppStateStore::open(temp.path()).unwrap();
        let mut workspace = WorkspaceRecord {
            id: "main".into(),
            title: "Workspace".into(),
            created_at: 10,
            updated_at: 20,
            tabs: vec![
                TabRecord {
                    id: "second".into(),
                    kind: "browser".into(),
                    state_version: 7,
                    state_json: r#"{"url":"https://example.com"}"#.into(),
                    position: 99,
                },
                TabRecord {
                    id: "first".into(),
                    kind: "future-module".into(),
                    state_version: 42,
                    state_json: r#"{"unknown":true}"#.into(),
                    position: 0,
                },
            ],
        };
        store.save_workspace(&workspace).unwrap();
        let loaded = store.load_workspace("main").unwrap().unwrap();
        assert_eq!(loaded.tabs[0].position, 0);
        assert_eq!(loaded.tabs[1].position, 1);
        assert_eq!(loaded.tabs[1].kind, "future-module");
        assert_eq!(loaded.tabs[1].state_version, 42);

        workspace.tabs.remove(0);
        workspace.updated_at = 30;
        store.save_workspace(&workspace).unwrap();
        let replaced = store.load_workspace("main").unwrap().unwrap();
        assert_eq!(replaced.updated_at, 30);
        assert_eq!(replaced.tabs.len(), 1);
        assert_eq!(replaced.tabs[0].id, "first");
    }
}
