//! Reusing one connection across turns, and sending only what is new.
//!
//! The SSE path opens a connection per request. That works, and it pays for the
//! whole conversation every time. A connection held open across turns lets the
//! provider keep the prefix it has already read, so a follow-up sends only what
//! was added — which is the same prefix discipline as [`super::request`], moved
//! from "serialise identically" to "do not resend at all".
//!
//! Almost everything here is a decision rather than a transfer: which cached
//! connection this request may use, whether it is too old, what part of the
//! input is actually new, and whether to give up and fall back to SSE. Those
//! are pure functions, so they are tested without a socket — which matters,
//! because the failures worth catching are the ones a healthy network never
//! produces.
//!
//! Protocol behavior was informed by Pi's
//! `packages/ai/src/api/openai-codex-responses.ts`; see the repository's
//! `NOTICE` file for attribution and license terms.

use serde_json::Value;

/// How long a pooled connection may live before it is replaced.
///
/// Upstream's number. Below the hour at which the far end drops it: being the
/// one who closes means the next turn opens a fresh connection deliberately
/// rather than discovering a dead one mid-request.
pub const MAX_CONNECTION_AGE_MS: u64 = 55 * 60 * 1000;

/// How long to wait for the socket to open before falling back to SSE.
pub const CONNECT_TIMEOUT_MS: u64 = 15_000;

/// The error code the service returns when an account has too many sockets.
pub const CONNECTION_LIMIT_CODE: &str = "websocket_connection_limit_reached";

/// Which pooled connection a request may use.
///
/// Session *and* account. Sharing by session alone would hand one user's
/// connection — and the prefix cached on it — to a request authenticated as
/// somebody else, which is a correctness problem before it is a privacy one.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PoolKey {
    pub session_id: String,
    pub account_id: String,
}

impl PoolKey {
    pub fn new(session_id: impl Into<String>, account_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            account_id: account_id.into(),
        }
    }
}

/// Turn the HTTP endpoint into the websocket one. Same host, same path.
pub fn websocket_url(https_url: &str) -> String {
    if let Some(rest) = https_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = https_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        https_url.to_string()
    }
}

/// What the far end said, insofar as it changes what to do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Open a new connection and try once more. The old one is spent.
    RetryOnce,
    /// Stop trying websockets for this session and use SSE.
    FallBackToSse,
    /// Nothing to salvage; report it.
    Fail,
}

/// Decide what a failure means.
///
/// The distinction that matters: a failure *before* the stream started can be
/// retried or fallen back on, because nothing has been shown to the user yet.
/// After output has begun, falling back would replay the answer from the
/// beginning — the user would watch it written twice.
pub fn disposition(started: bool, error: &str) -> Disposition {
    if started {
        return Disposition::Fail;
    }
    if error.contains(CONNECTION_LIMIT_CODE) {
        // The account is at its limit, usually because a previous connection
        // has not been reaped yet. One more attempt, not a loop.
        return Disposition::RetryOnce;
    }
    if error.contains("timed out") || error.contains("idle") || error.contains("connect") {
        return Disposition::FallBackToSse;
    }
    Disposition::Fail
}

/// A connection sitting in the pool.
#[derive(Debug, Clone)]
pub struct Pooled {
    pub opened_at_ms: u64,
    /// In use right now. A busy connection is never expired out from under the
    /// request that is using it.
    pub busy: bool,
    /// What this connection has already been told, for computing the delta.
    pub continuation: Option<Continuation>,
}

/// What a connection already holds, so the next turn can send only the rest.
#[derive(Debug, Clone, PartialEq)]
pub struct Continuation {
    /// The request that was sent, minus its input.
    pub envelope: Value,
    /// The input items that were sent.
    pub sent_input: Vec<Value>,
    /// The items the model produced in reply, which the far end also holds.
    pub produced: Vec<Value>,
    /// The id the next request continues from.
    pub response_id: String,
}

/// May this pooled connection serve a request now?
pub fn is_usable(pooled: &Pooled, now_ms: u64) -> bool {
    if pooled.busy {
        return false;
    }
    now_ms.saturating_sub(pooled.opened_at_ms) < MAX_CONNECTION_AGE_MS
}

