//! The model behind the session.
//!
//! Two methods' worth of surface, and deliberately no more: the loop needs to
//! send a conversation plus the tool declarations and receive a stream back.
//! Everything a provider is actually made of — OAuth, request shaping, SSE
//! framing, cache-prefix discipline — lives on the far side of this line.
//!
//! The trait exists for two reasons that both pay off immediately. Tests drive
//! the entire loop with a scripted provider and no network. And if the Codex
//! subscription route ever closes, only an implementation of this changes; the
//! loop, the tools and every session event stay as they are.

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// A tool as advertised to the model.
// PartialEq because prefix stability is decided by whether two requests open
// with the same bytes, and the tool block is part of that comparison.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// The conversation as the provider sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    User {
        text: String,
    },
    Assistant {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
    },
    /// The outcome of one tool call, addressed back to the call that asked.
    ToolResult {
        call_id: String,
        content: String,
        is_error: bool,
    },
}

/// Incremental output from a provider during one turn.
pub enum ProviderEvent {
    Text(String),
    Thinking(String),
}

/// What a provider produced once the turn's stream ended.
#[derive(Debug, Clone, Default)]
pub struct TurnOutcome {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

pub trait Provider: Send + Sync {
    /// Run one turn. Deltas go to `sink` as they arrive; the assembled result is
    /// returned. Implementations must emit deltas *before* returning, so a slow
    /// turn is visible while it happens rather than all at once at the end.
    fn stream(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
        sink: &mut dyn FnMut(ProviderEvent),
    ) -> Result<TurnOutcome>;
}

/// A provider that replays a fixed script.
///
/// Not a shortcut around testing the real one — it tests something the real one
/// cannot: that the loop does the right thing on an exact sequence, including
/// sequences that are awkward to provoke from a live model (two tool calls in
/// one turn, a tool call with malformed arguments, a turn that never stops
/// asking).
pub struct ScriptedProvider {
    turns: std::sync::Mutex<std::collections::VecDeque<TurnOutcome>>,
    /// Every message list the loop sent, so tests can assert what the model saw.
    pub seen: std::sync::Mutex<Vec<Vec<Message>>>,
    /// The tool specs offered alongside each of those.
    tools_seen: std::sync::Mutex<Vec<Vec<ToolSpec>>>,
    /// When set, every call fails with this message instead of answering.
    fails_with: Option<String>,
}

impl ScriptedProvider {
    pub fn new(turns: Vec<TurnOutcome>) -> Self {
        Self {
            turns: std::sync::Mutex::new(turns.into()),
            seen: std::sync::Mutex::new(Vec::new()),
            tools_seen: std::sync::Mutex::new(Vec::new()),
            fails_with: None,
        }
    }

    /// A provider that is down. Callers that treat a failure as fatal and
    /// callers that recover from it both need one to test against.
    pub fn failing(message: &str) -> Self {
        Self {
            fails_with: Some(message.to_string()),
            ..Self::new(Vec::new())
        }
    }

    /// A single turn of plain text with no tool calls.
    pub fn saying(text: &str) -> Self {
        Self::new(vec![TurnOutcome {
            text: text.to_string(),
            tool_calls: Vec::new(),
        }])
    }

    /// What the loop sent on the nth call, for asserting that tool results were
    /// fed back in the right shape.
    pub fn nth_request(&self, n: usize) -> Option<Vec<Message>> {
        self.seen.lock().unwrap().get(n).cloned()
    }

    pub fn request_count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }

    /// The most recent request, for the common case of asserting on one call.
    pub fn last_request(&self) -> Vec<Message> {
        self.seen
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default()
    }

    /// The tools offered on the most recent call. Some requests must offer
    /// none — a summary answered with a tool call is not a summary.
    pub fn last_tools(&self) -> Vec<ToolSpec> {
        self.tools_seen
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default()
    }
}

impl Provider for ScriptedProvider {
    fn stream(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
        sink: &mut dyn FnMut(ProviderEvent),
    ) -> Result<TurnOutcome> {
        self.seen.lock().unwrap().push(messages.to_vec());
        self.tools_seen.lock().unwrap().push(tools.to_vec());
        if let Some(message) = &self.fails_with {
            anyhow::bail!("{message}");
        }
        let next = self.turns.lock().unwrap().pop_front();
        let outcome = next.unwrap_or_default();
        // Deltas first, mirroring a real stream: the UI must be able to show the
        // text before the turn is known to be over.
        if !outcome.text.is_empty() {
            sink(ProviderEvent::Text(outcome.text.clone()));
        }
        Ok(outcome)
    }
}

