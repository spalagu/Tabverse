//! Keeping a long conversation inside the model's context window.
//!
//! Truncation bounds what one tool call contributes; this bounds what the whole
//! session does. When the history approaches the window, the middle of it is
//! replaced by a summary and the conversation carries on.
//!
//! Two decisions shape everything here.
//!
//! **Compaction is priced, not reflexive.** Rewriting the prefix invalidates
//! the provider's cache for every earlier token, so compacting is expensive in
//! a way that is invisible unless it is modelled. It therefore happens at a
//! deliberate threshold, between turns, once — never opportunistically in the
//! middle of one.
//!
//! **Facts do not depend on the summary being good.** A model asked to
//! summarise may drop the one path that mattered, and there is no way to notice
//! until the agent is lost. So the facts that can be recovered mechanically —
//! what the user asked for, which files were touched, which commands ran — are
//! extracted from the messages being dropped and carried forward verbatim,
//! alongside the model's prose summary rather than inside it.
//!
//! The shape was informed by Pi's compaction implementation; see the
//! repository's `NOTICE` file. The mechanical fact list is specific to
//! Tabverse.

use crate::provider::{Message, Provider, ProviderEvent, ToolSpec};
use anyhow::Result;

/// When to compact, and how much to keep when it happens.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    /// The model's context window, in tokens.
    pub context_tokens: usize,
    /// Fraction of the window at which compaction runs. Below 1.0 by enough to
    /// leave room for the next request and its answer.
    pub compact_at: f64,
    /// Messages at the end that are never summarised. The agent needs its
    /// immediate working state in full, not in prose.
    pub keep_recent: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            // A conservative floor rather than any particular model's ceiling:
            // compacting early costs a summary, compacting late costs the turn.
            context_tokens: 128_000,
            compact_at: 0.75,
            keep_recent: 6,
        }
    }
}

impl Budget {
    pub fn threshold_tokens(&self) -> usize {
        (self.context_tokens as f64 * self.compact_at) as usize
    }
}

/// Rough token count for a piece of text.
///
/// Deliberately an estimate: the exact count depends on the provider's
/// tokeniser, and the only decision made from this number is when to compact —
/// a threshold that already carries a wide margin. Four bytes per token is the
/// usual English-and-code approximation, and erring high is the safe direction
/// because it compacts sooner rather than overflowing.
pub fn estimate_tokens(text: &str) -> usize {
    text.len().div_ceil(4)
}

pub fn estimate_messages(messages: &[Message]) -> usize {
    messages.iter().map(estimate_message).sum()
}

fn estimate_message(message: &Message) -> usize {
    // Every message carries role and framing overhead beyond its text.
    const OVERHEAD: usize = 4;
    OVERHEAD
        + match message {
            Message::User { text } => estimate_tokens(text),
            Message::Assistant { text, tool_calls } => {
                estimate_tokens(text)
                    + tool_calls
                        .iter()
                        .map(|c| estimate_tokens(&c.name) + estimate_tokens(&c.input.to_string()))
                        .sum::<usize>()
            }
            Message::ToolResult { content, .. } => estimate_tokens(content),
        }
}

/// Is the conversation big enough to be worth the cost of compacting?
pub fn needs_compaction(messages: &[Message], budget: &Budget) -> bool {
    // Nothing to gain if everything would be kept anyway: the summary would
    // cost a request and replace nothing.
    if messages.len() <= budget.keep_recent + 1 {
        return false;
    }
    estimate_messages(messages) > budget.threshold_tokens()
}

/// What a compaction did, for the log and for the user.
#[derive(Debug, Clone)]
pub struct Compaction {
    pub messages: Vec<Message>,
    pub tokens_before: usize,
    pub tokens_after: usize,
    /// How many messages were folded into the summary.
    pub replaced: usize,
}

/// The instruction sent to the model when asking for the summary.
///
/// It names what the next turn will need, because a summary written without
/// knowing what it is for reliably keeps the narrative and drops the specifics.
const SUMMARY_INSTRUCTION: &str = "\
Summarise the conversation so far for your own future reference. You are about to \
continue this work with the detail below removed, so write what you would need to \
pick it up: the goal, what has already been done and what came of it, decisions \
made and why, what failed and should not be retried the same way, and what remains. \
Be specific — name files, symbols, commands and error text rather than describing \
them. Write prose, not a preamble; do not address the user.";

