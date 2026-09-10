//! Signing in to a ChatGPT subscription.
//!
//! The device code flow, not the authorisation code flow the task originally
//! assumed. Upstream uses it and the reason holds here: a desktop application
//! would otherwise have to run a local HTTP server to catch the redirect, open
//! a port, and deal with the browser landing on it. The device flow asks the
//! user to type a short code into a page they already trust, and polls.
//!
//! Everything in this file is a pure function of a request or a response.
//! Sending, waiting and storing live elsewhere, which is what lets the rules
//! that are easy to get quietly wrong — a 403 that means "not yet", an expiry
//! that is a duration rather than a timestamp — be tested without a network.
//!
//! Endpoint and client behavior was informed by Pi's
//! `packages/ai/src/auth/oauth/openai-codex.ts`; see the repository's `NOTICE`
//! file for attribution and license terms.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The public client identifier Codex logins are made under. Not a secret —
/// device flow has no client secret, which is the point of it.
pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const AUTH_BASE: &str = "https://auth.openai.com";

// These are OpenAI's own device endpoints, not the RFC 8628 ones. An earlier
// version of this file used `/oauth/device/code` and the standard polling
// grant, which reads like the obvious choice and answers 404 to every request.
// The flow below is also a step longer than the standard one: polling yields
// an authorisation code, and that is exchanged for the token separately.
pub const DEVICE_USERCODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
pub const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
pub const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// Where the user types the short code.
pub const DEVICE_VERIFICATION_URI: &str = "https://auth.openai.com/codex/device";
/// Named in the final exchange. Nothing ever listens on it — the device flow
/// exists so that a desktop application does not have to.
pub const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";

/// How long the whole flow may take before it is abandoned. Upstream's number:
/// long enough for someone to find their phone, short enough that a forgotten
/// login does not poll forever.
pub const DEVICE_CODE_TIMEOUT_SECS: u64 = 15 * 60;

/// The floor on how often to poll, whatever the server suggests. A server that
/// answers `interval: 0` must not turn into a busy loop against it.
pub const MIN_POLL_INTERVAL_SECS: u64 = 1;

/// What the user has to do, once the device flow has started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceLogin {
    /// Identifies this login attempt to the server. Paired with `user_code` on
    /// every poll — the endpoint wants both, unlike the standard flow where the
    /// device code alone is the credential.
    pub device_auth_id: String,
    /// The short code the user types.
    pub user_code: String,
    /// Where they type it. A constant: this response does not carry one.
    pub verification_uri: String,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
}

/// A live credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Token {
    pub access: String,
    pub refresh: String,
    /// Unix milliseconds. Absolute rather than a duration, because a duration
    /// is only meaningful next to the moment it was received, and that moment
    /// is exactly what is lost when a token is written to disk and read back.
    pub expires_at_ms: u64,
}

impl Token {
    /// Should this be refreshed before being used?
    ///
    /// With a margin: a token that expires during the request it is
    /// authorising has failed, and the failure looks like a permissions
    /// problem rather than a timing one.
    pub fn needs_refresh(&self, now_ms: u64, margin_secs: u64) -> bool {
        self.expires_at_ms <= now_ms.saturating_add(margin_secs * 1000)
    }
}

/// The browser sign-in, which is the one that works.
///
/// The device flow this file also implements is what OpenAI answers 404 to —
/// upstream's own message for that status says device code login "is not
/// enabled for this server, use browser login". Kept because the endpoints are
/// real and may be enabled for some accounts; not the default.
pub const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
pub const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
/// The port in `REDIRECT_URI`. The server checks the whole string, so this is
/// not ours to choose — a listener anywhere else would never be reached.
pub const REDIRECT_PORT: u16 = 1455;
pub const SCOPE: &str = "openid profile email offline_access";

/// What a browser sign-in needs to remember while the user is away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserLogin {
    /// Where to send the browser.
    pub url: String,
    /// Proves, at exchange time, that whoever redeems the code is whoever
    /// asked for it. Never leaves this machine.
    pub verifier: String,
    /// Echoed back on the callback. A mismatch means the callback belongs to
    /// somebody else's login attempt, and the code with it.
    pub state: String,
}

