//! Catching the OAuth callback.
//!
//! The browser is sent to OpenAI, the user signs in there, and OpenAI redirects
//! to `http://localhost:1455/auth/callback?code=…`. Something has to be
//! listening on that port for the redirect to land, and the port is not ours to
//! choose — the server compares the whole redirect URI, so a listener anywhere
//! else is simply never reached.
//!
//! It is one connection's worth of HTTP: read the request line, answer with a
//! page saying the tab can be closed. Reaching for a web framework to do that
//! would add a dependency and a runtime to something that ends in a minute.

use anyhow::{anyhow, Context, Result};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use tabverse_agent::codex::auth;

/// How long the listener waits before giving the port back. Long enough to
/// find a password manager, short enough that a forgotten login does not hold
/// the port until the app quits.
const WAIT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Where a sign-in has got to. Polled by the interface, which wants to show a
/// spinner rather than block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    Waiting,
    Done,
    Failed(String),
}

/// A sign-in in flight.
#[derive(Debug)]
pub struct Pending {
    pub url: String,
    progress: Arc<Mutex<Progress>>,
}

impl Pending {
    pub fn progress(&self) -> Progress {
        self.progress.lock().unwrap().clone()
    }
}

/// Start one: bind the port, hand back the URL to open.
///
/// Binding before returning is deliberate. If the port is taken, the caller
/// finds out now — while it can still say so — rather than after sending the
/// user to a browser that will redirect into nothing.
pub fn start(originator: &str) -> Result<Pending> {
    let verifier = random_token(64);
    let state = random_token(16);
    let login = auth::browser_login(&verifier, &state, originator);

    let listener = TcpListener::bind(("127.0.0.1", auth::REDIRECT_PORT)).with_context(|| {
        format!(
            "port {} is in use, so the sign-in would have nowhere to come back to",
            auth::REDIRECT_PORT
        )
    })?;

    let progress = Arc::new(Mutex::new(Progress::Waiting));
    let reported = Arc::clone(&progress);
    let expected_state = state.clone();
    let for_exchange = verifier.clone();

    std::thread::Builder::new()
        .name("tabverse-oauth-callback".into())
        .spawn(move || {
            let outcome = catch_callback(listener, &expected_state)
                .and_then(|code| exchange_and_store(&code, &for_exchange));
            *reported.lock().unwrap() = match outcome {
                Ok(()) => Progress::Done,
                Err(e) => Progress::Failed(format!("{e:#}")),
            };
        })
        .context("the callback listener thread could not be started")?;

    Ok(Pending {
        url: login.url,
        progress,
    })
}

/// Wait for the browser to arrive, and read the code out of what it asked for.
fn catch_callback(listener: TcpListener, expected_state: &str) -> Result<String> {
    listener
        .set_nonblocking(false)
        .context("the callback listener could not be configured")?;

    let deadline = std::time::Instant::now() + WAIT;
    for stream in listener.incoming() {
        if std::time::Instant::now() > deadline {
            return Err(anyhow!("the sign-in was not completed in time"));
        }
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut line = String::new();
        BufReader::new(
            stream
                .try_clone()
                .context("the callback connection could not be read")?,
        )
        .read_line(&mut line)
        .context("the callback request could not be read")?;

        // `GET /auth/callback?code=…&state=… HTTP/1.1`. Only the middle field
        // matters; the browser is told to stop either way, because leaving it
        // waiting looks to the user like the login hung.
        let target = line
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_string();
        let read = auth::read_callback(&target, expected_state);
        let body = match &read {
            Ok(_) => "<h2>Signed in</h2><p>You can close this tab and go back to Tabverse.</p>",
            Err(_) => "<h2>Sign-in failed</h2><p>Go back to Tabverse for the reason.</p>",
        };
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.flush();
        return read;
    }
    Err(anyhow!("the sign-in was not completed"))
}

fn exchange_and_store(code: &str, verifier: &str) -> Result<()> {
    let (url, form) = auth::browser_exchange_request(code, verifier);
    let (status, answer) =
        tauri::async_runtime::block_on(crate::agent_http::post_form(&url, &form))?;
    if !(200..300).contains(&status) {
        // The body carries the reason; without it this reads as "login broken"
        // with nothing to act on.
        return Err(anyhow!(
            "the sign-in was approved but the token exchange failed (status {status}): {}",
            answer.trim()
        ));
    }
    let token = auth::parse_token(&answer, crate::agent_http::now_ms())?;
    crate::agent_http::store_token(&token)
}

/// A URL-safe random string, for the verifier and the state.
fn random_token(bytes: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    (0..bytes)
        .map(|_| {
            let byte: u8 = rand::random();
            ALPHABET[byte as usize % ALPHABET.len()] as char
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verifier_is_long_enough_to_be_worth_having_and_url_safe() {
        // RFC 7636 puts the floor at 43 characters. Shorter is guessable, and
        // a character outside this set would be re-encoded in the exchange and
        // stop matching the challenge.
        let token = random_token(64);
        assert_eq!(token.len(), 64);
        assert!(token.len() >= 43);
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)),
            "not url-safe: {token}"
        );
    }

    #[test]
    fn two_logins_do_not_share_a_verifier() {
        assert_ne!(random_token(64), random_token(64));
    }

    #[test]
    fn the_port_being_taken_is_reported_before_the_browser_is_sent_anywhere() {
        // The failure worth being careful about: returning a URL, sending the
        // user off to sign in, and only then finding out that the redirect has
        // nowhere to land.
        // Not `expect`: on a machine where Tabverse itself is running and has
        // a sign-in open, the port is already taken — which is precisely the
        // situation under test. Either this line holds it or something else
        // does; both make the next call fail, and demanding to win the race
        // only made the test red for the wrong reason.
        let _held = TcpListener::bind(("127.0.0.1", auth::REDIRECT_PORT)).ok();
        let err = start("tabverse").expect_err("binding twice must fail");
        assert!(err.to_string().contains("in use"), "got {err:#}");
    }
}
