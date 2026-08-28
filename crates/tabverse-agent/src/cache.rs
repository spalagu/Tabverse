//! Prefix stability, which is what prompt caching actually depends on.
//!
//! Providers cache by prefix: a request that begins with exactly the bytes of
//! an earlier one is served from the cache up to the point where they diverge,
//! and paid for in full after it. So the hit rate is not something the client
//! asks for — it is a consequence of whether the client keeps sending the same
//! opening. Anything that rewrites history, reorders tools, or slips a
//! timestamp into the system prompt silently drops it to zero.
//!
//! That failure is invisible from inside: the answers are still correct, only
//! the bill and the latency change. Hence a probe. It wraps a provider, records
//! what each request actually looked like, and reports where consecutive
//! requests stopped agreeing.
//!
//! What this measures is the *cacheable fraction* — the share of a request that
//! a prefix cache could serve. It is an upper bound on the hit rate and is
//! computed locally; the rate a provider reports can only be lower (a cold
//! cache, an eviction, a shorter window). Comparing the two is what the probe
//! is for once a real provider is connected.

use crate::provider::{Message, Provider, ProviderEvent, ToolSpec, TurnOutcome};
use anyhow::Result;
use std::sync::Mutex;

/// One request as the provider saw it.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
}

/// Where two consecutive requests stopped agreeing.
#[derive(Debug, Clone, PartialEq)]
pub struct Divergence {
    /// Index of the later request, so 1 means "between the first and second".
    pub request: usize,
    /// How many leading messages the two shared.
    pub shared_messages: usize,
    /// Messages in the later request.
    pub total_messages: usize,
    pub cause: Cause,
}

/// Requests come in two kinds and they do not share a cache prefix.
///
/// The conversation always carries the tool block; the summariser is asked
/// deliberately without one (see `compact::ask_for_summary`, which has a test
/// holding it to that). So an empty tool list is a reliable marker for "this is
/// not part of the conversation" — and treating it as one is what stops a
/// perfectly ordinary compaction from being reported as two cache misses
/// instead of the one it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A turn of the conversation.
    Main,
    /// Work done on the side — summarising, at present. Never a cache hit, and
    /// not part of the chain the conversation's own prefix is judged on.
    Side,
}

pub fn kind_of(snapshot: &Snapshot) -> Kind {
    if snapshot.tools.is_empty() {
        Kind::Side
    } else {
        Kind::Main
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// History was rewritten — a message that had been sent is now different.
    /// Compaction does this deliberately; anything else doing it is a defect.
    HistoryRewritten,
    /// The tool definitions changed, which invalidates everything after them
    /// however stable the messages are.
    ToolsChanged,
}

/// What the probe found across a run.
#[derive(Debug, Clone)]
pub struct Report {
    pub requests: usize,
    /// Requests that were part of the conversation.
    pub main_requests: usize,
    /// Requests made on the side, each of them a guaranteed miss.
    pub side_requests: usize,
    pub divergences: Vec<Divergence>,
    /// Share of each conversation request a prefix cache could have served, in
    /// order. The first is always 0 — nothing precedes it. In a healthy session
    /// this rises: every turn adds to a prefix that is already paid for.
    pub reuse: Vec<f64>,
    /// Mean of `reuse`.
    pub cacheable_fraction: f64,
}

impl Report {
    /// No history was rewritten and no tool definition moved.
    pub fn prefix_stable(&self) -> bool {
        self.divergences.is_empty()
    }
}

/// Wraps a provider and remembers what was sent.
///
/// Deliberately a wrapper rather than a hook inside the session: what matters
/// is the bytes that reach the provider, after every layer has had its say, and
/// the only place that is observable is here.
pub struct ProbeProvider<'a> {
    inner: &'a dyn Provider,
    snapshots: Mutex<Vec<Snapshot>>,
}

impl<'a> ProbeProvider<'a> {
    pub fn new(inner: &'a dyn Provider) -> Self {
        Self {
            inner,
            snapshots: Mutex::new(Vec::new()),
        }
    }

    pub fn snapshots(&self) -> Vec<Snapshot> {
        self.snapshots.lock().unwrap().clone()
    }

    pub fn report(&self) -> Report {
        analyse(&self.snapshots())
    }
}

impl Provider for ProbeProvider<'_> {
    fn stream(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
        sink: &mut dyn FnMut(ProviderEvent),
    ) -> Result<TurnOutcome> {
        self.snapshots.lock().unwrap().push(Snapshot {
            messages: messages.to_vec(),
            tools: tools.to_vec(),
        });
        self.inner.stream(messages, tools, sink)
    }
}