/// Build the authorisation URL, given the two random values.
///
/// Randomness is the caller's: this crate stays a pure function of its inputs,
/// which is what lets the URL be asserted character by character.
pub fn browser_login(verifier: &str, state: &str, originator: &str) -> BrowserLogin {
    let challenge = pkce_challenge(verifier);
    let query = [
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", REDIRECT_URI),
        ("scope", SCOPE),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        // Both come from upstream's URL. Without the first, tokens issued to
        // an account that belongs to organisations come back missing them.
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("originator", originator),
    ]
    .iter()
    .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
    .collect::<Vec<_>>()
    .join("&");

    BrowserLogin {
        url: format!("{AUTHORIZE_URL}?{query}"),
        verifier: verifier.to_string(),
        state: state.to_string(),
    }
}

pub fn pkce_challenge(verifier: &str) -> String {
    base64_url_encode(&sha256(verifier.as_bytes()))
}

/// Read the code out of the callback the browser was redirected to.
///
/// The state is checked here rather than by the caller, because a caller that
/// forgets is indistinguishable from one that succeeded.
pub fn read_callback(url: &str, expected_state: &str) -> Result<String> {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        let v = percent_decode(v);
        match k {
            "code" => code = Some(v),
            "state" => state = Some(v),
            "error" => error = Some(v),
            _ => {}
        }
    }
    if let Some(error) = error {
        return Err(anyhow!("the sign-in was refused: {error}"));
    }
    if state.as_deref() != Some(expected_state) {
        return Err(anyhow!(
            "the callback belongs to a different sign-in attempt"
        ));
    }
    code.ok_or_else(|| anyhow!("the callback carried no code"))
}

/// Trade the browser code for a token. Form-encoded, like the device exchange.
pub fn browser_exchange_request(code: &str, verifier: &str) -> (String, Vec<(String, String)>) {
    (
        TOKEN_URL.to_string(),
        vec![
            ("grant_type".into(), "authorization_code".into()),
            ("client_id".into(), CLIENT_ID.into()),
            ("code".into(), code.to_string()),
            ("code_verifier".into(), verifier.to_string()),
            ("redirect_uri".into(), REDIRECT_URI.into()),
        ],
    )
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

fn base64_url_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for i in 0..chunk.len() + 1 {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
        }
    }
    out
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(b) => {
                    out.push(b);
                    i += 3;
                }
                Err(_) => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The request that starts a login.
pub fn device_authorize_request() -> (String, Value) {
    (
        DEVICE_USERCODE_URL.to_string(),
        json!({ "client_id": CLIENT_ID }),
    )
}

/// Read the answer to that request.
pub fn parse_device_authorize(body: &str) -> Result<DeviceLogin> {
    let json: Value = serde_json::from_str(body).context("device authorisation response")?;
    let device_auth_id = string_field(&json, "device_auth_id")?;
    let user_code = string_field(&json, "user_code")?;

    // Upstream accepts the interval as a number or a string, because it has
    // been seen as both. Anything unusable falls back to the floor rather than
    // failing the login over a polling hint.
    let interval = match json.get("interval") {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    let interval_secs = interval
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n as u64)
        .unwrap_or(MIN_POLL_INTERVAL_SECS)
        .max(MIN_POLL_INTERVAL_SECS);

    Ok(DeviceLogin {
        device_auth_id,
        user_code,
        verification_uri: DEVICE_VERIFICATION_URI.to_string(),
        interval_secs,
        expires_in_secs: DEVICE_CODE_TIMEOUT_SECS,
    })
}

/// The request made repeatedly while waiting for the user.
pub fn device_token_request(device_auth_id: &str, user_code: &str) -> (String, Value) {
    (
        DEVICE_TOKEN_URL.to_string(),
        json!({
            "device_auth_id": device_auth_id,
            "user_code": user_code,
        }),
    )
}

/// What a finished poll hands back. Not a token: this flow yields an
/// authorisation code, and the code_verifier that goes with it, which
/// `exchange_request` then trades for one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceGrant {
    pub authorization_code: String,
    pub code_verifier: String,
}

/// The last step: trade the authorisation code for a token.
///
/// Form-encoded rather than JSON, and against `/oauth/token` rather than the
/// device endpoints — the two halves of this flow do not share a convention.
pub fn exchange_request(grant: &DeviceGrant) -> (String, Vec<(String, String)>) {
    (
        TOKEN_URL.to_string(),
        vec![
            ("grant_type".into(), "authorization_code".into()),
            ("client_id".into(), CLIENT_ID.into()),
            ("code".into(), grant.authorization_code.clone()),
            ("code_verifier".into(), grant.code_verifier.clone()),
            ("redirect_uri".into(), DEVICE_REDIRECT_URI.into()),
        ],
    )
}

