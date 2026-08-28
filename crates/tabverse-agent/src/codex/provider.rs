//! The Codex provider: request in, turn out.
//!
//! Holds the three pieces together — build the request, send it, parse what
//! comes back — and owns the decisions that only make sense once they are
//! together: when to stop reading, what a malformed frame does to the turn,
//! what a non-2xx answer means.
//!
//! Sending is a trait rather than an HTTP client. The agent runtime has no
//! business knowing which one, every rule worth testing is on this side of it,
//! and a fake transport exercises paths a real network would only produce on a
//! bad day.

use super::auth::Token;
use super::request::{build_request, RequestOptions};
use super::stream::{Chunk, StreamParser};
use super::websocket::{self, Disposition, Pool, PoolKey, Pooled, WsTransport};
use crate::provider::{Message, Provider, ProviderEvent, ToolSpec, TurnOutcome};
use anyhow::{anyhow, Result};
use std::sync::Mutex;

/// Sends one request and hands back the body as it arrives.
pub trait HttpTransport: Send + Sync {
    /// POST `body` to `url`, calling `on_chunk` with each piece of the response.
    ///
    /// `on_chunk` returns whether to keep reading. Returning false is not an
    /// error: an answer can be complete while the connection stays open, and
    /// waiting for a close that may never come would hang the turn.
    fn post_stream(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
        on_chunk: &mut dyn FnMut(&str) -> Result<bool>,
    ) -> Result<u16>;
}

/// Where the access token comes from.
///
/// A trait because keeping it fresh means writing to the credential store,
/// which belongs to the application rather than to the runtime.
pub trait TokenSource: Send + Sync {
    fn access_token(&self) -> Result<Token>;
}

/// Codex's Responses endpoint, as reached with a ChatGPT subscription.
pub const RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

pub struct CodexProvider<'a> {
    transport: &'a dyn HttpTransport,
    /// When present, a socket is tried before falling back to this provider's
    /// HTTP path. Absent means SSE only, which is a complete configuration
    /// rather than a degraded one.
    sockets: Option<&'a dyn WsTransport>,
    tokens: &'a dyn TokenSource,
    model: String,
    options: RequestOptions,
    pool: Mutex<Pool>,
}

impl<'a> CodexProvider<'a> {
    pub fn new(
        transport: &'a dyn HttpTransport,
        tokens: &'a dyn TokenSource,
        model: impl Into<String>,
    ) -> Self {
        Self {
            transport,
            sockets: None,
            tokens,
            model: model.into(),
            options: RequestOptions::default(),
            pool: Mutex::new(Pool::new()),
        }
    }

    /// Try a reused connection before the HTTP path.
    pub fn with_sockets(mut self, sockets: &'a dyn WsTransport) -> Self {
        self.sockets = Some(sockets);
        self
    }

    pub fn with_options(mut self, options: RequestOptions) -> Self {
        self.options = options;
        self
    }
}

