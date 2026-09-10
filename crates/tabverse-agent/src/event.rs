use serde::{Deserialize, Serialize};
use tabverse_agent_tools::ToolLocation;

/// Why a turn stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// The model answered and asked for nothing further.
    Done,
    /// The user (or the UI) interrupted.
    Cancelled,
    /// The loop hit its own ceiling on tool rounds.
    RoundLimit,
    /// The provider or a tool failed in a way the turn could not continue past.
    Error(String),
}

/// How a permission decision came out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOutcome {
    /// A rule allowed it without asking.
    AllowedByRule,
    /// A human approved it.
    Approved,
    /// Refused, with the reason handed back to the model.
    Denied(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ToolCallView {
    pub call_id: String,
    pub name: String,
    pub input: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// What the user asked for.
    ///
    /// Without this the stream is not self-sufficient: replaying a log would
    /// show an agent acting for no visible reason, and a remote viewer who
    /// joined mid-run would see the same. Both consumers need the prompt to be
    /// *in* the stream rather than held only by whoever typed it.
    UserPrompt {
        text: String,
    },
    TurnStarted {
        turn: u32,
    },
    /// Incremental assistant text. Concatenating every delta of a turn yields
    /// the full message; the UI streams it, the log stores it.
    AssistantText {
        delta: String,
    },
    AssistantThinking {
        delta: String,
    },
    /// The model asked for a tool and the loop is about to decide on it.
    PermissionRequested(ToolCallView),
    PermissionResolved {
        call_id: String,
        outcome: PermissionOutcome,
    },
    ToolStarted(ToolCallView),
    /// Output produced while the tool is still running.
    ToolProgress {
        call_id: String,
        chunk: String,
    },
    ToolFinished {
        call_id: String,
        /// What went back to the model.
        result: String,
        is_error: bool,
        /// Where the tool acted, so the UI can open the right tab.
        location: Option<LocationView>,
    },
    TurnEnded {
        turn: u32,
        reason: StopReason,
    },
    /// The history was folded down to fit the context window.
    ///
    /// In the stream rather than kept quiet because it is a real event in the
    /// conversation: from here on the model no longer holds the detail of what
    /// came before, and a user reading the transcript needs to know where that
    /// line falls. A remote viewer and a replayed log need it for the same
    /// reason.
    Compacted {
        tokens_before: usize,
        tokens_after: usize,
        /// How many messages were folded into the summary.
        replaced: usize,
    },
}

/// `ToolLocation` in a form that survives serialization to the webview and the
/// remote peer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocationView {
    pub path: String,
    pub line: Option<u32>,
}

impl From<&ToolLocation> for LocationView {
    fn from(location: &ToolLocation) -> Self {
        Self {
            path: location.path.to_string_lossy().into_owned(),
            line: location.line,
        }
    }
}

/// Somewhere to send events. The loop does not care whether this ends up in a
/// webview, a socket, or a test's vector.
pub trait EventSink {
    fn emit(&mut self, event: SessionEvent);
}

impl<F: FnMut(SessionEvent)> EventSink for F {
    fn emit(&mut self, event: SessionEvent) {
        self(event)
    }
}

/// Collects events in order. Used by tests and by the session log.
#[derive(Debug, Default)]
pub struct EventLog {
    pub events: Vec<SessionEvent>,
}

impl EventLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// The assistant's full text for the whole run, deltas concatenated.
    pub fn assistant_text(&self) -> String {
        self.events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantText { delta } => Some(delta.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Names of the tools that actually ran, in order.
    pub fn tools_run(&self) -> Vec<&str> {
        self.events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::ToolStarted(call) => Some(call.name.as_str()),
                _ => None,
            })
            .collect()
    }
}

impl EventSink for EventLog {
    fn emit(&mut self, event: SessionEvent) {
        self.events.push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_log_reassembles_streamed_text() {
        let mut log = EventLog::new();
        log.emit(SessionEvent::AssistantText {
            delta: "Hel".into(),
        });
        log.emit(SessionEvent::AssistantText { delta: "lo".into() });
        assert_eq!(log.assistant_text(), "Hello");
    }

    #[test]
    fn events_round_trip_through_json() {
        // The remote peer and the session log both see JSON, so a variant that
        // cannot survive the trip is a variant the second device cannot render.
        let original = SessionEvent::ToolFinished {
            call_id: "c1".into(),
            result: "ok".into(),
            is_error: false,
            location: Some(LocationView {
                path: "/tmp/a.rs".into(),
                line: Some(12),
            }),
        };
        let json = serde_json::to_string(&original).unwrap();
        let back: SessionEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(original, back);
    }

    #[test]
    fn stop_reason_carries_its_error_text() {
        let json = serde_json::to_string(&StopReason::Error("boom".into())).unwrap();
        let back: StopReason = serde_json::from_str(&json).unwrap();
        assert_eq!(back, StopReason::Error("boom".into()));
    }
}
