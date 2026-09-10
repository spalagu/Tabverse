//! The session log: append-only JSONL, one record per line.
//!
//! It serves three readers at once, which is why it is the event stream on disk
//! rather than a bespoke save format. Restarting the app replays it to rebuild
//! the tab; a remote viewer joining late is handed it as history; and a future
//! compaction pass reads the conversation out of it. Append-only matters for the
//! same reason it does in any log: a crash mid-write loses at most the last line
//! instead of corrupting what came before.
//!
//! Two record kinds. Events are what the UI renders. Messages are what the model
//! is sent. Deriving one from the other is possible but lossy in both directions
//! — the assistant's tool_call ids are not in the event stream, and the deltas
//! are not in the messages — so both are written and each is read by whoever
//! needs it.
//!
//! Every line carries a version. A reader that meets a line it does not
//! understand skips it and keeps going: a log written by a newer build must
//! still open in an older one, minus whatever it cannot represent.

use crate::event::SessionEvent;
use crate::provider::Message;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// Bumped when a record's meaning changes, not when a field is added.
pub const LOG_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Record {
    Event { v: u32, data: SessionEvent },
    Message { v: u32, data: Message },
}

/// What a log replays into.
#[derive(Debug, Default)]
pub struct Replay {
    /// For the UI and for a joining viewer.
    pub events: Vec<SessionEvent>,
    /// For continuing the conversation with the model.
    pub messages: Vec<Message>,
    /// Lines that could not be understood. Non-zero is not an error — a newer
    /// build may have written records this one has no type for — but it is
    /// worth surfacing rather than hiding.
    pub skipped: usize,
}

pub struct SessionLog {
    path: PathBuf,
    file: File,
}

impl SessionLog {
    /// Open for appending, creating it and any missing parents.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("failed to open the session log at {}", path.display()))?;
        Ok(Self { path, file })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append_event(&mut self, event: &SessionEvent) -> Result<()> {
        self.write(&Record::Event {
            v: LOG_VERSION,
            data: event.clone(),
        })
    }

    pub fn append_message(&mut self, message: &Message) -> Result<()> {
        self.write(&Record::Message {
            v: LOG_VERSION,
            data: message.clone(),
        })
    }

    fn write(&mut self, record: &Record) -> Result<()> {
        let mut line = serde_json::to_string(record)?;
        line.push('\n');
        self.file.write_all(line.as_bytes())?;
        // Flushed per record: the value of this file is entirely in surviving a
        // crash, and buffering would trade exactly that away.
        self.file.flush()?;
        Ok(())
    }

