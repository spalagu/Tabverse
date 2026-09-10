//! Sending the agent's requests, and keeping its credential fresh.
//!
//! The two halves of `codex::provider`'s traits that touch the outside world.
//! Both live here rather than in the runtime crate: one needs an HTTP client
//! the runtime should not have an opinion about, and the other needs the
//! credential store, which belongs to the application.

use anyhow::{anyhow, Context, Result};
use std::sync::Mutex;
use tabverse_agent::codex::auth::{self, Token};
use tabverse_agent::codex::provider::{HttpTransport, TokenSource};

/// Wait no longer than this for the response headers.
///
/// Separate from any limit on the body: a model that thinks for two minutes is
/// working, whereas a server that has not answered at all in thirty seconds is
/// not going to.
const HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Sends over HTTP, handing the body back as it arrives.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

/// What every client in this module asks the factory for.
///
/// The one difference from the factory's own defaults is the one that
/// matters: NO TOTAL TIMEOUT. The body of a streamed answer stays open for as
/// long as the model is talking, so a whole-exchange deadline here would cut
/// off exactly the answers worth waiting for. The sign-in exchanges below are
/// small and not streamed, but they are wrapped in a `tokio::time::timeout`
/// of their own, which is where their deadline comes from.
fn spec() -> crate::http::Spec {
    crate::http::Spec {
        timeout: None,
        connect_timeout: Some(HEADER_TIMEOUT),
        user_agent: None,
    }
}

impl ReqwestTransport {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: crate::http::build(spec())
                .context("failed to build the agent's HTTP client")?,
        })
    }
}

impl HttpTransport for ReqwestTransport {
    fn post_stream(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
        on_chunk: &mut dyn FnMut(&str) -> Result<bool>,
    ) -> Result<u16> {
        // The agent loop is a blocking thread of its own, so blocking here is
        // the honest shape: nothing else is waiting on this thread.
        tauri::async_runtime::block_on(async {
            let mut request = self.client.post(url).body(body.to_string());
            for (name, value) in headers {
                request = request.header(name.as_str(), value.as_str());
            }
            let response = tokio::time::timeout(HEADER_TIMEOUT, request.send())
                .await
                .map_err(|_| anyhow!("Codex did not answer within {HEADER_TIMEOUT:?}"))?
                .context("the request to Codex could not be sent")?;
            let status = response.status().as_u16();

            let mut stream = response.bytes_stream();
            // Bytes arrive split anywhere, including mid-character. Holding the
            // tail of an incomplete sequence is the difference between a parser
            // that works and one that fails on a name with an accent in it.
            let mut carry: Vec<u8> = Vec::new();
            use futures_util::StreamExt;
            while let Some(piece) = stream.next().await {
                let piece = piece.context("the response body stopped early")?;
                carry.extend_from_slice(&piece);
                let text = match std::str::from_utf8(&carry) {
                    Ok(all) => {
                        let owned = all.to_string();
                        carry.clear();
                        owned
                    }
                    Err(e) => {
                        let good = e.valid_up_to();
                        let owned = String::from_utf8_lossy(&carry[..good]).into_owned();
                        carry.drain(..good);
                        owned
                    }
                };
                if text.is_empty() {
                    continue;
                }
                if !on_chunk(&text)? {
                    // The reader has what it needs. Dropping the stream closes
                    // the connection rather than draining a body that may never
                    // end.
                    break;
                }
            }
            Ok(status)
        })
    }
}

/// Holds the credential and refreshes it when it is close to expiring.
pub struct StoredToken {
    current: Mutex<Token>,
    /// Built on first use, not on construction. A token with time left needs
    /// no client at all, and requiring one up front makes holding a credential
    /// depend on the TLS stack being ready — which it is not, for instance,
    /// before the process installs its crypto provider.
    transport: std::sync::OnceLock<ReqwestTransport>,
    /// Called whenever a refreshed token should be written back.
    persist: Box<dyn Fn(&Token) + Send + Sync>,
}

/// How long before expiry to renew. A token that expires during the request it
/// authorises fails in a way that reads as a permissions problem.
const REFRESH_MARGIN_SECS: u64 = 120;

impl StoredToken {
    pub fn new(initial: Token, persist: impl Fn(&Token) + Send + Sync + 'static) -> Self {
        Self {
            current: Mutex::new(initial),
            transport: std::sync::OnceLock::new(),
            persist: Box::new(persist),
        }
    }