/// The request that trades a refresh token for a fresh one.
pub fn refresh_request(refresh_token: &str) -> (String, Vec<(String, String)>) {
    (
        TOKEN_URL.to_string(),
        vec![
            ("grant_type".into(), "refresh_token".into()),
            ("client_id".into(), CLIENT_ID.into()),
            ("refresh_token".into(), refresh_token.to_string()),
        ],
    )
}

/// What one poll of the token endpoint meant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Poll {
    /// The user finished. What comes back still has to be exchanged.
    Ready(DeviceGrant),
    /// The user has not finished yet. Keep waiting.
    Pending,
    /// The server asked for a slower poll.
    SlowDown,
    /// Over, and not successfully.
    Failed(String),
}

/// Interpret a poll response.
///
/// `status` matters as much as the body. 403 and 404 mean "not yet" here, not
/// "forbidden" and "gone" — upstream has a test for exactly this, and reading
/// them literally would abandon a login the moment before it succeeded.
pub fn interpret_poll(status: u16, body: &str) -> Poll {
    if status == 200 {
        return match parse_device_grant(body) {
            Ok(grant) => Poll::Ready(grant),
            Err(e) => Poll::Failed(format!("the device response could not be read: {e}")),
        };
    }

    // The error may be a bare string or an object with a `code`. Upstream
    // reads both, and the pending case arrives in each form depending on
    // where in the flow the user is.
    let error = serde_json::from_str::<Value>(body).ok().and_then(|v| {
        v.get("error").and_then(|e| match e {
            Value::String(s) => Some(s.clone()),
            Value::Object(_) => e.get("code").and_then(Value::as_str).map(str::to_string),
            _ => None,
        })
    });

    match error.as_deref() {
        Some("deviceauth_authorization_pending") => Poll::Pending,
        Some("authorization_pending") => Poll::Pending,
        Some("slow_down") => Poll::SlowDown,
        Some("expired_token") => Poll::Failed("the login code expired before it was used".into()),
        Some("access_denied") => Poll::Failed("the login was declined".into()),
        _ if status == 403 || status == 404 => Poll::Pending,
        // The body goes into the message. A poll failure with no detail is
        // the kind of thing that gets reported as "login broken" with nothing
        // to act on; upstream had to add this too.
        _ => Poll::Failed(format!(
            "login failed with status {status}: {}",
            body.trim()
        )),
    }
}

/// Read a finished poll.
pub fn parse_device_grant(body: &str) -> Result<DeviceGrant> {
    let json: Value = serde_json::from_str(body).context("device token response")?;
    Ok(DeviceGrant {
        authorization_code: string_field(&json, "authorization_code")?,
        code_verifier: string_field(&json, "code_verifier")?,
    })
}

/// Read a token response, given when it was received.
pub fn parse_token(body: &str, received_at_ms: u64) -> Result<Token> {
    let json: Value = serde_json::from_str(body).context("token response")?;
    let access = string_field(&json, "access_token")?;
    let refresh = string_field(&json, "refresh_token")?;
    let expires_in = json
        .get("expires_in")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("token response has no expires_in"))?;
    Ok(Token {
        access,
        refresh,
        expires_at_ms: received_at_ms.saturating_add(expires_in.saturating_mul(1000)),
    })
}

/// A refreshed token, keeping the old refresh token when the server does not
/// send a new one.
///
/// Some servers rotate refresh tokens and some do not. Overwriting with an
/// absent value would sign the user out at the next refresh, and the failure
/// would arrive an hour later with nothing pointing back here.
pub fn apply_refresh(previous: &Token, body: &str, received_at_ms: u64) -> Result<Token> {
    let json: Value = serde_json::from_str(body).context("refresh response")?;
    let access = string_field(&json, "access_token")?;
    let refresh = json
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| previous.refresh.clone());
    let expires_in = json
        .get("expires_in")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("refresh response has no expires_in"))?;
    Ok(Token {
        access,
        refresh,
        expires_at_ms: received_at_ms.saturating_add(expires_in.saturating_mul(1000)),
    })
}

