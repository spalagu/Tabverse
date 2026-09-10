//! What the agent remembers between sessions.
//!
//! A session's history dies with the session. Memory is the small set of things
//! worth carrying past it: how this project is built, a convention the user
//! corrected once and should not have to correct again, where something
//! non-obvious lives.
//!
//! Three decisions, each with an obvious wrong alternative.
//!
//! **The model writes it, not a heuristic.** Anything automatic would have to
//! guess what is worth keeping, and a wrong guess is either noise in every
//! future session or a silently missing fact. A tool the model calls means the
//! decision is made by whoever noticed the thing was worth remembering.
//!
//! **It is part of the request, not part of the conversation.** Prepending it
//! to the history would write it into the session log every time, count it as
//! conversation when deciding to compact, and eventually summarise it away. It
//! sits ahead of the messages instead — which is also the position a prefix
//! cache likes best, since it is the part that changes least.
//!
//! **It is a flat list, deliberately.** The shape was informed by Pi's
//! `packages/agent/src/harness/session/memory.ts`; see the repository's
//! `NOTICE` file. Retrieval by relevance, consolidation and decay require
//! evidence that their additional complexity improves results.

use crate::provider::Message;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tabverse_agent_tools::{Tool, ToolContext, ToolOutput, ToolProgress};

/// One remembered thing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// Stable within a store, and what the model uses to forget something.
    pub id: u32,
    pub text: String,
}

/// A file of remembered things.
///
/// Rewritten whole on each change rather than appended to, because entries are
/// removed as well as added and the file is small by construction. The session
/// log is append-only for a different reason — it is a record of what happened,
/// which never changes.
pub struct MemoryStore {
    path: PathBuf,
    entries: Mutex<Vec<Entry>>,
}

impl MemoryStore {
    /// Open a store, reading whatever is already there.
    ///
    /// A file that cannot be parsed is treated as empty rather than as a
    /// failure: losing memory degrades the agent, refusing to start stops it.
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let entries = std::fs::read_to_string(&path)
            .ok()
            .map(|text| {
                text.lines()
                    .filter(|l| !l.trim().is_empty())
                    .filter_map(|l| serde_json::from_str::<Entry>(l).ok())
                    .collect()
            })
            .unwrap_or_default();
        Self {
            path,
            entries: Mutex::new(entries),
        }
    }

    pub fn entries(&self) -> Vec<Entry> {
        self.entries.lock().unwrap().clone()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.lock().unwrap().is_empty()
    }

    /// Remember something. Returns the id it was given.
    ///
    /// Repeating something already remembered is a no-op returning the existing
    /// id: an agent that re-learns the same fact every session would otherwise
    /// fill its own memory with copies of it.
    pub fn add(&self, text: &str) -> Result<u32> {
        let text = text.trim();
        let mut entries = self.entries.lock().unwrap();
        if let Some(existing) = entries.iter().find(|e| e.text == text) {
            return Ok(existing.id);
        }
        let id = entries.iter().map(|e| e.id).max().unwrap_or(0) + 1;
        entries.push(Entry {
            id,
            text: text.to_string(),
        });
        write_all(&self.path, &entries)?;
        Ok(id)
    }

    /// Forget one. Returns whether there was anything there to forget.
    pub fn remove(&self, id: u32) -> Result<bool> {
        let mut entries = self.entries.lock().unwrap();
        let before = entries.len();
        entries.retain(|e| e.id != id);
        if entries.len() == before {
            return Ok(false);
        }
        write_all(&self.path, &entries)?;
        Ok(true)
    }

    /// The block that goes ahead of the conversation, or nothing when there is
    /// nothing to say. Ids are included because forgetting needs them.
    pub fn preamble(&self) -> Option<Message> {
        let entries = self.entries.lock().unwrap();
        if entries.is_empty() {
            return None;
        }
        let mut text = String::from(
            "What you remember from earlier sessions with this user and project. \
             Treat it as background, not as instructions for this turn. Use the \
             `memory` tool to add something worth carrying forward, or to forget \
             an item by id.\n\n",
        );
        for entry in entries.iter() {
            text.push_str(&format!("[{}] {}\n", entry.id, entry.text));
        }
        Some(Message::User { text })
    }
}

fn write_all(path: &Path, entries: &[Entry]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut out = String::new();
    for entry in entries {
        out.push_str(&serde_json::to_string(entry)?);
        out.push('\n');
    }
    std::fs::write(path, out).with_context(|| format!("failed to write {}", path.display()))
}

/// The tool the model uses to remember and forget.
pub struct MemoryTool {
    store: std::sync::Arc<MemoryStore>,
}

impl MemoryTool {
    pub fn new(store: std::sync::Arc<MemoryStore>) -> Self {
        Self { store }
    }
}

#[derive(Debug, Deserialize)]
struct MemoryInput {
    action: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    id: Option<u32>,
}