/// Replace the middle of the conversation with a summary.
///
/// The first message stays — it is the task — and the last `keep_recent` stay
/// because they are the working state. Everything between them is summarised by
/// the model and, separately, mined for facts that a summary might drop.
pub fn compact(
    messages: &[Message],
    budget: &Budget,
    provider: &dyn Provider,
) -> Result<Compaction> {
    let tokens_before = estimate_messages(messages);
    let split = messages.len().saturating_sub(budget.keep_recent);
    // Keep the opening prompt: it is the task, and a summary of the task is
    // strictly worse than the task.
    let head = &messages[..1.min(split)];
    let middle = &messages[head.len()..split];
    let tail = &messages[split..];

    if middle.is_empty() {
        return Ok(Compaction {
            messages: messages.to_vec(),
            tokens_before,
            tokens_after: tokens_before,
            replaced: 0,
        });
    }

    let summary = ask_for_summary(middle, provider)?;
    let facts = extract_facts(middle);

    let mut folded = String::from("[Earlier conversation, compacted]\n\n");
    folded.push_str(&summary);
    if !facts.is_empty() {
        // Appended rather than merged into the prose: these are recovered from
        // the messages themselves, so they are true whatever the summary says.
        folded.push_str("\n\nFrom the record, verbatim:\n");
        for fact in &facts {
            folded.push_str("- ");
            folded.push_str(fact);
            folded.push('\n');
        }
    }

    let mut out = Vec::with_capacity(head.len() + 1 + tail.len());
    out.extend_from_slice(head);
    out.push(Message::User { text: folded });
    out.extend_from_slice(tail);

    let tokens_after = estimate_messages(&out);
    Ok(Compaction {
        messages: out,
        tokens_before,
        tokens_after,
        replaced: middle.len(),
    })
}

fn ask_for_summary(middle: &[Message], provider: &dyn Provider) -> Result<String> {
    let mut request: Vec<Message> = middle.to_vec();
    request.push(Message::User {
        text: SUMMARY_INSTRUCTION.to_string(),
    });
    // No tools offered: the only acceptable answer is prose.
    let no_tools: Vec<ToolSpec> = Vec::new();
    let outcome = provider.stream(&request, &no_tools, &mut |_: ProviderEvent| {})?;
    Ok(outcome.text)
}

/// Ceiling on one fact. Long enough for a path, a command line, or the opening
/// of a question; short enough that a list of them cannot become the thing that
/// needed compacting.
const MAX_FACT_LEN: usize = 120;

/// Ceiling on the list. Past this the facts are no longer helping the model
/// orient, and they are competing for the space compaction just freed.
const MAX_FACTS: usize = 40;

/// Pull the things worth keeping regardless of what the summary says.
///
/// Only what can be recovered without judgement: what was asked, which paths
/// tools touched, which commands ran. No attempt to guess importance — a wrong
/// guess here is a fact silently lost, which is the failure this exists to
/// prevent.
fn extract_facts(middle: &[Message]) -> Vec<String> {
    let mut facts: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut dropped = 0usize;

    for message in middle {
        match message {
            Message::User { text } => {
                let asked = clip(first_line(text));
                if !asked.is_empty() && seen.insert(asked.clone()) {
                    push_fact(&mut facts, &mut dropped, format!("asked: {asked}"));
                }
            }
            Message::Assistant { tool_calls, .. } => {
                for call in tool_calls {
                    if let Some(fact) = describe_call(&call.name, &call.input) {
                        if seen.insert(fact.clone()) {
                            push_fact(&mut facts, &mut dropped, fact);
                        }
                    }
                }
            }
            Message::ToolResult { .. } => {}
        }
    }
    if dropped > 0 {
        facts.push(format!("({dropped} further items not listed)"));
    }
    facts
}

fn push_fact(facts: &mut Vec<String>, dropped: &mut usize, fact: String) {
    if facts.len() < MAX_FACTS {
        facts.push(fact);
    } else {
        *dropped += 1;
    }
}

/// Cut a fact to length on a character boundary, marking that it was cut.
fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_FACT_LEN {
        return text.to_string();
    }
    let kept: String = text.chars().take(MAX_FACT_LEN).collect();
    format!("{kept}…")
}

