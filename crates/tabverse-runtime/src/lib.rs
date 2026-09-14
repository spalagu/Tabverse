use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

pub mod agent_ipc;

const HOST_STALE_AFTER_SECONDS: i64 = 5;
const SCHEMA_VERSION: i64 = 1;
const APPLICATION_ID: i64 = 0x5456_5233;
const TABLES: &[&str] = &[
    "runtime_hosts",
    "runtime_interruptions",
    "runtimes",
    "schema_migrations",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeRecord {
    pub id: String,
    pub kind: String,
    pub generation: u64,
    pub state: String,
    pub host_instance: String,
    pub checkpoint_json: Option<String>,
}

/// The Runtime Supervisor is the only writer of runtime.db. A GUI may ask the
/// supervisor for records over IPC, but it never receives a database handle.
#[derive(Clone, Debug)]
pub struct RuntimeStore {
    path: PathBuf,
    host_instance: String,
}

impl RuntimeStore {
    pub fn open(runtime_dir: &Path, host_instance: &str) -> Result<Self> {
        Self::open_at(
            runtime_dir,
            host_instance,
            unix_time(),
            HOST_STALE_AFTER_SECONDS,
        )
    }

    fn open_at(
        runtime_dir: &Path,
        host_instance: &str,
        now: i64,
        stale_after: i64,
    ) -> Result<Self> {
        std::fs::create_dir_all(runtime_dir).with_context(|| {
            format!("cannot create runtime directory {}", runtime_dir.display())
        })?;
        secure_dir(runtime_dir)?;
        let store = Self {
            path: runtime_dir.join("runtime.db"),
            host_instance: host_instance.to_owned(),
        };
        let existed = store.path.exists();
        if existed {
            validate_schema(&store.path)?;
        }
        let mut connection = store.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (\
               version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS runtimes (\
               id TEXT PRIMARY KEY, kind TEXT NOT NULL, generation INTEGER NOT NULL,\
               state TEXT NOT NULL, host_instance TEXT NOT NULL, checkpoint_json TEXT,\
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS runtime_interruptions (\
               id INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id TEXT NOT NULL, generation INTEGER NOT NULL,\
               reason TEXT NOT NULL, occurred_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS runtime_hosts (\
               instance TEXT PRIMARY KEY, heartbeat_at INTEGER NOT NULL, stopped_at INTEGER\
             );\
             INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());",
        )?;
        transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
        secure_database_files(&store.path)?;
        if !existed {
            validate_schema(&store.path)?;
        }
        claim_host(&connection, host_instance, now, stale_after)?;
        Ok(store)
    }

    /// Renew this supervisor's ownership lease. The helper calls this even
    /// while no runtime is producing output, so health is independent of load.
    pub fn heartbeat(&self) -> Result<()> {
        let changed = self.connection()?.execute(
            "UPDATE runtime_hosts SET heartbeat_at=?2 WHERE instance=?1 AND stopped_at IS NULL",
            params![self.host_instance, unix_time()],
        )?;
        anyhow::ensure!(changed == 1, "runtime host lease is no longer owned");
        Ok(())
    }

    /// Release the lease on a clean supervisor shutdown.
    pub fn release(&self) -> Result<()> {
        self.connection()?.execute(
            "UPDATE runtime_hosts SET stopped_at=?2 WHERE instance=?1 AND stopped_at IS NULL",
            params![self.host_instance, unix_time()],
        )?;
        Ok(())
    }

    pub fn put(&self, record: &RuntimeRecord) -> Result<()> {
        let generation = i64::try_from(record.generation).context("runtime generation overflow")?;
        self.connection()?.execute(
            "INSERT INTO runtimes(id, kind, generation, state, host_instance, checkpoint_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), unixepoch()) \
             ON CONFLICT(id) DO UPDATE SET generation=excluded.generation, state=excluded.state, \
               host_instance=excluded.host_instance, checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at",
            params![
                record.id,
                record.kind,
                generation,
                record.state,
                record.host_instance,
                record.checkpoint_json
            ],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<RuntimeRecord>> {
        self.connection()?
            .query_row(
                "SELECT id, kind, generation, state, host_instance, checkpoint_json FROM runtimes WHERE id=?1",
                [id],
                |row| {
                    Ok(RuntimeRecord {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        generation: generation_from_row(row, 2)?,
                        state: row.get(3)?,
                        host_instance: row.get(4)?,
                        checkpoint_json: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list(&self) -> Result<Vec<RuntimeRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, kind, generation, state, host_instance, checkpoint_json FROM runtimes ORDER BY created_at, id",
        )?;
        let records = statement
            .query_map([], |row| {
                Ok(RuntimeRecord {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    generation: generation_from_row(row, 2)?,
                    state: row.get(3)?,
                    host_instance: row.get(4)?,
                    checkpoint_json: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records)
    }

    pub fn interruption_count(&self, runtime_id: &str) -> Result<u64> {
        let count: i64 = self
            .connection()?
            .query_row(
                "SELECT count(*) FROM runtime_interruptions WHERE runtime_id=?1",
                [runtime_id],
                |row| row.get(0),
            )
            .map_err(anyhow::Error::from)?;
        u64::try_from(count).context("negative runtime interruption count")
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
        "{} is not the current V3 runtime.db schema",
        path.display()
    );
    for (table, expected) in [
        (
            "runtime_hosts",
            &["instance", "heartbeat_at", "stopped_at"][..],
        ),
        (
            "runtime_interruptions",
            &["id", "runtime_id", "generation", "reason", "occurred_at"][..],
        ),
        (
            "runtimes",
            &[
                "id",
                "kind",
                "generation",
                "state",
                "host_instance",
                "checkpoint_json",
                "created_at",
                "updated_at",
            ][..],
        ),
        ("schema_migrations", &["version", "applied_at"][..]),
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

fn generation_from_row(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn unix_time() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn claim_host(
    connection: &Connection,
    current_host: &str,
    now: i64,
    stale_after: i64,
) -> Result<()> {
    let transaction = connection.unchecked_transaction()?;
    let cutoff = now.saturating_sub(stale_after);
    let live_host: Option<String> = transaction
        .query_row(
            "SELECT instance FROM runtime_hosts WHERE instance<>?1 AND stopped_at IS NULL \
             AND heartbeat_at>?2 ORDER BY heartbeat_at DESC LIMIT 1",
            params![current_host, cutoff],
            |row| row.get(0),
        )
        .optional()?;
    anyhow::ensure!(
        live_host.is_none(),
        "runtime supervisor {} still owns runtime.db",
        live_host.unwrap_or_default()
    );
    transaction.execute(
        "INSERT INTO runtime_interruptions(runtime_id, generation, reason, occurred_at) \
         SELECT id, generation, 'runtime-host-stale', unixepoch() FROM runtimes \
         WHERE host_instance<>?1 AND state NOT IN ('stopped', 'exited', 'interrupted')",
        [current_host],
    )?;
    transaction.execute(
        "UPDATE runtimes SET state='interrupted', updated_at=unixepoch() \
         WHERE host_instance<>?1 AND state NOT IN ('stopped', 'exited', 'interrupted')",
        [current_host],
    )?;
    transaction.execute(
        "UPDATE runtime_hosts SET stopped_at=?2 WHERE instance<>?1 AND stopped_at IS NULL AND heartbeat_at<=?3",
        params![current_host, now, cutoff],
    )?;
    transaction.execute(
        "INSERT INTO runtime_hosts(instance, heartbeat_at, stopped_at) VALUES (?1, ?2, NULL) \
         ON CONFLICT(instance) DO UPDATE SET heartbeat_at=excluded.heartbeat_at, stopped_at=NULL",
        params![current_host, now],
    )?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(host: &str) -> RuntimeRecord {
        RuntimeRecord {
            id: "terminal-1".into(),
            kind: "terminal".into(),
            generation: 1,
            state: "attached".into(),
            host_instance: host.into(),
            checkpoint_json: None,
        }
    }

    #[test]
    fn runtime_identity_and_generation_persist() {
        let temp = tempfile::tempdir().unwrap();
        let store = RuntimeStore::open(temp.path(), "host-a").unwrap();
        store.put(&record("host-a")).unwrap();
        let mut next = store.get("terminal-1").unwrap().unwrap();
        next.generation = 2;
        next.state = "detached".into();
        store.put(&next).unwrap();
        assert_eq!(store.list().unwrap(), [next]);
    }

    #[test]
    fn a_noncurrent_runtime_database_is_rejected_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("runtime.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE old_runtime(value TEXT); INSERT INTO old_runtime VALUES ('kept');",
            )
            .unwrap();
        drop(connection);

        assert!(RuntimeStore::open(temp.path(), "host-a").is_err());
        let connection = Connection::open(&path).unwrap();
        let value: String = connection
            .query_row("SELECT value FROM old_runtime", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "kept");
        assert!(connection.prepare("SELECT * FROM runtimes").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn runtime_database_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        RuntimeStore::open(temp.path(), "host-a").unwrap();
        assert_eq!(
            std::fs::metadata(temp.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(temp.path().join("runtime.db"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn a_new_host_marks_expired_records_interrupted_without_fake_recovery() {
        let temp = tempfile::tempdir().unwrap();
        RuntimeStore::open_at(temp.path(), "host-a", 0, 5)
            .unwrap()
            .put(&record("host-a"))
            .unwrap();

        let next_host = RuntimeStore::open_at(temp.path(), "host-b", 10, 5).unwrap();
        let stale = next_host.get("terminal-1").unwrap().unwrap();
        assert_eq!(stale.state, "interrupted");
        assert_eq!(stale.generation, 1);
        assert_eq!(next_host.interruption_count("terminal-1").unwrap(), 1);

        next_host.release().unwrap();
        let reopened = RuntimeStore::open_at(temp.path(), "host-c", 11, 5).unwrap();
        assert_eq!(reopened.interruption_count("terminal-1").unwrap(), 1);
    }

    #[test]
    fn stopped_runtime_is_not_reported_as_interrupted() {
        let temp = tempfile::tempdir().unwrap();
        let first = RuntimeStore::open_at(temp.path(), "host-a", 0, 5).unwrap();
        let mut stopped = record("host-a");
        stopped.state = "stopped".into();
        first.put(&stopped).unwrap();
        first.release().unwrap();
        let second = RuntimeStore::open_at(temp.path(), "host-b", 1, 5).unwrap();
        assert_eq!(second.get("terminal-1").unwrap().unwrap().state, "stopped");
        assert_eq!(second.interruption_count("terminal-1").unwrap(), 0);
    }

    #[test]
    fn a_live_host_excludes_a_second_runtime_database_writer() {
        let temp = tempfile::tempdir().unwrap();
        let first = RuntimeStore::open_at(temp.path(), "host-a", 100, 5).unwrap();
        first.put(&record("host-a")).unwrap();

        let error = RuntimeStore::open_at(temp.path(), "host-b", 104, 5).unwrap_err();
        assert!(error.to_string().contains("host-a still owns runtime.db"));
        assert_eq!(first.get("terminal-1").unwrap().unwrap().state, "attached");
    }

    #[test]
    fn an_expired_host_is_interrupted_once_and_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let first = RuntimeStore::open_at(temp.path(), "host-a", 100, 5).unwrap();
        first.put(&record("host-a")).unwrap();

        let second = RuntimeStore::open_at(temp.path(), "host-b", 106, 5).unwrap();
        assert_eq!(
            second.get("terminal-1").unwrap().unwrap().state,
            "interrupted"
        );
        assert_eq!(second.interruption_count("terminal-1").unwrap(), 1);
    }
}