/// What actually needs sending, given what the connection already holds.
///
/// `None` means send the whole request: either this connection knows nothing
/// useful, or the conversation diverged from what it holds. Divergence is not
/// an error — compaction rewrites history on purpose — but it does mean the
/// cached prefix is worthless and pretending otherwise would send the model a
/// conversation it never had.
pub fn input_delta(body: &Value, continuation: &Continuation) -> Option<Vec<Value>> {
    if !envelopes_match(body, &continuation.envelope) {
        return None;
    }
    let current = body.get("input")?.as_array()?;

    // What the far end holds: what we sent, plus what it produced from it.
    let mut baseline: Vec<&Value> = continuation.sent_input.iter().collect();
    baseline.extend(continuation.produced.iter());

    if current.len() < baseline.len() {
        return None;
    }
    // Every item it holds must still be there, unchanged and in the same
    // place. Anything else and the prefix it cached is not this conversation's.
    if current.iter().zip(baseline.iter()).any(|(a, b)| a != *b) {
        return None;
    }
    Some(current[baseline.len()..].to_vec())
}

/// Two requests agree on everything except their input.
///
/// A changed tool block or model makes the cached prefix meaningless even when
/// the conversation lines up, so this is checked before the input at all.
fn envelopes_match(body: &Value, envelope: &Value) -> bool {
    let (Some(a), Some(b)) = (body.as_object(), envelope.as_object()) else {
        return false;
    };
    let keys = |m: &serde_json::Map<String, Value>| {
        let mut k: Vec<&String> = m.keys().filter(|k| *k != "input").collect();
        k.sort();
        k.into_iter().cloned().collect::<Vec<String>>()
    };
    if keys(a) != keys(b) {
        return false;
    }
    a.iter()
        .filter(|(k, _)| *k != "input")
        .all(|(k, v)| b.get(k) == Some(v))
}

/// The request to send over a connection that already holds part of it.
pub fn continuation_body(body: &Value, delta: Vec<Value>, response_id: &str) -> Value {
    let mut out = body.clone();
    if let Some(map) = out.as_object_mut() {
        map.insert("input".into(), Value::Array(delta));
        map.insert(
            "previous_response_id".into(),
            Value::String(response_id.into()),
        );
    }
    out
}

/// One open connection to the service.
///
/// Deliberately thin: opening and moving bytes, nothing about when to reuse or
/// what to send. Those decisions live above, as the functions in this file,
/// where they can be tested — a transport that also owned them would take them
/// back out of reach.
pub trait WsConnection: Send {
    /// Send one request and read its answer, handing over each piece.
    ///
    /// `on_chunk` returns whether to keep reading, exactly as the SSE path
    /// does, so the two share a parser and a stopping rule.
    fn exchange(
        &mut self,
        body: &str,
        on_chunk: &mut dyn FnMut(&str) -> anyhow::Result<bool>,
    ) -> anyhow::Result<()>;
}

/// Opens connections. One method, for the same reason.
pub trait WsTransport: Send + Sync {
    fn open(
        &self,
        url: &str,
        headers: &[(String, String)],
    ) -> anyhow::Result<Box<dyn WsConnection>>;
}

/// The pool, and the rules for getting a connection out of it.
///
/// Not a cache in the usual sense: an entry is worth keeping only because the
/// service holds a prefix on the far side of it, so the entry's value and the
/// connection's identity are the same thing. That is why a mismatched
/// continuation drops the entry rather than merely bypassing it.
#[derive(Default)]
pub struct Pool {
    entries: std::collections::HashMap<PoolKey, Pooled>,
    /// Sessions that fell back to SSE and should not try a socket again.
    ///
    /// Per session rather than global: one conversation hitting a proxy that
    /// blocks websockets says nothing about the next one, and a global flag
    /// would make one bad connection cost every later session its cache.
    fallen_back: std::collections::HashSet<String>,
}