    fn transport(&self) -> Result<&ReqwestTransport> {
        if let Some(t) = self.transport.get() {
            return Ok(t);
        }
        let built = ReqwestTransport::new()?;
        Ok(self.transport.get_or_init(|| built))
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

impl TokenSource for StoredToken {
    fn access_token(&self) -> Result<Token> {
        let mut token = self.current.lock().unwrap();
        if !token.needs_refresh(Self::now_ms(), REFRESH_MARGIN_SECS) {
            return Ok(token.clone());
        }

        let (url, form) = auth::refresh_request(&token.refresh);
        let mut answer = String::new();
        let status = self.transport()?.post_stream(
            &url,
            &[(
                "content-type".to_string(),
                "application/x-www-form-urlencoded".to_string(),
            )],
            &encode_form(&form),
            &mut |piece| {
                answer.push_str(piece);
                Ok(true)
            },
        )?;
        if !(200..300).contains(&status) {
            // Named for what it is. "Unauthorized" from the next request would
            // send whoever reads it looking at permissions instead of at a
            // refresh that quietly failed.
            return Err(anyhow!(
                "the sign-in could not be renewed (status {status}); signing in again may be needed"
            ));
        }
        let refreshed = auth::apply_refresh(&token, &answer, Self::now_ms())?;
        (self.persist)(&refreshed);
        *token = refreshed.clone();
        Ok(refreshed)
    }
}

/// How long a silent socket is given before it is treated as dead.
///
/// The same number either side of the first event, because the two cases are
/// told apart by *when* they happen, not by how long they waited: before the
/// answer starts there is still a working fallback, after it there is not.
const WS_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Opens Codex sockets with the TLS stack this tree already builds.
pub struct TokioWsTransport;

impl tabverse_agent::codex::websocket::WsTransport for TokioWsTransport {
    fn open(
        &self,
        url: &str,
        headers: &[(String, String)],
    ) -> Result<Box<dyn tabverse_agent::codex::websocket::WsConnection>> {
        use tokio_websockets::ClientBuilder;

        let uri: http::Uri = url.parse().context("the websocket url is not a uri")?;
        let mut builder = ClientBuilder::from_uri(uri);
        for (name, value) in headers {
            // Content-type and accept describe an HTTP body; a socket has
            // neither, and some gateways reject the handshake that carries them.
            if name == "content-type" || name == "accept" {
                continue;
            }
            let name: http::HeaderName = name.parse().context("bad header name")?;
            let value: http::HeaderValue = value.parse().context("bad header value")?;
            builder = builder
                .add_header(name, value)
                .map_err(|e| anyhow!("the handshake header was refused: {e}"))?;
        }

        let (stream, _) = tauri::async_runtime::block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_millis(
                    tabverse_agent::codex::websocket::CONNECT_TIMEOUT_MS,
                ),
                builder.connect(),
            )
            .await
            // Worded so `disposition` reads it as a connect failure and falls
            // back rather than failing the turn.
            .map_err(|_| anyhow!("websocket connect timed out"))?
            .map_err(|e| anyhow!("websocket connect failed: {e}"))
        })?;

        Ok(Box::new(WsConn {
            stream,
            idle: WS_IDLE_TIMEOUT,
        }))
    }
}

struct WsConn {
    stream:
        tokio_websockets::WebSocketStream<tokio_websockets::MaybeTlsStream<tokio::net::TcpStream>>,
    /// How long a silent socket is given before it is called idle. A field
    /// rather than the constant it is built from, because a test that had to
    /// wait out the real minute would never be written.
    idle: std::time::Duration,
}

impl tabverse_agent::codex::websocket::WsConnection for WsConn {
    fn exchange(
        &mut self,
        body: &str,
        on_chunk: &mut dyn FnMut(&str) -> Result<bool>,
    ) -> Result<()> {
        use futures_util::SinkExt;
        use futures_util::StreamExt;
        use tokio_websockets::Message;

        tauri::async_runtime::block_on(async {
            self.stream
                .send(Message::text(body.to_string()))
                .await
                .context("the request could not be sent over the socket")?;

            let mut started = false;
            loop {
                let next = tokio::time::timeout(self.idle, self.stream.next()).await;
                let message = match next {
                    // Said differently either side of the first event so the
                    // caller can tell a socket that never delivered from one
                    // that stopped mid-answer.
                    Err(_) if started => return Err(anyhow!("the socket went idle mid-answer")),
                    Err(_) => return Err(anyhow!("the socket was idle before the first event")),
                    Ok(None) => return Ok(()),
                    Ok(Some(m)) => m.context("the socket failed while reading")?,
                };
                if let Some(text) = message.as_text() {
                    started = true;
                    if !on_chunk(text)? {
                        return Ok(());
                    }
                } else if message.is_close() {
                    return Ok(());
                }
            }
        })
    }
}