/// Compare consecutive requests and report where the prefix broke.
pub fn analyse(snapshots: &[Snapshot]) -> Report {
    let mut divergences = Vec::new();
    let mut cacheable = Vec::new();

    // Indices kept so a divergence still points at the request the caller sent,
    // not at a position in some filtered list.
    let main: Vec<(usize, &Snapshot)> = snapshots
        .iter()
        .enumerate()
        .filter(|(_, s)| kind_of(s) == Kind::Main)
        .collect();
    let side_requests = snapshots.len() - main.len();

    // The first request can never be a hit; recording it as zero keeps `reuse`
    // aligned with the requests and stops a short run from flattering itself.
    if !main.is_empty() {
        cacheable.push(0.0);
    }

    for pair in main.windows(2) {
        let (_, before) = pair[0];
        let (request, after) = pair[1];

        // Tools sit ahead of the conversation in every provider's layout, so a
        // change there invalidates the whole request no matter what follows.
        if before.tools != after.tools {
            divergences.push(Divergence {
                request,
                shared_messages: 0,
                total_messages: after.messages.len(),
                cause: Cause::ToolsChanged,
            });
            cacheable.push(0.0);
            continue;
        }

        let shared = shared_prefix(&before.messages, &after.messages);
        // Growing is normal and is exactly what caching rewards: the whole of
        // the previous request is still there, with more after it.
        if shared < before.messages.len() {
            divergences.push(Divergence {
                request,
                shared_messages: shared,
                total_messages: after.messages.len(),
                cause: Cause::HistoryRewritten,
            });
        }
        cacheable.push(if after.messages.is_empty() {
            0.0
        } else {
            shared as f64 / after.messages.len() as f64
        });
    }

    let total: f64 = cacheable.iter().sum();
    let cacheable_fraction = if main.is_empty() {
        0.0
    } else {
        total / main.len() as f64
    };

    Report {
        requests: snapshots.len(),
        main_requests: main.len(),
        side_requests,
        divergences,
        reuse: cacheable,
        cacheable_fraction,
    }
}

fn shared_prefix(a: &[Message], b: &[Message]) -> usize {
    a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ToolCall;
    use serde_json::json;

    fn user(text: &str) -> Message {
        Message::User {
            text: text.to_string(),
        }
    }

    fn spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.to_string(),
            description: String::new(),
            parameters: json!({}),
        }
    }

    fn snap(messages: Vec<Message>) -> Snapshot {
        Snapshot {
            messages,
            tools: vec![spec("read")],
        }
    }

    #[test]
    fn a_conversation_that_only_grows_never_breaks_the_prefix() {
        let report = analyse(&[
            snap(vec![user("one")]),
            snap(vec![user("one"), user("two")]),
            snap(vec![user("one"), user("two"), user("three")]),
        ]);
        assert!(report.prefix_stable());
        // Request 2 reuses 1 of 2, request 3 reuses 2 of 3, request 1 nothing.
        let expected = (0.0 + 0.5 + 2.0 / 3.0) / 3.0;
        assert!((report.cacheable_fraction - expected).abs() < 1e-9);
    }

    #[test]
    fn rewriting_history_is_reported_with_where_it_broke() {
        let report = analyse(&[
            snap(vec![user("one"), user("two"), user("three")]),
            snap(vec![user("one"), user("CHANGED"), user("three")]),
        ]);
        assert!(!report.prefix_stable());
        assert_eq!(
            report.divergences[0],
            Divergence {
                request: 1,
                shared_messages: 1,
                total_messages: 3,
                cause: Cause::HistoryRewritten,
            }
        );
    }

    #[test]
    fn a_reordered_tool_list_invalidates_everything_behind_it() {
        // The failure this exists to catch: iterate the tools out of a hash map
        // and the conversation is word for word identical while nothing hits.
        let messages = vec![user("same"), user("exactly")];
        let report = analyse(&[
            Snapshot {
                messages: messages.clone(),
                tools: vec![spec("read"), spec("write")],
            },
            Snapshot {
                messages,
                tools: vec![spec("write"), spec("read")],
            },
        ]);
        assert!(!report.prefix_stable());
        assert_eq!(report.divergences[0].cause, Cause::ToolsChanged);
        assert_eq!(
            report.divergences[0].shared_messages, 0,
            "nothing behind a changed tool list is reusable"
        );
    }

    #[test]
    fn a_dropped_message_counts_as_a_rewrite() {
        // Dropping the middle of the history is a rewrite even though every
        // message that remains was sent before.
        let report = analyse(&[
            snap(vec![user("a"), user("b"), user("c")]),
            snap(vec![user("a"), user("c")]),
        ]);
        assert_eq!(report.divergences[0].shared_messages, 1);
        assert_eq!(report.divergences[0].cause, Cause::HistoryRewritten);
    }

    #[test]
    fn a_tool_call_and_its_result_ride_along_in_the_prefix() {
        let base = vec![
            user("go"),
            Message::Assistant {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    input: json!({ "path": "a.rs" }),
                }],
            },
            Message::ToolResult {
                call_id: "c1".into(),
                content: "contents".into(),
                is_error: false,
            },
        ];
        let mut grown = base.clone();
        grown.push(user("and now?"));
        let report = analyse(&[snap(base), snap(grown)]);
        assert!(report.prefix_stable(), "{:?}", report.divergences);
    }

    #[test]
    fn a_single_request_is_reported_as_entirely_uncached() {
        let report = analyse(&[snap(vec![user("only")])]);
        assert!(report.prefix_stable());
        assert_eq!(report.cacheable_fraction, 0.0);
        assert_eq!(report.requests, 1);
    }

    #[test]
    fn nothing_at_all_does_not_divide_by_zero() {
        let report = analyse(&[]);
        assert_eq!(report.requests, 0);
        assert_eq!(report.cacheable_fraction, 0.0);
        assert!(report.prefix_stable());
    }

    #[test]
    fn the_probe_records_what_reached_the_provider_and_passes_it_through() {
        use crate::provider::ScriptedProvider;
        let inner = ScriptedProvider::saying("hello");
        let probe = ProbeProvider::new(&inner);
        let outcome = probe
            .stream(&[user("hi")], &[spec("read")], &mut |_| {})
            .unwrap();
        assert_eq!(
            outcome.text, "hello",
            "the probe must not change the answer"
        );
        assert_eq!(probe.snapshots().len(), 1);
        assert_eq!(probe.snapshots()[0].messages, vec![user("hi")]);
        assert_eq!(
            inner.request_count(),
            1,
            "the real provider still gets called"
        );
    }
}
