//! The reducer's contract, from the other two sides.
//!
//! One event stream, three consumers, one state. The interface's fold lives in
//! TypeScript and cannot be called from here, so the agreement is pinned
//! instead: this file and `src/agent/reduction.test.ts` fold the *same*
//! recorded session and assert the *same* numbers. Either side drifting turns
//! one of them red.
//!
//! The two sides checked here are the ones Rust owns: what the log holds after
//! a replay, and what a remote viewer would be handed as its catch-up.

use tabverse_agent::log::SessionLog;

/// Kept identical to REDUCTION in src/agent/reduction.test.ts.
mod reduction {
    pub const EVENTS: usize = 19;
    pub const MESSAGES: usize = 6;
    pub const TURNS: usize = 3;
    pub const TOOL_CALLS: usize = 2;
    pub const ASSISTANT_TEXT: &str = "I will inspect the sample workspace.I will run a harmless sample command.The sample session is complete.";
    /// Lines in what each tool handed back, in order.
    ///
    /// Lines rather than length: `String::len` counts bytes and JavaScript's
    /// `.length` counts UTF-16 units, so the same text measures differently on
    /// the two sides — 221922 against 221888 for the glob output, whose paths
    /// are not all ASCII. A cross-language invariant has to be something both
    /// languages define the same way.
    pub const TOOL_RESULT_LINES: [usize; 2] = [2, 1];
    /// Endings in this recording: three.
    ///
    /// It was recorded before the loop stopped announcing every tool round, so
    /// it carries the old shape — one TurnEnded per round rather than one per
    /// answer. Kept as it is rather than re-recorded: logs in this shape exist
    /// on disk and have to stay readable, and the interface folding it into
    /// three settled rounds is that compatibility being exercised rather than
    /// asserted about.
    pub const TURN_ENDINGS: usize = 3;
}

fn fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/synthetic-session.jsonl")
}

#[test]
fn the_same_stream_reduces_the_same_way_everywhere() {
    use tabverse_agent::event::SessionEvent;

    let replay = SessionLog::replay(fixture()).expect("the recorded session must be readable");

    // The fixture itself, so a truncated or replaced file cannot let the rest
    // pass against a different session.
    assert_eq!(replay.events.len(), reduction::EVENTS);
    assert_eq!(replay.messages.len(), reduction::MESSAGES);
    assert_eq!(
        replay.skipped, 0,
        "nothing in this log should be unreadable"
    );

    let turns = replay
        .events
        .iter()
        .filter(|e| matches!(e, SessionEvent::TurnStarted { .. }))
        .count();
    assert_eq!(
        turns,
        reduction::TURNS,
        "same turn count the interface folds to"
    );

    let calls = replay
        .events
        .iter()
        .filter(|e| matches!(e, SessionEvent::ToolStarted(_)))
        .count();
    assert_eq!(calls, reduction::TOOL_CALLS);

    // The counterpart of the interface asserting every round is settled: one
    // answer, one ending. A log with a turn left open would fold into a
    // transcript that shows a finished session as still working.
    let endings = replay
        .events
        .iter()
        .filter(|e| matches!(e, SessionEvent::TurnEnded { .. }))
        .count();
    assert_eq!(
        endings,
        reduction::TURN_ENDINGS,
        "the recording's own shape; see the constant for why it is three"
    );

    let text: String = replay
        .events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::AssistantText { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        text,
        reduction::ASSISTANT_TEXT,
        "the same assembled message"
    );

    let sizes: Vec<usize> = replay
        .events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::ToolFinished { result, .. } => Some(result.lines().count()),
            _ => None,
        })
        .collect();
    assert_eq!(
        sizes,
        reduction::TOOL_RESULT_LINES.to_vec(),
        "a truncation applied on one side and not the other would show up here"
    );
}

#[test]
fn a_viewers_catch_up_is_the_log_and_not_a_second_copy_of_it() {
    // The third consumer. The snapshot a late viewer receives is produced by
    // replaying this same file — deliberately, so there is no in-memory copy
    // that could disagree with what a restart would read back.
    let replay = SessionLog::replay(fixture()).unwrap();
    let snapshot: Vec<serde_json::Value> = replay
        .events
        .iter()
        .filter_map(|e| serde_json::to_value(e).ok())
        .collect();

    assert_eq!(
        snapshot.len(),
        reduction::EVENTS,
        "every event reaches the viewer, not a filtered subset"
    );
    // And in order: a viewer that reassembles them must land where the host is.
    assert_eq!(snapshot[0]["type"], serde_json::json!("user_prompt"));
    assert_eq!(
        snapshot.last().unwrap()["type"],
        serde_json::json!("turn_ended")
    );
}

#[test]
fn the_synthetic_session_remains_small_and_public_safe() {
    // The fixture deliberately remains small so public CI does not retain
    // local-machine output in repository history.
    let bytes = std::fs::metadata(fixture()).unwrap().len();
    assert!(
        bytes < 10_000,
        "got {bytes} — fixture is unexpectedly large"
    );
}