impl Pool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Should this session try a websocket at all?
    pub fn may_try(&self, session_id: &str) -> bool {
        !self.fallen_back.contains(session_id)
    }

    /// Give up on websockets for this session.
    pub fn remember_fallback(&mut self, session_id: &str) {
        self.fallen_back.insert(session_id.to_string());
    }

    /// What this request may reuse, if anything. Expired entries are dropped
    /// on the way past rather than left to be found again.
    pub fn take(&mut self, key: &PoolKey, now_ms: u64) -> Option<Pooled> {
        let usable = self.entries.get(key).is_some_and(|e| is_usable(e, now_ms));
        if !usable {
            self.entries.remove(key);
            return None;
        }
        self.entries.remove(key)
    }

    /// Put a connection back with what it now holds.
    pub fn put(&mut self, key: PoolKey, entry: Pooled) {
        self.entries.insert(key, entry);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(n: u32) -> Value {
        json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": format!("m{n}") }] })
    }

    fn body(inputs: &[Value]) -> Value {
        json!({ "model": "gpt-5.5", "stream": true, "input": inputs })
    }

    fn continuation(sent: &[Value], produced: &[Value]) -> Continuation {
        Continuation {
            envelope: json!({ "model": "gpt-5.5", "stream": true }),
            sent_input: sent.to_vec(),
            produced: produced.to_vec(),
            response_id: "resp_1".into(),
        }
    }

    #[test]
    fn the_endpoint_is_the_same_place_over_a_different_scheme() {
        assert_eq!(
            websocket_url("https://chatgpt.com/backend-api/codex/responses"),
            "wss://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            websocket_url("http://localhost:8080/x"),
            "ws://localhost:8080/x"
        );
        assert_eq!(websocket_url("wss://already"), "wss://already");
    }

    #[test]
    fn a_pooled_connection_belongs_to_one_session_and_one_account() {
        // Sharing by session alone would hand one user's connection, and the
        // prefix cached on it, to a request authenticated as somebody else.
        let a = PoolKey::new("sess", "account-a");
        let b = PoolKey::new("sess", "account-b");
        assert_ne!(a, b);
        assert_eq!(a, PoolKey::new("sess", "account-a"));
        assert_ne!(
            PoolKey::new("sess-1", "acct"),
            PoolKey::new("sess-2", "acct")
        );
    }

    #[test]
    fn a_connection_is_replaced_before_it_gets_old_enough_to_be_dropped() {
        let fresh = Pooled {
            opened_at_ms: 0,
            busy: false,
            continuation: None,
        };
        assert!(is_usable(&fresh, MAX_CONNECTION_AGE_MS - 1));
        assert!(
            !is_usable(&fresh, MAX_CONNECTION_AGE_MS),
            "at the limit it is already too old"
        );
    }

    #[test]
    fn a_connection_in_use_is_not_handed_to_a_second_request() {
        let busy = Pooled {
            opened_at_ms: 0,
            busy: true,
            continuation: None,
        };
        assert!(!is_usable(&busy, 1));
    }

    #[test]
    fn a_follow_up_sends_only_what_was_added() {
        // The point of holding the connection at all.
        let sent = [item(1)];
        let produced = [item(2)];
        let cont = continuation(&sent, &produced);
        let next = body(&[item(1), item(2), item(3)]);

        let delta = input_delta(&next, &cont).expect("the conversation continues cleanly");
        assert_eq!(delta, vec![item(3)], "only the new item travels");
    }

    #[test]
    fn what_the_far_end_produced_counts_as_already_sent() {
        // The model's own reply is on the connection too. Counting only what we
        // sent would resend the assistant's turn back to it.
        let cont = continuation(&[item(1)], &[item(2)]);
        let next = body(&[item(1), item(2)]);
        assert_eq!(
            input_delta(&next, &cont),
            Some(vec![]),
            "nothing new is an empty delta, not a full resend"
        );
    }

    #[test]
    fn a_rewritten_history_falls_back_to_sending_everything() {
        // Compaction rewrites the prefix on purpose. The cached one is then
        // worthless, and pretending otherwise would send the model a
        // conversation it never had.
        let cont = continuation(&[item(1)], &[item(2)]);
        let compacted = body(&[
            json!({ "type": "message", "role": "user", "content": "summary" }),
            item(3),
        ]);
        assert_eq!(input_delta(&compacted, &cont), None);
    }

    #[test]
    fn a_shorter_conversation_is_not_a_delta() {
        let cont = continuation(&[item(1), item(2)], &[item(3)]);
        assert_eq!(input_delta(&body(&[item(1)]), &cont), None);
    }

    #[test]
    fn a_changed_tool_block_invalidates_the_cached_prefix() {
        // Checked before the input: the conversation lining up means nothing if
        // what surrounds it changed.
        let cont = continuation(&[item(1)], &[]);
        let mut next = body(&[item(1), item(2)]);
        next.as_object_mut()
            .unwrap()
            .insert("tools".into(), json!([{ "name": "read" }]));
        assert_eq!(input_delta(&next, &cont), None);
    }

    #[test]
    fn a_changed_model_invalidates_it_too() {
        let cont = continuation(&[item(1)], &[]);
        let mut next = body(&[item(1), item(2)]);
        next.as_object_mut()
            .unwrap()
            .insert("model".into(), json!("gpt-6"));
        assert_eq!(input_delta(&next, &cont), None);
    }

    #[test]
    fn the_continuation_request_carries_the_delta_and_where_to_resume() {
        let next = body(&[item(1), item(2)]);
        let sent = continuation_body(&next, vec![item(2)], "resp_7");
        assert_eq!(sent["input"], json!([item(2)]));
        assert_eq!(sent["previous_response_id"], json!("resp_7"));
        assert_eq!(sent["model"], json!("gpt-5.5"), "the rest is unchanged");
    }

    #[test]
    fn the_account_limit_is_worth_one_more_try() {
        assert_eq!(
            disposition(false, "websocket_connection_limit_reached"),
            Disposition::RetryOnce
        );
    }

    #[test]
    fn a_connection_that_never_opened_falls_back_rather_than_failing() {
        // Nothing has been shown to the user, so SSE can still serve this turn.
        assert_eq!(
            disposition(false, "connect timed out"),
            Disposition::FallBackToSse
        );
        assert_eq!(
            disposition(false, "idle before first event"),
            Disposition::FallBackToSse
        );
    }

    #[test]
    fn a_failure_after_output_started_is_not_retried_or_fallen_back_on() {
        // Falling back here would replay the answer from the beginning and the
        // user would watch it written twice.
        assert_eq!(disposition(true, "connect timed out"), Disposition::Fail);
        assert_eq!(
            disposition(true, "websocket_connection_limit_reached"),
            Disposition::Fail
        );
        assert_eq!(disposition(true, "idle"), Disposition::Fail);
    }

    #[test]
    fn an_unrecognised_failure_is_reported_rather_than_guessed_at() {
        assert_eq!(
            disposition(false, "something new and unexplained"),
            Disposition::Fail
        );
    }

    // ── the pool ─────────────────────────────────────────────────────────

    fn entry(opened_at_ms: u64) -> Pooled {
        Pooled {
            opened_at_ms,
            busy: false,
            continuation: None,
        }
    }

    #[test]
    fn a_fresh_entry_comes_back_out() {
        let mut pool = Pool::new();
        let key = PoolKey::new("s", "a");
        pool.put(key.clone(), entry(0));
        assert!(pool.take(&key, 1000).is_some());
        assert!(
            pool.is_empty(),
            "taking it out means holding it, not sharing it"
        );
    }

    #[test]
    fn an_expired_entry_is_dropped_rather_than_left_to_be_found_again() {
        let mut pool = Pool::new();
        let key = PoolKey::new("s", "a");
        pool.put(key.clone(), entry(0));

        assert!(pool.take(&key, MAX_CONNECTION_AGE_MS).is_none());
        assert!(
            pool.is_empty(),
            "a connection too old to use is also too old to keep"
        );
    }

    #[test]
    fn one_account_cannot_reach_anothers_connection() {
        let mut pool = Pool::new();
        pool.put(PoolKey::new("s", "account-a"), entry(0));
        assert!(pool.take(&PoolKey::new("s", "account-b"), 1).is_none());
        assert_eq!(pool.len(), 1, "and the other account's is left alone");
    }

    #[test]
    fn falling_back_is_remembered_for_that_session_only() {
        // A proxy that blocks websockets on one conversation says nothing about
        // the next; a global flag would cost every later session its cache.
        let mut pool = Pool::new();
        assert!(pool.may_try("s1"));
        pool.remember_fallback("s1");
        assert!(!pool.may_try("s1"));
        assert!(pool.may_try("s2"));
    }
}
