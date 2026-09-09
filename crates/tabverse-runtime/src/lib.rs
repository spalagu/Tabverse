use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

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
#[derive(Clone)]
pub struct RuntimeStore {
    path: PathBuf,
}

impl RuntimeStore {
    pub fn open(runtime_dir: &Path, host_instance: &str) -> Result<Self> {
        std::fs::create_dir_all(runtime_dir).with_context(|| {
            format!("cannot create runtime directory {}", runtime_dir.display())
        })?;
        let store = Self {
            path: runtime_dir.join("runtime.db"),
        };
        let connection = store.connection()?;
        connection.execute_batch(
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
             INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());",
        )?;
        mark_stale_hosts(&connection, host_instance)?;
        Ok(store)
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
        Ok(connection)
    }
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

fn mark_stale_hosts(connection: &Connection, current_host: &str) -> Result<()> {
    let transaction = connection.unchecked_transaction()?;
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
    fn a_new_host_marks_live_records_interrupted_without_fake_recovery() {
        let temp = tempfile::tempdir().unwrap();
        RuntimeStore::open(temp.path(), "host-a")
            .unwrap()
            .put(&record("host-a"))
            .unwrap();

        let next_host = RuntimeStore::open(temp.path(), "host-b").unwrap();
        let stale = next_host.get("terminal-1").unwrap().unwrap();
        assert_eq!(stale.state, "interrupted");
        assert_eq!(stale.generation, 1);
        assert_eq!(next_host.interruption_count("terminal-1").unwrap(), 1);

        drop(next_host);
        let reopened = RuntimeStore::open(temp.path(), "host-c").unwrap();
        assert_eq!(reopened.interruption_count("terminal-1").unwrap(), 1);
    }

    #[test]
    fn stopped_runtime_is_not_reported_as_interrupted() {
        let temp = tempfile::tempdir().unwrap();
        let first = RuntimeStore::open(temp.path(), "host-a").unwrap();
        let mut stopped = record("host-a");
        stopped.state = "stopped".into();
        first.put(&stopped).unwrap();
        let second = RuntimeStore::open(temp.path(), "host-b").unwrap();
        assert_eq!(second.get("terminal-1").unwrap().unwrap().state, "stopped");
        assert_eq!(second.interruption_count("terminal-1").unwrap(), 0);
    }
}