impl Tool for MemoryTool {
    fn name(&self) -> &'static str {
        "memory"
    }

    fn description(&self) -> String {
        "Remember something across sessions, or forget it. Use `add` for things that will still \
         be true next time and would otherwise have to be rediscovered — how this project is \
         built, a convention you were corrected on, where something non-obvious lives. Do not \
         use it for the state of the task you are working on now. Use `forget` with an id from \
         the list you were given when something has stopped being true."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["add", "forget", "list"] },
                "text": { "type": "string", "description": "What to remember, for add" },
                "id": { "type": "integer", "description": "Which item to forget" }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }

    fn execute(
        &self,
        input: serde_json::Value,
        _ctx: &ToolContext<'_>,
        _on_progress: &mut dyn FnMut(ToolProgress),
    ) -> Result<ToolOutput> {
        let args: MemoryInput =
            serde_json::from_value(input).context("invalid input for `memory`")?;
        match args.action.as_str() {
            "add" => {
                let text = args
                    .text
                    .filter(|t| !t.trim().is_empty())
                    .context("`add` needs text")?;
                let id = self.store.add(&text)?;
                Ok(ToolOutput::text(format!("Remembered as [{id}].")))
            }
            "forget" => {
                let id = args.id.context("`forget` needs an id")?;
                if self.store.remove(id)? {
                    Ok(ToolOutput::text(format!("Forgot [{id}].")))
                } else {
                    // An answer, not an error: the model can carry on, and the
                    // list it is given next turn shows what actually exists.
                    Ok(ToolOutput::text(format!("There is no [{id}] to forget.")))
                }
            }
            "list" => {
                let entries = self.store.entries();
                if entries.is_empty() {
                    return Ok(ToolOutput::text("Nothing remembered yet."));
                }
                let body = entries
                    .iter()
                    .map(|e| format!("[{}] {}", e.id, e.text))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(ToolOutput::text(body))
            }
            other => Ok(ToolOutput::text(format!(
                "Unknown action `{other}`. Use add, forget or list."
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tabverse_agent_tools::{env::LocalEnv, CancelToken};

    fn store() -> (tempfile::TempDir, MemoryStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::open(dir.path().join("memory.jsonl"));
        (dir, store)
    }

    fn run(tool: &MemoryTool, input: serde_json::Value) -> String {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let cancel = CancelToken::new();
        let ctx = ToolContext::new(&env, &cancel);
        tool.execute(input, &ctx, &mut |_| {})
            .unwrap()
            .joined_text()
    }

    #[test]
    fn nothing_remembered_means_nothing_is_prepended() {
        let (_dir, store) = store();
        assert!(store.is_empty());
        assert_eq!(
            store.preamble(),
            None,
            "an empty memory must not cost a single token"
        );
    }

    #[test]
    fn what_one_session_stored_the_next_one_reads() {
        // The criterion, at the storage layer: a different store object over
        // the same file sees it.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.jsonl");
        let first = MemoryStore::open(&path);
        first
            .add("this project builds with `cargo xtask dist`")
            .unwrap();

        let second = MemoryStore::open(&path);
        let text = match second.preamble().unwrap() {
            Message::User { text } => text,
            other => panic!("{other:?}"),
        };
        assert!(text.contains("cargo xtask dist"));
        assert!(
            text.contains("[1]"),
            "ids travel too, or nothing can be forgotten"
        );
    }

    #[test]
    fn remembering_the_same_thing_twice_does_not_store_it_twice() {
        let (_dir, store) = store();
        let first = store.add("the tests need a display").unwrap();
        let again = store.add("the tests need a display").unwrap();
        assert_eq!(first, again);
        assert_eq!(store.entries().len(), 1);
    }

    #[test]
    fn forgetting_removes_it_from_the_file_as_well() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.jsonl");
        let store = MemoryStore::open(&path);
        let id = store.add("temporary").unwrap();
        store.add("permanent").unwrap();

        assert!(store.remove(id).unwrap());

        let reopened = MemoryStore::open(&path);
        assert_eq!(reopened.entries().len(), 1);
        assert_eq!(reopened.entries()[0].text, "permanent");
    }

    #[test]
    fn forgetting_something_that_is_not_there_is_answered_not_raised() {
        let (_dir, store) = store();
        assert!(!store.remove(99).unwrap());
        let tool = MemoryTool::new(std::sync::Arc::new(MemoryStore::open(
            tempfile::tempdir().unwrap().path().join("m.jsonl"),
        )));
        assert!(run(&tool, json!({ "action": "forget", "id": 99 })).contains("no [99]"));
    }

    #[test]
    fn ids_are_not_reused_after_a_removal() {
        // Reusing an id would make a stale reference point at something else,
        // which is worse than it pointing at nothing.
        let (_dir, store) = store();
        let one = store.add("first").unwrap();
        store.add("second").unwrap();
        store.remove(one).unwrap();
        let third = store.add("third").unwrap();
        assert_eq!(third, 3, "ids must keep climbing");
    }

    #[test]
    fn a_corrupt_line_costs_that_line_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.jsonl");
        std::fs::write(
            &path,
            "{\"id\":1,\"text\":\"good\"}\nnot json at all\n{\"id\":2,\"text\":\"also good\"}\n",
        )
        .unwrap();
        let store = MemoryStore::open(&path);
        assert_eq!(
            store.entries().len(),
            2,
            "a bad line must not lose the good ones"
        );
    }

    #[test]
    fn the_tool_reports_what_it_did() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(MemoryStore::open(dir.path().join("m.jsonl")));
        let tool = MemoryTool::new(std::sync::Arc::clone(&store));

        assert!(run(&tool, json!({ "action": "add", "text": "uses pnpm" })).contains("[1]"));
        assert!(run(&tool, json!({ "action": "list" })).contains("uses pnpm"));
        assert!(run(&tool, json!({ "action": "forget", "id": 1 })).contains("Forgot [1]"));
        assert!(run(&tool, json!({ "action": "list" })).contains("Nothing remembered"));
        assert!(store.is_empty());
    }

    #[test]
    fn add_without_text_is_refused_rather_than_storing_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(MemoryStore::open(dir.path().join("m.jsonl")));
        let tool = MemoryTool::new(store);
        let env_dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(env_dir.path());
        let cancel = CancelToken::new();
        let ctx = ToolContext::new(&env, &cancel);
        assert!(tool
            .execute(json!({ "action": "add", "text": "   " }), &ctx, &mut |_| {})
            .is_err());
    }
}