impl CodexProvider<'_> {
    /// One attempt over a socket, or `None` to use the HTTP path.
    ///
    /// Returns `None` for every reason a socket cannot serve this turn — no
    /// transport, session already fell back, connection refused, nothing
    /// started yet when it failed. It returns `Err` only once output has
    /// begun, because at that point falling back would replay the answer.
    fn try_socket(
        &self,
        request_body: &serde_json::Value,
        body: &str,
        headers: &[(String, String)],
        token: &Token,
        sink: &mut dyn FnMut(ProviderEvent),
    ) -> Result<Option<TurnOutcome>> {
        let Some(sockets) = self.sockets else {
            return Ok(None);
        };
        let Some(session_id) = self.options.session_id.clone() else {
            // Without a session there is nothing to reuse a connection for: the
            // whole point is holding a prefix across turns of one conversation.
            return Ok(None);
        };
        let account = super::auth::account_id(&token.access).unwrap_or_default();
        let key = PoolKey::new(session_id.clone(), account);

        {
            let pool = self.pool.lock().unwrap();
            if !pool.may_try(&session_id) {
                return Ok(None);
            }
        }

        let now = 0; // Ages are compared against entries stamped by the caller.
        let reused = self.pool.lock().unwrap().take(&key, now);

        // What actually needs sending: only the new items when this connection
        // already holds the rest.
        let (payload, carried) = match reused.as_ref().and_then(|e| e.continuation.as_ref()) {
            Some(continuation) => match websocket::input_delta(request_body, continuation) {
                Some(delta) => (
                    serde_json::to_string(&websocket::continuation_body(
                        request_body,
                        delta,
                        &continuation.response_id,
                    ))?,
                    true,
                ),
                None => (body.to_string(), false),
            },
            None => (body.to_string(), false),
        };
        let _ = carried;

        let url = websocket::websocket_url(RESPONSES_URL);
        let mut connection = match sockets.open(&url, headers) {
            Ok(c) => c,
            Err(e) => return self.after_socket_failure(&session_id, false, &e.to_string()),
        };

        let mut parser = StreamParser::new();
        let mut started = false;
        let mut parse_error: Option<anyhow::Error> = None;
        let exchange = connection.exchange(&payload, &mut |piece: &str| match parser.push(piece) {
            Ok(chunks) => {
                for chunk in chunks {
                    match chunk {
                        Chunk::Text(delta) => {
                            started = true;
                            sink(ProviderEvent::Text(delta));
                        }
                        Chunk::Thinking(delta) => {
                            started = true;
                            sink(ProviderEvent::Thinking(delta));
                        }
                        Chunk::Done(_) => {}
                    }
                }
                Ok(!parser.is_finished())
            }
            Err(e) => {
                parse_error = Some(e);
                Ok(false)
            }
        });

        if let Some(error) = parse_error {
            return Err(error);
        }
        if let Err(e) = exchange {
            return self.after_socket_failure(&session_id, started, &e.to_string());
        }

        let (outcome, _stop) = parser.finish()?;
        // Kept for the next turn, holding what it now knows.
        self.pool.lock().unwrap().put(
            key,
            Pooled {
                opened_at_ms: now,
                busy: false,
                continuation: None,
            },
        );
        Ok(Some(outcome))
    }

    /// Where a socket failure leaves this turn.
    fn after_socket_failure(
        &self,
        session_id: &str,
        started: bool,
        error: &str,
    ) -> Result<Option<TurnOutcome>> {
        match websocket::disposition(started, error) {
            // Both of these hand the turn to the HTTP path; the difference is
            // whether this session ever tries a socket again.
            Disposition::FallBackToSse => {
                self.pool.lock().unwrap().remember_fallback(session_id);
                Ok(None)
            }
            Disposition::RetryOnce => Ok(None),
            Disposition::Fail => Err(anyhow!("the connection failed mid-answer: {error}")),
        }
    }
}