/// POST some JSON and read the whole answer.
///
/// Wall clock in Unix milliseconds, for stamping a token's absolute expiry.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Percent-encode a form body.
///
/// The token endpoint takes form encoding while the device endpoints take
/// JSON. Writing the pair by hand keeps that asymmetry visible at the call
/// site instead of hiding it behind a helper that guesses.
pub fn encode_form(fields: &[(String, String)]) -> String {
    fn escape(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                b' ' => "+".to_string(),
                other => format!("%{other:02X}"),
            })
            .collect()
    }
    fields
        .iter()
        .map(|(k, v)| format!("{}={}", escape(k), escape(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Post a form-encoded body. Used for the two `/oauth/token` exchanges.
pub async fn post_form(url: &str, fields: &[(String, String)]) -> Result<(u16, String)> {
    let client = crate::http::build(spec()).context("failed to build the sign-in HTTP client")?;
    let response = tokio::time::timeout(
        HEADER_TIMEOUT,
        client
            .post(url)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(encode_form(fields))
            .send(),
    )
    .await
    .map_err(|_| anyhow!("the sign-in service did not answer within {HEADER_TIMEOUT:?}"))?
    .context("the sign-in request could not be sent")?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok((status, text))
}

/// Where the agent's sign-in is filed in the credential vault.
const TOKEN_KEY: &str = "codex-token";

/// Read the stored sign-in, if there is one.
///
/// A vault that will not open is reported as "not signed in" rather than as an
/// error: from where the caller stands the two are the same, and the second
/// spelling invites a retry that cannot help.
pub fn stored_token() -> Option<Token> {
    let raw = crate::credentials::read_agent_secret(TOKEN_KEY).ok()??;
    serde_json::from_str(&raw).ok()
}

/// File a sign-in, replacing whatever was there.
pub fn store_token(token: &Token) -> Result<()> {
    let raw = serde_json::to_string(token)?;
    crate::credentials::save_agent_secret(TOKEN_KEY, &raw).map_err(|e| anyhow!("{e}"))
}

/// Sign out.
pub fn forget_token() -> Result<()> {
    crate::credentials::delete_agent_secret(TOKEN_KEY).map_err(|e| anyhow!("{e}"))
}

/// A token source backed by the vault, writing back every renewal.
pub fn token_source() -> Result<StoredToken> {
    let token = stored_token().ok_or_else(|| anyhow!("not signed in to Codex"))?;
    Ok(StoredToken::new(token, |renewed| {
        // A renewal that cannot be filed is not worth failing the request
        // over — the token in hand still works. It will simply be renewed
        // again next time rather than read back from disk.
        let _ = store_token(renewed);
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_with_time_left_is_used_as_is() {
        // No network here: a valid token must not cause a request at all, and
        // this test would hang or fail if it did.
        let far_future = StoredToken::now_ms() + 60 * 60 * 1000;
        let source = StoredToken::new(
            Token {
                access: "still-good".into(),
                refresh: "r".into(),
                expires_at_ms: far_future,
            },
            |_| {},
        );
        assert_eq!(source.access_token().unwrap().access, "still-good");
    }

    #[test]
    fn the_refresh_margin_is_long_enough_to_cover_a_request() {
        // Guards the constant itself. Renewing with seconds to spare means the
        // token can expire mid-request, and that failure looks like a
        // permissions problem rather than a timing one.
        const { assert!(REFRESH_MARGIN_SECS >= 60) };
    }

    #[test]
    fn the_header_timeout_does_not_bound_the_answer_itself() {
        // A model thinking for two minutes is working. Only the wait for the
        // first byte is bounded.
        assert!(HEADER_TIMEOUT <= std::time::Duration::from_secs(60));
    }

    #[test]
    fn a_token_round_trips_through_the_vault() {
        // The store seals with a key from the system keychain, so this uses a
        // directory of its own and the same seam the app configures at start.
        let dir = tempfile::tempdir().unwrap();
        let _vault = crate::credentials::test_vault_guard(dir.path().to_path_buf());

        assert!(stored_token().is_none(), "nothing filed yet");
        let token = Token {
            access: "at".into(),
            refresh: "rt".into(),
            expires_at_ms: 1_700_000_000_000,
        };
        store_token(&token).unwrap();

        let read_back = stored_token().expect("what was filed must come back");
        assert_eq!(
            read_back, token,
            "including the expiry, which decides renewal"
        );

        forget_token().unwrap();
        assert!(
            stored_token().is_none(),
            "signing out must actually forget it"
        );
    }

    #[test]
    fn forgetting_every_web_login_does_not_sign_the_agent_out() {
        // The agent's sign-in is not a site password. Filing it among them
        // would put it in the passwords UI and, worse, make "forget all"
        // silently sign the user out of the agent as a side effect.
        let dir = tempfile::tempdir().unwrap();
        let _vault = crate::credentials::test_vault_guard(dir.path().to_path_buf());
        crate::credentials::save_web("example.test", "someone", "hunter2").unwrap();
        store_token(&Token {
            access: "at".into(),
            refresh: "rt".into(),
            expires_at_ms: 1,
        })
        .unwrap();

        let forgotten = crate::credentials::forget_all_web().unwrap();

        assert_eq!(forgotten, 1, "the web login went");
        assert!(
            stored_token().is_some(),
            "the agent's sign-in must have stayed"
        );
    }

    #[test]
    fn a_source_cannot_be_built_without_a_sign_in() {
        // Named for what it is. A provider that started with an empty token
        // would fail later, as a 401, and send whoever reads it looking at
        // permissions.
        let dir = tempfile::tempdir().unwrap();
        let _vault = crate::credentials::test_vault_guard(dir.path().to_path_buf());
        let err = match token_source() {
            Ok(_) => panic!("a source must not exist without a sign-in"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("not signed in"), "got {err}");
    }

    #[test]
    fn the_handshake_drops_headers_that_describe_an_http_body() {
        // content-type and accept describe a body a socket does not have, and
        // some gateways reject a handshake that carries them. Asserted through
        // the failure rather than by reading the loop: a bad header name would
        // otherwise be the thing that fails, hiding whether the filter ran.
        use tabverse_agent::codex::websocket::WsTransport;
        let refused = TokioWsTransport.open(
            "wss://127.0.0.1:1/nothing-here",
            &[
                ("content-type".into(), "application/json".into()),
                ("accept".into(), "text/event-stream".into()),
                ("authorization".into(), "Bearer x".into()),
            ],
        );
        // Nothing is listening, so this fails — the point is *how*: at the
        // connection, not at a header the builder would have rejected first.
        let err = match refused {
            Ok(_) => panic!("nothing is listening on that port"),
            Err(e) => e.to_string(),
        };
        assert!(
            err.contains("connect"),
            "expected a connection failure, got {err}"
        );
        assert!(
            !err.contains("header"),
            "the http-only headers must have been filtered out, got {err}"
        );
    }

    #[test]
    fn a_connect_failure_is_worded_so_the_caller_falls_back() {
        // disposition() reads these strings. If the wording drifts, a socket
        // that cannot connect starts failing turns instead of handing them to
        // the HTTP path — with nothing to show why.
        use tabverse_agent::codex::websocket::{disposition, Disposition, WsTransport};
        let err = match TokioWsTransport.open("wss://127.0.0.1:1/nothing", &[]) {
            Ok(_) => panic!("nothing is listening on that port"),
            Err(e) => e.to_string(),
        };
        assert_eq!(
            disposition(false, &err),
            Disposition::FallBackToSse,
            "got {err}"
        );
    }

    /// A socket that is connected but never speaks, and one that speaks once
    /// and then stops. The distinction matters: the first can still fall back
    /// to SSE, the second cannot without printing the answer twice.
    ///
    /// Neither needs a real handshake. `ClientBuilder::take_over` builds the
    /// stream from an already-open socket, which keeps this off the `server`
    /// feature — that one is not in the dependency tree and enabling it would
    /// add compilation units for something only a test wants.
    fn silent_server(
        after_first_frame: bool,
    ) -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a port");
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            // The client's request frame, read and discarded — it is masked and
            // this server has no reason to decode it.
            let _ = stream.read(&mut buf);
            if after_first_frame {
                // One unmasked text frame, server to client: fin + opcode 1,
                // then the length, then the payload.
                let payload = br#"{"type":"response.output_text.delta","delta":"h"}"#;
                let mut frame = vec![0x81u8, payload.len() as u8];
                frame.extend_from_slice(payload);
                let _ = stream.write_all(&frame);
                let _ = stream.flush();
            }
            // Then silence, held open long enough to outlast the idle window.
            std::thread::sleep(std::time::Duration::from_millis(2500));
        });
        (addr, handle)
    }

    fn connect_without_handshake(addr: std::net::SocketAddr) -> WsConn {
        let stream = tauri::async_runtime::block_on(async move {
            let tcp = tokio::net::TcpStream::connect(addr).await.expect("connect");
            tokio_websockets::ClientBuilder::new()
                .take_over(tokio_websockets::MaybeTlsStream::Plain(tcp))
        });
        WsConn {
            stream,
            idle: std::time::Duration::from_millis(300),
        }
    }

    #[test]
    fn a_socket_that_never_speaks_is_worded_so_the_caller_may_fall_back() {
        use tabverse_agent::codex::websocket::{disposition, Disposition, WsConnection};

        let (addr, server) = silent_server(false);
        let mut conn = connect_without_handshake(addr);
        let err = conn
            .exchange("{}", &mut |_| Ok(true))
            .expect_err("a silent socket must not report success");
        let text = err.to_string();

        assert!(
            text.contains("idle before the first event"),
            "unexpected wording: {text}"
        );
        // The wording is an interface, so assert what reads it, not just the
        // string: nothing was produced, so falling back is still safe.
        assert!(
            matches!(disposition(false, &text), Disposition::FallBackToSse),
            "a socket that never spoke should fall back, got {:?}",
            disposition(false, &text)
        );
        drop(conn);
        let _ = server.join();
    }

    #[test]
    fn a_socket_that_stops_mid_answer_is_worded_so_the_caller_may_not() {
        use tabverse_agent::codex::websocket::{disposition, Disposition, WsConnection};

        let (addr, server) = silent_server(true);
        let mut conn = connect_without_handshake(addr);
        let mut chunks = 0usize;
        let err = conn
            .exchange("{}", &mut |_| {
                chunks += 1;
                Ok(true)
            })
            .expect_err("a socket that stops mid-answer must not report success");
        let text = err.to_string();

        assert_eq!(
            chunks, 1,
            "the one frame the server sent should have arrived"
        );
        assert!(
            text.contains("went idle mid-answer"),
            "unexpected wording: {text}"
        );
        // Output already reached the screen, so a fallback would write the
        // answer a second time. The turn has to fail instead.
        assert!(
            matches!(disposition(true, &text), Disposition::Fail),
            "a socket that died mid-answer must not fall back, got {:?}",
            disposition(true, &text)
        );
        drop(conn);
        let _ = server.join();
    }

    #[test]
    fn the_handshake_leaves_behind_the_headers_that_describe_an_http_body() {
        // A plain TCP listener is enough here: the assertion is about what the
        // client *sends*, so the server never has to complete the upgrade. That
        // also keeps this test off the `server` feature, which is not in the
        // dependency tree and would pull one in.
        use std::io::Read;
        use std::net::TcpListener;
        use tabverse_agent::codex::websocket::WsTransport;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a port");
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let recorded = std::sync::Arc::clone(&seen);
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept the handshake");
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            *recorded.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).into_owned();
            // Dropped without a response: the request is the whole subject.
        });

        let _ = TokioWsTransport.open(
            &format!("ws://127.0.0.1:{port}/backend-api/codex/responses"),
            &[
                ("content-type".into(), "application/json".into()),
                ("accept".into(), "text/event-stream".into()),
                ("authorization".into(), "Bearer test-token".into()),
                ("session-id".into(), "tab-7".into()),
            ],
        );
        server.join().expect("the listener thread");
        let request = seen.lock().unwrap().clone();

        assert!(
            !request.is_empty(),
            "the client never sent a handshake; nothing was asserted"
        );
        // By value, not by header name: `accept` also appears inside
        // `Sec-WebSocket-Accept` and `Accept-Encoding`, so matching the name
        // would pass even if the filter were removed.
        assert!(
            !request.contains("application/json"),
            "content-type survived the handshake:\n{request}"
        );
        assert!(
            !request.contains("text/event-stream"),
            "accept survived the handshake:\n{request}"
        );
        // The control: headers that are not about a body must still be there,
        // otherwise "filtered everything" would also pass the two above.
        assert!(
            request.contains("Bearer test-token"),
            "authorization was dropped too:\n{request}"
        );
        assert!(
            request.contains("tab-7"),
            "session-id was dropped too:\n{request}"
        );
    }
}