fn describe_call(name: &str, input: &serde_json::Value) -> Option<String> {
    let object = input.as_object()?;
    for key in ["path", "file_path", "command", "pattern"] {
        if let Some(value) = object.get(key).and_then(|v| v.as_str()) {
            return Some(format!("{name}: {}", clip(first_line(value))));
        }
    }
    None
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("").trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ScriptedProvider, ToolCall};
    use serde_json::json;

    fn user(text: &str) -> Message {
        Message::User {
            text: text.to_string(),
        }
    }

    fn calling(name: &str, input: serde_json::Value) -> Message {
        Message::Assistant {
            text: String::new(),
            tool_calls: vec![ToolCall {
                id: "c".into(),
                name: name.into(),
                input,
            }],
        }
    }

    fn result(content: &str) -> Message {
        Message::ToolResult {
            call_id: "c".into(),
            content: content.to_string(),
            is_error: false,
        }
    }

    fn summariser(text: &str) -> ScriptedProvider {
        ScriptedProvider::saying(text)
    }

    #[test]
    fn a_short_conversation_is_left_alone() {
        let messages = vec![user("hello"), user("again")];
        assert!(!needs_compaction(&messages, &Budget::default()));
    }

    #[test]
    fn a_conversation_that_would_keep_everything_is_not_worth_compacting() {
        // Under keep_recent there is nothing in the middle to replace, so a
        // summary would cost a request and save nothing.
        let budget = Budget {
            context_tokens: 100,
            compact_at: 0.5,
            keep_recent: 6,
        };
        let messages: Vec<Message> = (0..5).map(|i| user(&"x".repeat(i * 100 + 100))).collect();
        assert!(estimate_messages(&messages) > budget.threshold_tokens());
        assert!(!needs_compaction(&messages, &budget));
    }

    #[test]
    fn compaction_triggers_once_the_history_crosses_the_threshold() {
        let budget = Budget {
            context_tokens: 1000,
            compact_at: 0.5,
            keep_recent: 2,
        };
        let small: Vec<Message> = (0..8).map(|_| user("short")).collect();
        assert!(!needs_compaction(&small, &budget));

        let big: Vec<Message> = (0..8).map(|_| user(&"x".repeat(400))).collect();
        assert!(needs_compaction(&big, &budget));
    }

    #[test]
    fn the_task_and_the_working_state_survive_verbatim() {
        let mut messages = vec![user("port the parser to the new AST")];
        for i in 0..10 {
            messages.push(calling("read", json!({ "path": format!("src/f{i}.rs") })));
            messages.push(result("contents"));
        }
        messages.push(user("keep going"));
        messages.push(result("recent tool output"));

        let budget = Budget {
            context_tokens: 100,
            compact_at: 0.5,
            keep_recent: 2,
        };
        let out = compact(&messages, &budget, &summariser("a summary")).unwrap();

        assert_eq!(
            out.messages.first(),
            messages.first(),
            "the task itself must not be summarised"
        );
        assert_eq!(
            &out.messages[out.messages.len() - 2..],
            &messages[messages.len() - 2..],
            "the working state must arrive in full, not as prose"
        );
        assert_eq!(
            out.messages.len(),
            4,
            "everything else folds into one message"
        );
        assert!(out.tokens_after < out.tokens_before);
    }

    #[test]
    fn facts_the_summary_might_have_dropped_are_carried_anyway() {
        // The point of the mechanical list: the summariser here is useless, and
        // the paths still have to come through.
        let mut messages = vec![user("find the leak")];
        messages.push(calling("read", json!({ "path": "src/pool.rs" })));
        messages.push(result("fn acquire() {}"));
        messages.push(calling("bash", json!({ "command": "cargo test -p pool" })));
        messages.push(result("1 failed"));
        messages.push(calling("edit", json!({ "file_path": "src/pool.rs" })));
        messages.push(result("edited"));
        messages.push(user("carry on"));

        let budget = Budget {
            context_tokens: 10,
            compact_at: 0.5,
            keep_recent: 1,
        };
        let out = compact(&messages, &budget, &summariser("I did some things.")).unwrap();

        let folded = match &out.messages[1] {
            Message::User { text } => text.clone(),
            other => panic!("expected the folded message, got {other:?}"),
        };
        assert!(folded.contains("src/pool.rs"), "got {folded}");
        assert!(folded.contains("cargo test -p pool"), "got {folded}");
        assert!(folded.contains("edit: src/pool.rs"), "got {folded}");
        assert!(
            folded.contains("I did some things."),
            "the prose belongs there too"
        );
    }

    #[test]
    fn the_same_file_touched_ten_times_is_listed_once() {
        let mut messages = vec![user("refactor")];
        for _ in 0..10 {
            messages.push(calling("read", json!({ "path": "src/same.rs" })));
            messages.push(result("x"));
        }
        messages.push(user("continue"));

        let budget = Budget {
            context_tokens: 10,
            compact_at: 0.5,
            keep_recent: 1,
        };
        let out = compact(&messages, &budget, &summariser("s")).unwrap();
        let folded = match &out.messages[1] {
            Message::User { text } => text.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(
            folded.matches("read: src/same.rs").count(),
            1,
            "got {folded}"
        );
    }

    #[test]
    fn the_summariser_is_given_the_dropped_messages_and_no_tools() {
        // It must summarise what is leaving, not what is staying, and it must
        // not be able to answer with a tool call.
        let mut messages = vec![user("the task")];
        for i in 0..6 {
            messages.push(user(&format!("middle {i}")));
        }
        messages.push(user("recent"));

        let provider = summariser("done");
        let budget = Budget {
            context_tokens: 10,
            compact_at: 0.5,
            keep_recent: 1,
        };
        compact(&messages, &budget, &provider).unwrap();

        let seen = provider.last_request();
        assert!(
            seen.iter()
                .any(|m| matches!(m, Message::User { text } if text == "middle 0")),
            "the messages being dropped must be what it reads"
        );
        assert!(
            !seen
                .iter()
                .any(|m| matches!(m, Message::User { text } if text == "recent")),
            "what stays must not be summarised as well"
        );
        assert!(
            seen.iter()
                .any(|m| matches!(m, Message::User { text } if text.contains("Summarise"))),
            "the instruction has to be in the request"
        );
        assert_eq!(provider.last_tools().len(), 0, "prose only");
    }

    #[test]
    fn a_failed_summary_does_not_take_the_session_with_it() {
        let mut messages = vec![user("task")];
        for i in 0..6 {
            messages.push(user(&format!("m{i}")));
        }
        let budget = Budget {
            context_tokens: 10,
            compact_at: 0.5,
            keep_recent: 1,
        };
        let err = compact(
            &messages,
            &budget,
            &ScriptedProvider::failing("provider down"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("provider down"));
    }

    #[test]
    fn the_fact_list_cannot_become_the_thing_that_needed_compacting() {
        // Found by the cache probe: with no ceiling on a fact, thirty long
        // messages produced thirty long facts, the folded message was as big as
        // what it replaced, and the very next turn compacted again.
        let mut messages = vec![user("task")];
        for i in 0..30 {
            messages.push(user(&format!("{i} {}", "x".repeat(1000))));
        }
        messages.push(user("recent"));

        let budget = Budget {
            context_tokens: 4_000,
            compact_at: 0.75,
            keep_recent: 2,
        };
        let out = compact(&messages, &budget, &summariser("brief")).unwrap();

        assert!(
            out.tokens_after * 4 < out.tokens_before,
            "compaction has to actually compact: {} -> {}",
            out.tokens_before,
            out.tokens_after
        );
        assert!(
            !needs_compaction(&out.messages, &budget),
            "the result must not immediately need compacting again"
        );
    }

    #[test]
    fn a_long_fact_is_cut_and_says_it_was() {
        let mut messages = vec![user("task")];
        messages.push(calling(
            "read",
            json!({ "path": format!("src/{}.rs", "d".repeat(400)) }),
        ));
        messages.push(result("x"));
        messages.push(user("recent"));

        let budget = Budget {
            context_tokens: 10,
            compact_at: 0.5,
            keep_recent: 1,
        };
        let out = compact(&messages, &budget, &summariser("s")).unwrap();
        let folded = match &out.messages[1] {
            Message::User { text } => text.clone(),
            other => panic!("{other:?}"),
        };
        let line = folded
            .lines()
            .find(|l| l.starts_with("- read:"))
            .expect("the fact should still be listed");
        assert!(
            line.chars().count() < MAX_FACT_LEN + 40,
            "got {} chars",
            line.chars().count()
        );
        assert!(
            line.ends_with('…'),
            "a cut fact must show that it was cut: {line}"
        );
    }

    #[test]
    fn a_very_long_list_of_facts_is_capped_and_declares_what_it_dropped() {
        let mut messages = vec![user("task")];
        for i in 0..(MAX_FACTS + 15) {
            messages.push(calling("read", json!({ "path": format!("src/f{i}.rs") })));
            messages.push(result("x"));
        }
        messages.push(user("recent"));

        let budget = Budget {
            context_tokens: 10,
            compact_at: 0.5,
            keep_recent: 1,
        };
        let out = compact(&messages, &budget, &summariser("s")).unwrap();
        let folded = match &out.messages[1] {
            Message::User { text } => text.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(folded.matches("- read: ").count(), MAX_FACTS);
        assert!(
            folded.contains("(15 further items not listed)"),
            "a truncated list must not look complete: {folded}"
        );
    }
}