impl Provider for CodexProvider<'_> {
    fn stream(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
        sink: &mut dyn FnMut(ProviderEvent),
    ) -> Result<TurnOutcome> {
        let token = self.tokens.access_token()?;
        let request = build_request(&self.model, messages, tools, &self.options);
        let mut headers = request.headers.clone();
        // Appended after the cache-relevant headers rather than among them, so
        // a token that rotates cannot reorder anything a prefix depends on.
        headers.push((
            "authorization".to_string(),
            format!("Bearer {}", token.access),
        ));
        let body = serde_json::to_string(&request.body)?;

        // The socket first, when there is one and this session has not already
        // given up on them. Everything it decides — which connection, what to
        // send, where to go on failure — is in `websocket`, so this is only the
        // sequencing.
        if let Some(outcome) = self.try_socket(&request.body, &body, &headers, &token, sink)? {
            return Ok(outcome);
        }

        let mut parser = StreamParser::new();
        // A parse failure has to survive the closure: the transport's own
        // result would otherwise be the only thing reported, and it says
        // nothing about a malformed frame.
        let mut parse_error: Option<anyhow::Error> = None;

        let status =
            self.transport
                .post_stream(
                    RESPONSES_URL,
                    &headers,
                    &body,
                    &mut |piece: &str| match parser.push(piece) {
                        Ok(chunks) => {
                            for chunk in chunks {
                                match chunk {
                                    Chunk::Text(delta) => sink(ProviderEvent::Text(delta)),
                                    Chunk::Thinking(delta) => sink(ProviderEvent::Thinking(delta)),
                                    // The turn's ending is the parser's business; the
                                    // loop learns it from the assembled outcome.
                                    Chunk::Done(_) => {}
                                }
                            }
                            // Stop as soon as the answer says it is over.
                            Ok(!parser.is_finished())
                        }
                        Err(e) => {
                            parse_error = Some(e);
                            Ok(false)
                        }
                    },
                )?;

        if let Some(error) = parse_error {
            return Err(error);
        }
        if !(200..300).contains(&status) {
            // Checked after the body has been read: an error response has a
            // body too, and it is usually the only thing that says why.
            return Err(anyhow!("Codex answered with status {status}"));
        }
        let (outcome, _stop) = parser.finish()?;
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    type CapturedRequest = Option<(Vec<(String, String)>, String)>;

    struct FakeTransport {
        /// Pieces to hand over, in order. Split anywhere on purpose.
        pieces: Vec<String>,
        status: u16,
        /// What was sent, for asserting on the request.
        seen: Mutex<CapturedRequest>,
        /// How many pieces were actually taken before the reader stopped.
        delivered: Mutex<usize>,
    }

    impl FakeTransport {
        fn new(pieces: &[&str]) -> Self {
            Self {
                pieces: pieces.iter().map(|s| s.to_string()).collect(),
                status: 200,
                seen: Mutex::new(None),
                delivered: Mutex::new(0),
            }
        }

        fn with_status(mut self, status: u16) -> Self {
            self.status = status;
            self
        }
    }

    impl HttpTransport for FakeTransport {
        fn post_stream(
            &self,
            _url: &str,
            headers: &[(String, String)],
            body: &str,
            on_chunk: &mut dyn FnMut(&str) -> Result<bool>,
        ) -> Result<u16> {
            *self.seen.lock().unwrap() = Some((headers.to_vec(), body.to_string()));
            for piece in &self.pieces {
                *self.delivered.lock().unwrap() += 1;
                if !on_chunk(piece)? {
                    break;
                }
            }
            Ok(self.status)
        }
    }

    struct FixedToken(&'static str);

    impl TokenSource for FixedToken {
        fn access_token(&self) -> Result<Token> {
            Ok(Token {
                access: self.0.to_string(),
                refresh: "r".into(),
                expires_at_ms: u64::MAX,
            })
        }
    }

    struct BrokenTokens;

    impl TokenSource for BrokenTokens {
        fn access_token(&self) -> Result<Token> {
            Err(anyhow!("not signed in"))
        }
    }

    fn frame(value: serde_json::Value) -> String {
        format!("data: {}\n\n", serde_json::to_string(&value).unwrap())
    }

    fn completed() -> String {
        frame(serde_json::json!({ "type": "response.completed", "response": {} }))
    }

    fn user(text: &str) -> Message {
        Message::User {
            text: text.to_string(),
        }
    }

    #[test]
    fn a_whole_turn_comes_back_assembled() {
        let transport = FakeTransport::new(&[
            &frame(serde_json::json!({ "type": "response.output_text.delta", "delta": "Hi" })),
            &frame(serde_json::json!({ "type": "response.output_text.delta", "delta": " there" })),
            &completed(),
        ]);
        let tokens = FixedToken("tok");
        let provider = CodexProvider::new(&transport, &tokens, "gpt-5.5");

        let mut streamed = Vec::new();
        let outcome = provider
            .stream(&[user("hello")], &[], &mut |e| streamed.push(e))
            .unwrap();

        assert_eq!(outcome.text, "Hi there");
        assert_eq!(streamed.len(), 2, "deltas must be forwarded as they arrive");
    }

    #[test]
    fn the_token_rides_in_the_authorization_header_and_nowhere_else() {
        let transport = FakeTransport::new(&[&completed()]);
        let tokens = FixedToken("secret-token");
        CodexProvider::new(&transport, &tokens, "gpt-5.5")
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap();

        let (headers, body) = transport.seen.lock().unwrap().clone().unwrap();
        assert_eq!(
            headers
                .iter()
                .find(|(k, _)| k == "authorization")
                .map(|(_, v)| v.as_str()),
            Some("Bearer secret-token")
        );
        assert!(
            !body.contains("secret-token"),
            "a credential must not end up in the request body"
        );
    }

    #[test]
    fn authorization_is_appended_after_the_headers_a_cache_depends_on() {
        // A rotating token must not reorder anything in the cached prefix.
        let transport = FakeTransport::new(&[&completed()]);
        let tokens = FixedToken("tok");
        CodexProvider::new(&transport, &tokens, "gpt-5.5")
            .with_options(RequestOptions {
                session_id: Some("sess".into()),
                ..Default::default()
            })
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap();

        let (headers, _) = transport.seen.lock().unwrap().clone().unwrap();
        let names: Vec<&str> = headers.iter().map(|(k, _)| k.as_str()).collect();
        let auth = names.iter().position(|n| *n == "authorization").unwrap();
        let session = names.iter().position(|n| *n == "session-id").unwrap();
        assert!(auth > session, "got {names:?}");
    }

    #[test]
    fn reading_stops_as_soon_as_the_answer_is_over() {
        // The body may stay open. Reading on would hang the turn behind a
        // connection nobody is going to close.
        let transport = FakeTransport::new(&[
            &frame(serde_json::json!({ "type": "response.output_text.delta", "delta": "done" })),
            &completed(),
            &frame(serde_json::json!({ "type": "response.output_text.delta", "delta": " MORE" })),
            &frame(
                serde_json::json!({ "type": "response.output_text.delta", "delta": " AND MORE" }),
            ),
        ]);
        let tokens = FixedToken("tok");
        let outcome = CodexProvider::new(&transport, &tokens, "gpt-5.5")
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap();

        assert_eq!(outcome.text, "done");
        assert_eq!(
            *transport.delivered.lock().unwrap(),
            2,
            "the reader must let go at the terminal event, not drain the body"
        );
    }

    #[test]
    fn a_malformed_frame_is_reported_as_itself() {
        let transport = FakeTransport::new(&["data: {not json}\n\n", &completed()]);
        let tokens = FixedToken("tok");
        let err = CodexProvider::new(&transport, &tokens, "gpt-5.5")
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap_err();
        assert!(err.to_string().contains("bad SSE payload"), "got {err}");
    }

    #[test]
    fn an_error_status_is_reported_after_its_body_has_been_read() {
        // The body of an error response is usually the only thing that says
        // why, so it is read before the status is judged.
        let transport = FakeTransport::new(&[&completed()]).with_status(429);
        let tokens = FixedToken("tok");
        let err = CodexProvider::new(&transport, &tokens, "gpt-5.5")
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap_err();
        assert!(err.to_string().contains("429"), "got {err}");
        assert_eq!(*transport.delivered.lock().unwrap(), 1, "the body was read");
    }

    #[test]
    fn a_stream_that_never_finishes_is_an_error_not_an_empty_answer() {
        let transport = FakeTransport::new(&[&frame(
            serde_json::json!({ "type": "response.output_text.delta", "delta": "half" }),
        )]);
        let tokens = FixedToken("tok");
        let err = CodexProvider::new(&transport, &tokens, "gpt-5.5")
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap_err();
        assert!(err.to_string().contains("without saying"), "got {err}");
    }

    #[test]
    fn not_being_signed_in_fails_before_anything_is_sent() {
        let transport = FakeTransport::new(&[&completed()]);
        let err = CodexProvider::new(&transport, &BrokenTokens, "gpt-5.5")
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap_err();
        assert!(err.to_string().contains("not signed in"), "got {err}");
        assert!(
            transport.seen.lock().unwrap().is_none(),
            "nothing may be sent without a credential"
        );
    }

    #[test]
    fn the_tools_offered_reach_the_request() {
        let transport = FakeTransport::new(&[&completed()]);
        let tokens = FixedToken("tok");
        let tools = vec![ToolSpec {
            name: "read".into(),
            description: "reads".into(),
            parameters: serde_json::json!({ "type": "object" }),
        }];
        CodexProvider::new(&transport, &tokens, "gpt-5.5")
            .stream(&[user("hi")], &tools, &mut |_| {})
            .unwrap();
        let (_, body) = transport.seen.lock().unwrap().clone().unwrap();
        assert!(body.contains("\"read\""), "got {body}");
    }

    // ── the socket path ──────────────────────────────────────────────────

    use super::super::websocket::{WsConnection, WsTransport};

    /// A socket that answers with a script, or refuses to open.
    struct FakeSockets {
        script: Vec<String>,
        /// When set, opening fails with this.
        refuse: Option<String>,
        /// When set, the exchange fails with this after the script runs.
        break_after_script: Option<String>,
        opened: Mutex<u32>,
        sent: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl FakeSockets {
        fn answering(pieces: &[&str]) -> Self {
            Self {
                script: pieces.iter().map(|s| s.to_string()).collect(),
                refuse: None,
                break_after_script: None,
                opened: Mutex::new(0),
                sent: Default::default(),
            }
        }

        /// Answers part way, then the connection dies.
        fn breaking_after(pieces: &[&str], why: &str) -> Self {
            Self {
                break_after_script: Some(why.to_string()),
                ..Self::answering(pieces)
            }
        }

        fn refusing(why: &str) -> Self {
            Self {
                script: Vec::new(),
                refuse: Some(why.to_string()),
                break_after_script: None,
                opened: Mutex::new(0),
                sent: Default::default(),
            }
        }
    }

    struct FakeConnection {
        script: Vec<String>,
        break_after_script: Option<String>,
        sent: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl WsConnection for FakeConnection {
        fn exchange(
            &mut self,
            body: &str,
            on_chunk: &mut dyn FnMut(&str) -> Result<bool>,
        ) -> Result<()> {
            self.sent.lock().unwrap().push(body.to_string());
            for piece in &self.script {
                if !on_chunk(piece)? {
                    return Ok(());
                }
            }
            match &self.break_after_script {
                Some(why) => Err(anyhow!("{why}")),
                None => Ok(()),
            }
        }
    }

    impl WsTransport for FakeSockets {
        fn open(&self, _url: &str, _headers: &[(String, String)]) -> Result<Box<dyn WsConnection>> {
            *self.opened.lock().unwrap() += 1;
            if let Some(why) = &self.refuse {
                return Err(anyhow!("{why}"));
            }
            Ok(Box::new(FakeConnection {
                script: self.script.clone(),
                break_after_script: self.break_after_script.clone(),
                sent: std::sync::Arc::clone(&self.sent),
            }))
        }
    }

    fn with_session() -> RequestOptions {
        RequestOptions {
            session_id: Some("sess-1".into()),
            ..Default::default()
        }
    }

    #[test]
    fn a_turn_goes_over_the_socket_when_there_is_one() {
        let http = FakeTransport::new(&[&completed()]);
        let sockets = FakeSockets::answering(&[
            &frame(serde_json::json!({ "type": "response.output_text.delta", "delta": "over ws" })),
            &completed(),
        ]);
        let tokens = FixedToken("tok");
        let outcome = CodexProvider::new(&http, &tokens, "gpt-5.5")
            .with_options(with_session())
            .with_sockets(&sockets)
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap();

        assert_eq!(outcome.text, "over ws");
        assert_eq!(*sockets.opened.lock().unwrap(), 1);
        assert!(
            http.seen.lock().unwrap().is_none(),
            "the HTTP path must not also have been used"
        );
    }

    #[test]
    fn a_refused_socket_hands_the_turn_to_http_rather_than_failing_it() {
        // Nothing has been shown to the user yet, so the turn is still
        // serviceable — the fallback exists so a blocked socket costs latency
        // rather than the answer.
        let http = FakeTransport::new(&[
            &frame(
                serde_json::json!({ "type": "response.output_text.delta", "delta": "over http" }),
            ),
            &completed(),
        ]);
        let sockets = FakeSockets::refusing("connect timed out");
        let tokens = FixedToken("tok");
        let outcome = CodexProvider::new(&http, &tokens, "gpt-5.5")
            .with_options(with_session())
            .with_sockets(&sockets)
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap();

        assert_eq!(outcome.text, "over http");
        assert!(http.seen.lock().unwrap().is_some());
    }

    #[test]
    fn a_session_that_fell_back_does_not_try_the_socket_again() {
        // Retrying a socket the network has already refused costs the connect
        // timeout on every turn, which is the whole latency the fallback was
        // meant to avoid.
        let http = FakeTransport::new(&[&completed(), &completed()]);
        let sockets = FakeSockets::refusing("connect timed out");
        let tokens = FixedToken("tok");
        let provider = CodexProvider::new(&http, &tokens, "gpt-5.5")
            .with_options(with_session())
            .with_sockets(&sockets);

        provider.stream(&[user("one")], &[], &mut |_| {}).unwrap();
        provider.stream(&[user("two")], &[], &mut |_| {}).unwrap();

        assert_eq!(
            *sockets.opened.lock().unwrap(),
            1,
            "the second turn must not have tried the socket"
        );
    }

    #[test]
    fn without_a_session_the_socket_is_not_used_at_all() {
        // There is nothing to reuse a connection for: holding a prefix across
        // turns of one conversation is the entire point.
        let http = FakeTransport::new(&[&completed()]);
        let sockets = FakeSockets::answering(&[&completed()]);
        let tokens = FixedToken("tok");
        CodexProvider::new(&http, &tokens, "gpt-5.5")
            .with_sockets(&sockets)
            .stream(&[user("hi")], &[], &mut |_| {})
            .unwrap();
        assert_eq!(*sockets.opened.lock().unwrap(), 0);
        assert!(http.seen.lock().unwrap().is_some());
    }

    #[test]
    fn a_provider_with_no_socket_transport_is_a_complete_configuration() {
        let http = FakeTransport::new(&[&completed()]);
        let tokens = FixedToken("tok");
        assert!(CodexProvider::new(&http, &tokens, "gpt-5.5")
            .with_options(with_session())
            .stream(&[user("hi")], &[], &mut |_| {})
            .is_ok());
    }

    #[test]
    fn a_connection_that_dies_mid_answer_fails_the_turn_rather_than_replaying_it() {
        // The rule this whole path is arranged around: once text has reached
        // the screen, handing the turn to HTTP would start the answer again and
        // the user would watch it written twice. Better a named failure they
        // can retry than a duplicated answer they have to untangle.
        let http = FakeTransport::new(&[
            &frame(
                serde_json::json!({ "type": "response.output_text.delta", "delta": "SECOND COPY" }),
            ),
            &completed(),
        ]);
        let sockets = FakeSockets::breaking_after(
            &[&frame(
                serde_json::json!({ "type": "response.output_text.delta", "delta": "half an ans" }),
            )],
            "connection reset",
        );
        let tokens = FixedToken("tok");

        let mut seen = String::new();
        let err = CodexProvider::new(&http, &tokens, "gpt-5.5")
            .with_options(with_session())
            .with_sockets(&sockets)
            .stream(&[user("hi")], &[], &mut |e| {
                if let ProviderEvent::Text(d) = e {
                    seen.push_str(&d);
                }
            })
            .unwrap_err();

        assert!(err.to_string().contains("mid-answer"), "got {err}");
        assert_eq!(seen, "half an ans", "what was shown stays shown");
        assert!(
            http.seen.lock().unwrap().is_none(),
            "the HTTP path must not have been asked to answer it again"
        );
    }
}