    /// Read a log back. A missing file replays as empty — a tab that never ran
    /// anything is not an error.
    pub fn replay(path: impl AsRef<Path>) -> Result<Replay> {
        let path = path.as_ref();
        if !path.exists() {
            return Ok(Replay::default());
        }
        let file = File::open(path)
            .with_context(|| format!("failed to read the session log at {}", path.display()))?;
        let mut replay = Replay::default();
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else {
                replay.skipped += 1;
                continue;
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Record>(&line) {
                Ok(Record::Event { data, .. }) => replay.events.push(data),
                Ok(Record::Message { data, .. }) => replay.messages.push(data),
                // A truncated final line (the crash this format exists for) and
                // a record kind from a newer build both land here.
                Err(_) => replay.skipped += 1,
            }
        }
        Ok(replay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{PermissionOutcome, StopReason};
    use crate::provider::ToolCall;

    fn temp_log() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions/s1.jsonl");
        (dir, path)
    }

    #[test]
    fn events_round_trip_in_order() {
        let (_dir, path) = temp_log();
        let mut log = SessionLog::open(&path).unwrap();
        log.append_event(&SessionEvent::UserPrompt {
            text: "do the thing".into(),
        })
        .unwrap();
        log.append_event(&SessionEvent::TurnStarted { turn: 1 })
            .unwrap();
        log.append_event(&SessionEvent::AssistantText { delta: "ok".into() })
            .unwrap();
        log.append_event(&SessionEvent::TurnEnded {
            turn: 1,
            reason: StopReason::Done,
        })
        .unwrap();

        let replay = SessionLog::replay(&path).unwrap();
        assert_eq!(replay.events.len(), 4);
        assert_eq!(replay.skipped, 0);
        assert_eq!(
            replay.events[0],
            SessionEvent::UserPrompt {
                text: "do the thing".into()
            },
            "the prompt must survive, or a replay shows an agent acting for no reason"
        );
        assert_eq!(
            replay.events[3],
            SessionEvent::TurnEnded {
                turn: 1,
                reason: StopReason::Done
            }
        );
    }

    #[test]
    fn messages_round_trip_so_the_conversation_can_continue() {
        let (_dir, path) = temp_log();
        let mut log = SessionLog::open(&path).unwrap();
        let assistant = Message::Assistant {
            text: "looking".into(),
            tool_calls: vec![ToolCall {
                id: "c1".into(),
                name: "read".into(),
                input: serde_json::json!({ "path": "a.txt" }),
            }],
        };
        log.append_message(&Message::User { text: "go".into() })
            .unwrap();
        log.append_message(&assistant).unwrap();
        log.append_message(&Message::ToolResult {
            call_id: "c1".into(),
            content: "contents".into(),
            is_error: false,
        })
        .unwrap();

        let replay = SessionLog::replay(&path).unwrap();
        assert_eq!(replay.messages.len(), 3);
        // The tool_call id has to survive: without it the next request cannot
        // pair the result with the call that asked for it.
        assert_eq!(replay.messages[1], assistant);
    }

    #[test]
    fn events_and_messages_share_the_file_without_confusing_each_other() {
        let (_dir, path) = temp_log();
        let mut log = SessionLog::open(&path).unwrap();
        log.append_event(&SessionEvent::TurnStarted { turn: 1 })
            .unwrap();
        log.append_message(&Message::User { text: "go".into() })
            .unwrap();
        log.append_event(&SessionEvent::PermissionResolved {
            call_id: "c1".into(),
            outcome: PermissionOutcome::Approved,
        })
        .unwrap();

        let replay = SessionLog::replay(&path).unwrap();
        assert_eq!(replay.events.len(), 2);
        assert_eq!(replay.messages.len(), 1);
    }

    #[test]
    fn appending_continues_an_existing_log_rather_than_replacing_it() {
        let (_dir, path) = temp_log();
        {
            let mut first = SessionLog::open(&path).unwrap();
            first
                .append_event(&SessionEvent::TurnStarted { turn: 1 })
                .unwrap();
        }
        {
            let mut second = SessionLog::open(&path).unwrap();
            second
                .append_event(&SessionEvent::TurnStarted { turn: 2 })
                .unwrap();
        }
        let replay = SessionLog::replay(&path).unwrap();
        assert_eq!(
            replay.events.len(),
            2,
            "reopening must append, not truncate"
        );
    }

    #[test]
    fn a_truncated_last_line_costs_only_that_line() {
        // Exactly what a crash mid-write leaves behind.
        let (_dir, path) = temp_log();
        let mut log = SessionLog::open(&path).unwrap();
        log.append_event(&SessionEvent::TurnStarted { turn: 1 })
            .unwrap();
        log.append_event(&SessionEvent::AssistantText {
            delta: "kept".into(),
        })
        .unwrap();
        drop(log);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"kind\":\"event\",\"v\":1,\"data\":{\"type\":\"assis");
        std::fs::write(&path, raw).unwrap();

        let replay = SessionLog::replay(&path).unwrap();
        assert_eq!(
            replay.events.len(),
            2,
            "whole records before the tear survive"
        );
        assert_eq!(replay.skipped, 1);
    }

    #[test]
    fn a_record_kind_from_a_newer_build_is_skipped_not_fatal() {
        let (_dir, path) = temp_log();
        let mut log = SessionLog::open(&path).unwrap();
        log.append_event(&SessionEvent::TurnStarted { turn: 1 })
            .unwrap();
        drop(log);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"kind\":\"telemetry\",\"v\":2,\"data\":{\"tokens\":42}}\n");
        raw.push_str(
            &serde_json::to_string(&Record::Event {
                v: LOG_VERSION,
                data: SessionEvent::TurnEnded {
                    turn: 1,
                    reason: StopReason::Done,
                },
            })
            .unwrap(),
        );
        raw.push('\n');
        std::fs::write(&path, raw).unwrap();

        let replay = SessionLog::replay(&path).unwrap();
        assert_eq!(
            replay.events.len(),
            2,
            "reading must continue past the unknown kind"
        );
        assert_eq!(replay.skipped, 1);
    }

    #[test]
    fn every_line_carries_a_version() {
        let (_dir, path) = temp_log();
        let mut log = SessionLog::open(&path).unwrap();
        log.append_event(&SessionEvent::TurnStarted { turn: 1 })
            .unwrap();
        log.append_message(&Message::User { text: "go".into() })
            .unwrap();
        drop(log);

        for line in std::fs::read_to_string(&path).unwrap().lines() {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(
                value["v"], LOG_VERSION,
                "a line without a version cannot be migrated"
            );
        }
    }

    #[test]
    fn a_log_that_was_never_written_replays_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let replay = SessionLog::replay(dir.path().join("absent.jsonl")).unwrap();
        assert!(replay.events.is_empty());
        assert!(replay.messages.is_empty());
    }
}
