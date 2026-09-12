use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

pub const MAX_STATE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SCOPE_LEN: usize = 120;
const SCHEMA_VERSION: i64 = 1;
const APPLICATION_ID: i64 = 0x5456_4233;
const TABLES: &[&str] = &[
    "content_preferences",
    "credential_vault",
    "schema_migrations",
    "settings",
    "state_scopes",
];

/// The desktop-owned durable store. Workbench talks to this through narrow
/// state commands and never opens SQLite itself.
#[derive(Clone)]
pub struct AppStateStore {
    path: PathBuf,
}

impl AppStateStore {
    pub fn open(app_data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(app_data_dir)
            .with_context(|| format!("cannot create app data dir {}", app_data_dir.display()))?;
        secure_dir(app_data_dir)?;
        let store = Self {
            path: app_data_dir.join("app.db"),
        };
        let existed = store.path.exists();
        if existed {
            validate_schema(&store.path)?;
        }
        let mut connection = store.connection()?;
        store.initialize(&mut connection)?;
        if !existed {
            validate_schema(&store.path)?;
        }
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

    /// Apply related scope writes and deletes as one durable change.
    pub fn change_scopes(&self, saves: &[(&str, &str)], deletes: &[&str]) -> Result<()> {
        for (scope, json) in saves {
            validate_scope(scope)?;
            validate_json(json)?;
            if json.len() > MAX_STATE_BYTES {
                return Err(anyhow!(
                    "state for scope {scope:?} is {} bytes, above the {} MiB limit",
                    json.len(),
                    MAX_STATE_BYTES / (1024 * 1024)
                ));
            }
        }
        for scope in deletes {
            validate_scope(scope)?;
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        for (scope, json) in saves {
            transaction.execute(
                "INSERT INTO state_scopes(scope, json, updated_at) VALUES (?1, ?2, unixepoch())\
                 ON CONFLICT(scope) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
                params![scope, json],
            )?;
        }
        for scope in deletes {
            transaction.execute("DELETE FROM state_scopes WHERE scope=?1", [scope])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_scopes(&self) -> Result<Vec<String>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT scope FROM state_scopes ORDER BY scope")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn load_credential_vault(&self, id: &str) -> Result<Option<Vec<u8>>> {
        validate_identifier("credential vault", id)?;
        self.connection()?
            .query_row(
                "SELECT ciphertext FROM credential_vault WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn save_credential_vault(&self, id: &str, ciphertext: &[u8]) -> Result<()> {
        validate_identifier("credential vault", id)?;
        if ciphertext.is_empty() {
            return Err(anyhow!("credential vault ciphertext must not be empty"));
        }
        self.connection()?.execute(
            "INSERT INTO credential_vault(id, ciphertext, updated_at) VALUES (?1, ?2, unixepoch())\
             ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at",
            params![id, ciphertext],
        )?;
        Ok(())
    }

    /// Replace one opaque credential record only if it has not changed since
    /// the caller read it. This is the cross-process guard used by background
    /// credential refresh; explicit login/logout remains an unconditional
    /// user action.
    pub fn compare_exchange_credential_vault(
        &self,
        id: &str,
        expected: &[u8],
        replacement: &[u8],
    ) -> Result<bool> {
        validate_identifier("credential vault", id)?;
        if expected.is_empty() || replacement.is_empty() {
            return Err(anyhow!("credential vault ciphertext must not be empty"));
        }
        let changed = self.connection()?.execute(
            "UPDATE credential_vault SET ciphertext=?1, updated_at=unixepoch() \
             WHERE id=?2 AND ciphertext=?3",
            params![replacement, id, expected],
        )?;
        Ok(changed == 1)
    }

    pub fn load_setting(&self, key: &str) -> Result<Option<String>> {
        validate_identifier("setting", key)?;
        self.connection()?
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn save_setting(&self, key: &str, value_json: &str) -> Result<()> {
        validate_identifier("setting", key)?;
        validate_json(value_json)?;
        self.connection()?.execute(
            "INSERT INTO settings(key, value_json, updated_at) VALUES (?1, ?2, unixepoch())\
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            params![key, value_json],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        validate_identifier("setting", key)?;
        self.connection()?
            .execute("DELETE FROM settings WHERE key=?1", [key])?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<Vec<(String, String)>> {
        let connection = self.connection()?;
        let mut statement =
            connection.prepare("SELECT key, value_json FROM settings ORDER BY key")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn load_content_preference(&self, content_type: &str) -> Result<Option<String>> {
        validate_identifier("content type", content_type)?;
        self.connection()?
            .query_row(
                "SELECT handler_id FROM content_preferences WHERE content_type=?1",
                [content_type],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn save_content_preference(&self, content_type: &str, handler_id: &str) -> Result<()> {
        validate_identifier("content type", content_type)?;
        validate_identifier("content handler", handler_id)?;
        self.connection()?.execute(
            "INSERT INTO content_preferences(content_type, handler_id, updated_at) VALUES (?1, ?2, unixepoch())\
             ON CONFLICT(content_type) DO UPDATE SET handler_id=excluded.handler_id, updated_at=excluded.updated_at",
            params![content_type, handler_id],
        )?;
        Ok(())
    }

    pub fn delete_content_preference(&self, content_type: &str) -> Result<()> {
        validate_identifier("content type", content_type)?;
        self.connection()?.execute(
            "DELETE FROM content_preferences WHERE content_type=?1",
            [content_type],
        )?;
        Ok(())
    }

    /// Restore settings only. User content, site decisions, credentials, and
    /// default-application rollback data are not factory settings.
    pub fn factory_reset(&self) -> Result<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM settings", [])?;
        transaction.execute("DELETE FROM content_preferences", [])?;
        transaction.commit()?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.path)
            .with_context(|| format!("cannot open {}", self.path.display()))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "busy_timeout", 5_000_i64)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        secure_database_files(&self.path)?;
        Ok(connection)
    }

    fn initialize(&self, connection: &mut Connection) -> Result<()> {
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (\
               version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS settings (\
               key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS content_preferences (\
               content_type TEXT PRIMARY KEY, handler_id TEXT NOT NULL, updated_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS state_scopes (\
               scope TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS credential_vault (\
               id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL\
             );",
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, unixepoch())",
            [SCHEMA_VERSION],
        )?;
        transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
        secure_database_files(&self.path)?;
        Ok(())
    }
}

fn validate_schema(path: &Path) -> Result<()> {
    use rusqlite::OpenFlags;
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("cannot inspect {}", path.display()))?;
    let application_id: i64 =
        connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master \
         WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let tables = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let versions = connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default();
    let columns = |table: &str| -> rusqlite::Result<Vec<String>> {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect();
        columns
    };
    anyhow::ensure!(
        application_id == APPLICATION_ID
            && user_version == SCHEMA_VERSION
            && tables == TABLES
            && versions == [SCHEMA_VERSION],
        "{} is not the current V3 app.db schema",
        path.display()
    );
    for (table, expected) in [
        (
            "content_preferences",
            &["content_type", "handler_id", "updated_at"][..],
        ),
        ("credential_vault", &["id", "ciphertext", "updated_at"][..]),
        ("schema_migrations", &["version", "applied_at"][..]),
        ("settings", &["key", "value_json", "updated_at"][..]),
        ("state_scopes", &["scope", "json", "updated_at"][..]),
    ] {
        anyhow::ensure!(
            columns(table)? == expected,
            "{} has a noncurrent {table} table",
            path.display()
        );
    }
    Ok(())
}

#[cfg(unix)]
fn secure_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .with_context(|| format!("cannot secure {}", path.display()))
}

#[cfg(not(unix))]
fn secure_dir(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn secure_database_files(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    for candidate in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        if candidate.exists() {
            std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600))
                .with_context(|| format!("cannot secure {}", candidate.display()))?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_database_files(_path: &Path) -> Result<()> {
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_database_contains_only_the_current_model() {
        let temp = tempfile::tempdir().unwrap();
        let store = AppStateStore::open(temp.path()).unwrap();
        let connection = store.connection().unwrap();
        let mut statement = connection
            .prepare(
                "SELECT name FROM sqlite_master \
                 WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap();
        let tables = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            tables,
            [
                "content_preferences",
                "credential_vault",
                "schema_migrations",
                "settings",
                "state_scopes",
            ]
        );
    }

    #[test]
    fn a_noncurrent_database_is_rejected_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE old_state(value TEXT); INSERT INTO old_state VALUES ('kept');",
            )
            .unwrap();
        drop(connection);

        assert!(AppStateStore::open(temp.path()).is_err());
        let connection = Connection::open(&path).unwrap();
        let value: String = connection
            .query_row("SELECT value FROM old_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "kept");
        assert!(connection.prepare("SELECT * FROM state_scopes").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn app_database_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        AppStateStore::open(temp.path()).unwrap();
        assert_eq!(
            std::fs::metadata(temp.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(temp.path().join("app.db"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

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
    fn related_scope_changes_commit_together() {
        let temp = tempfile::tempdir().unwrap();
        let store = AppStateStore::open(temp.path()).unwrap();
        store.save_scope("one", r#"{"value":1}"#).unwrap();
        store.save_scope("gone", r#"{"value":0}"#).unwrap();
        store
            .change_scopes(
                &[("one", r#"{"value":2}"#), ("two", r#"{"value":3}"#)],
                &["gone"],
            )
            .unwrap();
        assert_eq!(
            store.load_scope("one").unwrap().as_deref(),
            Some(r#"{"value":2}"#)
        );
        assert_eq!(
            store.load_scope("two").unwrap().as_deref(),
            Some(r#"{"value":3}"#)
        );
        assert!(store.load_scope("gone").unwrap().is_none());

        assert!(store
            .change_scopes(&[("one", r#"{"value":4}"#), ("two", "not-json")], &[])
            .is_err());
        assert_eq!(
            store.load_scope("one").unwrap().as_deref(),
            Some(r#"{"value":2}"#)
        );
    }

    #[test]
    fn legacy_files_are_ignored() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("state");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("session.json"), r#"{"old":true}"#).unwrap();

        let store = AppStateStore::open(temp.path()).unwrap();
        assert!(store.load_scope("session").unwrap().is_none());
        assert_eq!(store.list_scopes().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn encrypted_credential_vault_round_trips_as_an_opaque_blob() {
        let temp = tempfile::tempdir().unwrap();
        let store = AppStateStore::open(temp.path()).unwrap();
        let first = b"not plaintext credentials, only caller-owned ciphertext";
        store
            .save_credential_vault("browser-logins-v2", first)
            .unwrap();
        assert_eq!(
            store
                .load_credential_vault("browser-logins-v2")
                .unwrap()
                .as_deref(),
            Some(first.as_slice())
        );

        let replacement = b"replacement ciphertext";
        store
            .save_credential_vault("browser-logins-v2", replacement)
            .unwrap();
        assert_eq!(
            store
                .load_credential_vault("browser-logins-v2")
                .unwrap()
                .as_deref(),
            Some(replacement.as_slice())
        );
        assert!(!store
            .compare_exchange_credential_vault("browser-logins-v2", first, b"stale replacement")
            .unwrap());
        assert!(store
            .compare_exchange_credential_vault(
                "browser-logins-v2",
                replacement,
                b"current replacement"
            )
            .unwrap());
        assert!(store.save_credential_vault("", replacement).is_err());
        assert!(store
            .save_credential_vault("browser-logins-v2", b"")
            .is_err());
    }

    #[test]
    fn settings_are_validated_and_owned_by_app_db() {
        let temp = tempfile::tempdir().unwrap();
        let store = AppStateStore::open(temp.path()).unwrap();

        store.save_setting("appearance.theme", r#""dark""#).unwrap();
        store.save_setting("terminal.font_size", "14").unwrap();
        assert_eq!(
            store.load_settings().unwrap(),
            [
                ("appearance.theme".to_string(), r#""dark""#.to_string()),
                ("terminal.font_size".to_string(), "14".to_string()),
            ]
        );
        assert!(store.save_setting("broken", "not-json").is_err());
        store.delete_setting("appearance.theme").unwrap();
        assert!(store.load_setting("appearance.theme").unwrap().is_none());
    }

    #[test]
    fn content_preferences_round_trip_by_content_type() {
        let temp = tempfile::tempdir().unwrap();
        let store = AppStateStore::open(temp.path()).unwrap();

        store
            .save_content_preference("text/markdown", "markdown-preview")
            .unwrap();
        assert_eq!(
            store
                .load_content_preference("text/markdown")
                .unwrap()
                .as_deref(),
            Some("markdown-preview")
        );
        store.delete_content_preference("text/markdown").unwrap();
        assert!(store
            .load_content_preference("text/markdown")
            .unwrap()
            .is_none());
    }

    #[test]
    fn factory_reset_is_atomic_and_keeps_every_user_data_scope_and_credential() {
        let temp = tempfile::tempdir().unwrap();
        let store = AppStateStore::open(temp.path()).unwrap();
        store.save_setting("appearance.theme", r#""dark""#).unwrap();
        store
            .save_content_preference("text/plain", "editor")
            .unwrap();
        store.save_scope("session", r#"{"tabs":[]}"#).unwrap();
        store
            .save_scope("default-apps-backup", r#"{"browser":["old"]}"#)
            .unwrap();
        store
            .save_credential_vault("browser-logins-v2", b"sealed")
            .unwrap();

        store.factory_reset().unwrap();
        assert!(store.load_settings().unwrap().is_empty());
        assert!(store
            .load_content_preference("text/plain")
            .unwrap()
            .is_none());
        assert!(store.load_scope("session").unwrap().is_some());
        assert!(store.load_scope("default-apps-backup").unwrap().is_some());
        assert!(store
            .load_credential_vault("browser-logins-v2")
            .unwrap()
            .is_some());
    }
}