/// Build a turn that calls one tool.
pub fn turn_calling(id: &str, name: &str, input: serde_json::Value) -> TurnOutcome {
    TurnOutcome {
        text: String::new(),
        tool_calls: vec![ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            input,
        }],
    }
}

/// Build a turn that only speaks.
pub fn turn_saying(text: &str) -> TurnOutcome {
    TurnOutcome {
        text: text.to_string(),
        tool_calls: Vec::new(),
    }
}

/// A provider for development, before a real one exists.
///
/// Not a mock in the testing sense — it exists so the whole path (prompt →
/// text → tool call → approval → result → answer) can be exercised in the app
/// with no network and no account. It walks a fixed three-act script driven by
/// how many tool results the conversation already holds: look around, ask to run
/// something (which the permission layer will put to the user), then summarise.
pub struct DemoProvider;

impl Default for DemoProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl DemoProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Provider for DemoProvider {
    fn stream(
        &self,
        messages: &[Message],
        _tools: &[ToolSpec],
        sink: &mut dyn FnMut(ProviderEvent),
    ) -> Result<TurnOutcome> {
        let results = messages
            .iter()
            .filter(|m| matches!(m, Message::ToolResult { .. }))
            .count();

        match results {
            0 => {
                let text = "Let me see what is in this folder.";
                sink(ProviderEvent::Text(text.to_string()));
                Ok(TurnOutcome {
                    text: text.to_string(),
                    tool_calls: vec![ToolCall {
                        id: "demo-1".into(),
                        name: "glob".into(),
                        input: serde_json::json!({ "pattern": "**/*" }),
                    }],
                })
            }
            1 => {
                let text = "Now I would like to run a command.";
                sink(ProviderEvent::Text(text.to_string()));
                Ok(TurnOutcome {
                    text: text.to_string(),
                    // bash is not read-only, so the permission layer puts this to
                    // the user — which is the point: it makes the approval path
                    // visible without any side effect worth worrying about.
                    tool_calls: vec![ToolCall {
                        id: "demo-2".into(),
                        name: "bash".into(),
                        input: serde_json::json!({ "command": "echo hello from the agent" }),
                    }],
                })
            }
            _ => {
                let text = "That is everything for this demo run.";
                sink(ProviderEvent::Text(text.to_string()));
                Ok(TurnOutcome {
                    text: text.to_string(),
                    tool_calls: Vec::new(),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripted_provider_replays_in_order_then_falls_silent() {
        let provider = ScriptedProvider::new(vec![turn_saying("first"), turn_saying("second")]);
        let mut seen = Vec::new();
        let mut sink = |e: ProviderEvent| {
            if let ProviderEvent::Text(t) = e {
                seen.push(t)
            }
        };
        assert_eq!(provider.stream(&[], &[], &mut sink).unwrap().text, "first");
        assert_eq!(provider.stream(&[], &[], &mut sink).unwrap().text, "second");
        // Running past the script yields an empty turn rather than panicking, so
        // a loop bug shows up as "stopped early", not as a crash.
        assert_eq!(provider.stream(&[], &[], &mut sink).unwrap().text, "");
        assert_eq!(seen, vec!["first", "second"]);
    }

    #[test]
    fn scripted_provider_records_what_it_was_sent() {
        let provider = ScriptedProvider::saying("ok");
        let messages = vec![Message::User {
            text: "hello".into(),
        }];
        provider.stream(&messages, &[], &mut |_| {}).unwrap();
        assert_eq!(provider.request_count(), 1);
        assert_eq!(provider.nth_request(0).unwrap(), messages);
    }

    #[test]
    fn demo_provider_walks_its_three_acts() {
        let demo = DemoProvider::new();
        let mut messages = vec![Message::User { text: "go".into() }];

        let first = demo.stream(&messages, &[], &mut |_| {}).unwrap();
        assert_eq!(first.tool_calls[0].name, "glob");

        messages.push(Message::ToolResult {
            call_id: "demo-1".into(),
            content: "a.txt".into(),
            is_error: false,
        });
        let second = demo.stream(&messages, &[], &mut |_| {}).unwrap();
        assert_eq!(
            second.tool_calls[0].name, "bash",
            "the second act must reach a tool that needs approval"
        );

        messages.push(Message::ToolResult {
            call_id: "demo-2".into(),
            content: "hello".into(),
            is_error: false,
        });
        let third = demo.stream(&messages, &[], &mut |_| {}).unwrap();
        assert!(
            third.tool_calls.is_empty(),
            "the run must end rather than loop"
        );
    }

    #[test]
    fn messages_round_trip_through_json() {
        let original = Message::ToolResult {
            call_id: "c1".into(),
            content: "done".into(),
            is_error: false,
        };
        let back: Message =
            serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
        assert_eq!(original, back);
    }
}