/// The ChatGPT account an access token belongs to, if it says.
///
/// The claim rides in the JWT payload. Read without verifying the signature on
/// purpose: this is used to tell one account's cached state from another's, not
/// to decide whether to trust anything. The server verifies the token.
pub fn account_id(access_token: &str) -> Option<String> {
    let payload = access_token.split('.').nth(1)?;
    let decoded = base64_url_decode(payload)?;
    let json: Value = serde_json::from_slice(&decoded).ok()?;
    json.get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::to_string)
}

fn base64_url_decode(input: &str) -> Option<Vec<u8>> {
    // JWT segments are base64url without padding.
    let mut s = input.replace('-', "+").replace('_', "/");
    while !s.len().is_multiple_of(4) {
        s.push('=');
    }
    data_encoding::BASE64.decode(s.as_bytes()).ok()
}

fn string_field(json: &Value, key: &str) -> Result<String> {
    json.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("response has no {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_matches_the_published_rfc_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn the_authorisation_url_carries_every_parameter_upstream_sends() {
        let login = browser_login("verifier", "state-123", "tabverse");
        assert!(login
            .url
            .starts_with("https://auth.openai.com/oauth/authorize?"));
        for expected in [
            "response_type=code",
            "client_id=app_EMoamEEZ73f0CkXaXp7hrann",
            // Encoded, and the server compares the decoded value to what the
            // exchange later sends — the two have to be the same string.
            "redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
            "scope=openid%20profile%20email%20offline_access",
            "code_challenge_method=S256",
            "state=state-123",
            "id_token_add_organizations=true",
            "codex_cli_simplified_flow=true",
            "originator=tabverse",
        ] {
            assert!(
                login.url.contains(expected),
                "missing {expected} in {}",
                login.url
            );
        }
        assert!(
            login
                .url
                .contains(&format!("code_challenge={}", pkce_challenge("verifier"))),
            "the challenge in the url is not the one the verifier produces"
        );
    }

    #[test]
    fn a_callback_for_a_different_attempt_is_refused_even_though_it_has_a_code() {
        // The case that makes state worth having: a well-formed callback,
        // carrying a usable-looking code, that belongs to somebody else.
        let err = read_callback(
            "http://localhost:1455/auth/callback?code=abc&state=someone-else",
            "mine",
        )
        .unwrap_err();
        assert!(err.to_string().contains("different sign-in"), "got {err}");
    }

    #[test]
    fn a_callback_is_read_for_its_code_and_a_refusal_for_its_reason() {
        assert_eq!(
            read_callback("http://x/cb?code=the-code&state=s", "s").unwrap(),
            "the-code"
        );
        let err = read_callback("http://x/cb?error=access_denied&state=s", "s").unwrap_err();
        assert!(err.to_string().contains("access_denied"), "got {err}");
        let err = read_callback("http://x/cb?state=s", "s").unwrap_err();
        assert!(err.to_string().contains("no code"), "got {err}");
    }

    #[test]
    fn the_browser_exchange_returns_the_same_redirect_it_asked_with() {
        // Mismatched redirect_uri between authorise and exchange is the
        // classic silent OAuth failure: everything looks right until the very
        // last call, which answers 400 with nothing useful.
        let login = browser_login("v", "s", "tabverse");
        let (_, form) = browser_exchange_request("c", &login.verifier);
        let redirect = form
            .iter()
            .find(|(k, _)| k == "redirect_uri")
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_eq!(redirect, REDIRECT_URI);
        assert!(login.url.contains(&percent_encode(REDIRECT_URI)));
    }

    #[test]
    fn the_login_request_carries_only_the_public_client_id() {
        let (url, body) = device_authorize_request();
        // OpenAI's own endpoint, not RFC 8628's. The standard path is the one
        // this file used to name, and it answers 404 — which is why this
        // assertion carries the literal rather than the constant it came from.
        assert_eq!(
            url,
            "https://auth.openai.com/api/accounts/deviceauth/usercode"
        );
        assert_eq!(body, json!({ "client_id": CLIENT_ID }));
    }

    #[test]
    fn a_device_response_yields_what_the_user_must_do() {
        let login = parse_device_authorize(
            r#"{"device_auth_id":"dai","user_code":"ABCD-EFGH","interval":5}"#,
        )
        .unwrap();
        assert_eq!(login.device_auth_id, "dai");
        assert_eq!(login.user_code, "ABCD-EFGH");
        // Not from the response — this flow does not send one.
        assert_eq!(
            login.verification_uri,
            "https://auth.openai.com/codex/device"
        );
        assert_eq!(login.interval_secs, 5);
        assert_eq!(login.expires_in_secs, DEVICE_CODE_TIMEOUT_SECS);
    }

    #[test]
    fn an_interval_arriving_as_a_string_is_still_an_interval() {
        // Upstream accepts both because it has seen both.
        let login =
            parse_device_authorize(r#"{"device_auth_id":"d","user_code":"u","interval":"7"}"#)
                .unwrap();
        assert_eq!(login.interval_secs, 7);
    }

    #[test]
    fn a_nonsense_interval_falls_back_instead_of_failing_the_login() {
        for hint in ["\"abc\"", "-3", "null", "{}"] {
            let body = format!(r#"{{"device_auth_id":"d","user_code":"u","interval":{hint}}}"#);
            let login = parse_device_authorize(&body).unwrap();
            assert_eq!(login.interval_secs, MIN_POLL_INTERVAL_SECS, "hint {hint}");
        }
    }

    #[test]
    fn zero_does_not_become_a_busy_loop() {
        let login =
            parse_device_authorize(r#"{"device_auth_id":"d","user_code":"u","interval":0}"#)
                .unwrap();
        assert_eq!(login.interval_secs, MIN_POLL_INTERVAL_SECS);
    }

    #[test]
    fn a_response_missing_the_device_id_is_an_error_naming_the_field() {
        let err = parse_device_authorize(r#"{"user_code":"u"}"#).unwrap_err();
        assert!(err.to_string().contains("device_auth_id"), "got {err}");
    }

    #[test]
    fn forbidden_and_not_found_mean_not_yet() {
        // The rule that would be got wrong by reading the status literally, and
        // the one upstream has a test for: abandoning the login here would
        // happen the moment before it succeeded.
        assert_eq!(interpret_poll(403, "{}"), Poll::Pending);
        assert_eq!(interpret_poll(404, ""), Poll::Pending);
    }

    #[test]
    fn the_standard_pending_and_slow_down_errors_are_understood() {
        assert_eq!(
            interpret_poll(400, r#"{"error":"authorization_pending"}"#),
            Poll::Pending
        );
        assert_eq!(
            interpret_poll(429, r#"{"error":"slow_down"}"#),
            Poll::SlowDown
        );
    }

    #[test]
    fn an_expired_or_declined_login_ends_rather_than_polling_on() {
        assert!(matches!(
            interpret_poll(400, r#"{"error":"expired_token"}"#),
            Poll::Failed(m) if m.contains("expired")
        ));
        assert!(matches!(
            interpret_poll(400, r#"{"error":"access_denied"}"#),
            Poll::Failed(m) if m.contains("declined")
        ));
    }

    #[test]
    fn an_unexplained_failure_carries_the_body_so_it_can_be_acted_on() {
        // "Login broken" with no detail is not something anybody can debug.
        match interpret_poll(500, "upstream exploded") {
            Poll::Failed(message) => {
                assert!(message.contains("500"), "got {message}");
                assert!(message.contains("upstream exploded"), "got {message}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_successful_poll_yields_an_authorisation_code_not_a_token() {
        // The step that makes this flow longer than the standard one. Reading
        // a token out of here would have looked right and never worked.
        let poll = interpret_poll(200, r#"{"authorization_code":"ac","code_verifier":"cv"}"#);
        match poll {
            Poll::Ready(grant) => {
                assert_eq!(grant.authorization_code, "ac");
                assert_eq!(grant.code_verifier, "cv");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_two_hundred_that_is_not_a_grant_is_a_failure_not_a_success() {
        assert!(matches!(
            interpret_poll(200, r#"{"authorization_code":"ac"}"#),
            Poll::Failed(m) if m.contains("could not be read")
        ));
    }

    #[test]
    fn the_pending_error_this_server_actually_sends_is_understood() {
        // Nested under `error.code`, and named for the device flow rather than
        // the standard `authorization_pending`. Reading only the standard name
        // would turn every ordinary wait into an abandoned login.
        assert_eq!(
            interpret_poll(
                400,
                r#"{"error":{"code":"deviceauth_authorization_pending"}}"#
            ),
            Poll::Pending
        );
        assert_eq!(
            interpret_poll(400, r#"{"error":{"code":"slow_down"}}"#),
            Poll::SlowDown
        );
    }

    #[test]
    fn the_exchange_sends_the_verifier_the_server_handed_back() {
        let grant = DeviceGrant {
            authorization_code: "ac".into(),
            code_verifier: "cv".into(),
        };
        let (url, form) = exchange_request(&grant);
        assert_eq!(url, "https://auth.openai.com/oauth/token");
        let field = |k: &str| {
            form.iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        assert_eq!(field("grant_type"), "authorization_code");
        assert_eq!(field("code"), "ac");
        assert_eq!(field("code_verifier"), "cv");
        assert_eq!(field("client_id"), CLIENT_ID);
        // Nothing listens on it; the server still requires it to match.
        assert_eq!(
            field("redirect_uri"),
            "https://auth.openai.com/deviceauth/callback"
        );
    }

    #[test]
    fn expiry_is_measured_from_when_the_answer_arrived() {
        let token = parse_token(
            r#"{"access_token":"a","refresh_token":"r","expires_in":60}"#,
            1_000_000,
        )
        .unwrap();
        assert_eq!(token.expires_at_ms, 1_060_000);
    }

    #[test]
    fn a_token_is_refreshed_before_it_expires_not_after() {
        // A token that expires during the request it is authorising fails in a
        // way that reads as a permissions problem rather than a timing one.
        let token = Token {
            access: "a".into(),
            refresh: "r".into(),
            expires_at_ms: 100_000,
        };
        assert!(!token.needs_refresh(0, 60));
        assert!(token.needs_refresh(50_000, 60), "within the margin");
        assert!(token.needs_refresh(100_000, 0), "exactly at expiry counts");
    }

    #[test]
    fn a_refresh_that_returns_no_new_refresh_token_keeps_the_old_one() {
        // Some servers rotate them and some do not. Overwriting with nothing
        // signs the user out at the next refresh, an hour later, with nothing
        // pointing back at the cause.
        let previous = Token {
            access: "old".into(),
            refresh: "keep-me".into(),
            expires_at_ms: 0,
        };
        let refreshed = apply_refresh(
            &previous,
            r#"{"access_token":"new","expires_in":3600}"#,
            5_000,
        )
        .unwrap();
        assert_eq!(refreshed.access, "new");
        assert_eq!(refreshed.refresh, "keep-me");
        assert_eq!(refreshed.expires_at_ms, 3_605_000);
    }

    #[test]
    fn a_rotated_refresh_token_replaces_the_old_one() {
        let previous = Token {
            access: "old".into(),
            refresh: "old-refresh".into(),
            expires_at_ms: 0,
        };
        let refreshed = apply_refresh(
            &previous,
            r#"{"access_token":"new","refresh_token":"new-refresh","expires_in":10}"#,
            0,
        )
        .unwrap();
        assert_eq!(refreshed.refresh, "new-refresh");
    }

    #[test]
    fn the_refresh_request_names_the_grant_it_is_using() {
        let (url, form) = refresh_request("rt");
        assert_eq!(url, "https://auth.openai.com/oauth/token");
        // Form-encoded, like the exchange and unlike the device endpoints.
        assert!(form.contains(&("grant_type".to_string(), "refresh_token".to_string())));
        assert!(form.contains(&("refresh_token".to_string(), "rt".to_string())));
        assert!(form.contains(&("client_id".to_string(), CLIENT_ID.to_string())));
    }

    #[test]
    fn the_poll_request_carries_both_halves_of_the_device_identity() {
        let (url, body) = device_token_request("dai", "ABCD");
        assert_eq!(url, "https://auth.openai.com/api/accounts/deviceauth/token");
        // Both, not just the id: this endpoint rejects the id on its own.
        assert_eq!(body["device_auth_id"], json!("dai"));
        assert_eq!(body["user_code"], json!("ABCD"));
    }

    #[test]
    fn the_account_is_read_out_of_the_token_without_trusting_it() {
        // Used to keep one account's cached state apart from another's, never
        // to decide whether to trust anything — the server does that.
        let payload = serde_json::to_vec(&json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acc_test" }
        }))
        .unwrap();
        let encoded = data_encoding::BASE64URL_NOPAD.encode(&payload);
        assert_eq!(
            account_id(&format!("aaa.{encoded}.bbb")).as_deref(),
            Some("acc_test")
        );
    }

    #[test]
    fn a_token_that_says_nothing_about_an_account_is_not_an_error() {
        assert_eq!(account_id("not.a.jwt"), None);
        assert_eq!(account_id(""), None);
        assert_eq!(account_id("only-one-segment"), None);
    }
}
