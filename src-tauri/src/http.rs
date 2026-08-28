use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::config::DnsMode;

// ------------------------------------------------------------- the defaults

/// How long a whole exchange may take when the call site has no opinion of
/// its own.
///
/// An answer that has not arrived in ten seconds is not arriving: everything
/// built with this default is fetching something small from a server that
/// either has it or does not.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for the connection itself.
///
/// Separate from any limit on the body, which is the distinction the agent's
/// streamed answer depends on: a model that thinks for two minutes is
/// working, whereas a server that has not accepted a connection in thirty
/// seconds is not going to.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// What one call site needs that is different from every other.
///
/// Deliberately three fields and not a list of purposes. A purpose enum would
/// put the agent's "no total deadline" in this file, away from the comment
/// that explains why, and the next call site would have to come here to be
/// named at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spec {
    /// The whole exchange's deadline. `None` means none — see
    /// `agent_http::ReqwestTransport` for the one case where that is the
    /// point rather than an oversight.
    pub timeout: Option<Duration>,
    /// The connection's own deadline.
    pub connect_timeout: Option<Duration>,
    /// The user agent to send, or `None` for reqwest's own.
    pub user_agent: Option<&'static str>,
}

impl Default for Spec {
    fn default() -> Self {
        Self {
            timeout: Some(DEFAULT_TIMEOUT),
            connect_timeout: Some(DEFAULT_CONNECT_TIMEOUT),
            user_agent: None,
        }
    }
}

// ------------------------------------------------------------ the DNS policy

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsPolicy {
    /// Whatever the operating system is configured to do. The default, and
    /// deliberately so: changing the path a name resolution takes has
    /// security consequences, and is not something to switch on for somebody.
    System,
    /// DNS over HTTPS at this endpoint (RFC 8484).
    Doh(String),
}

impl DnsPolicy {
    /// The policy the two `[network]` settings describe.
    ///
    /// `custom` is read only when the mode asks for it, so a stale address
    /// left in the file by somebody who has since gone back to Cloudflare
    /// governs nothing.
    pub fn from_settings(mode: DnsMode, custom: &str) -> Self {
        match mode.doh_url() {
            Some(url) => Self::Doh(url.to_string()),
            None if mode == DnsMode::Custom => {
                if custom.is_empty() {
                    // Said out loud rather than resolved-through-the-system
                    // in silence: the user picked "custom" and gave no
                    // address, and the honest report of that is a line
                    // naming both facts. The settings page says it on screen.
                    eprintln!(
                        "[dns] custom DNS is selected but no address is set — \
                         resolving through the system"
                    );
                    Self::System
                } else {
                    Self::Doh(custom.to_string())
                }
            }
            None => Self::System,
        }
    }
}

/// The policy in force, composed from the configuration file on first ask.
///
/// Cached rather than read per client, because two of the four call sites
/// build their client once for the process's life and the other two build one
/// per request — a file read per request is not a thing to do. [`forget`] is
/// what a write to `[network]` calls, so the next client built picks the new
/// policy up.
fn live() -> &'static Mutex<Option<DnsPolicy>> {
    static LIVE: OnceLock<Mutex<Option<DnsPolicy>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(None))
}

/// The DNS policy this program is currently resolving under.
pub fn policy() -> DnsPolicy {
    let mut slot = live().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = slot.as_ref() {
        return p.clone();
    }
    let composed = match crate::config::load() {
        Ok(loaded) => DnsPolicy::from_settings(
            loaded.config.network.dns_mode,
            &loaded.config.network.dns_custom_url,
        ),
        Err(e) => {
            eprintln!(
                "[dns] the configuration file did not load, resolving through the system: {e}"
            );
            DnsPolicy::System
        }
    };
    *slot = Some(composed.clone());
    composed
}

/// Drop the cached policy, so the next client built reads the file again.
///
/// Called after a write to a `[network]` key. Clients already built keep the
/// resolver they were built with — the two singletons therefore keep theirs
/// until the next launch, which the settings page states rather than hides.
pub fn forget() {
    *live().lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Put a policy in force directly, without a file. Tests only: everything the
/// product does goes through [`policy`], which reads the registry.
#[cfg(test)]
pub(crate) fn set_policy(p: DnsPolicy) {
    *live().lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
}

/// Whether a policy has been composed, and which. Tests only.
#[cfg(test)]
pub(crate) fn cached_policy() -> Option<DnsPolicy> {
    live().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(test)]
fn policy_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Take that lock, poisoned or not.
///
/// Spelled here rather than at each call site for one specific reason:
/// config.rs has a test forbidding the poison-recovery construction anywhere
/// in its own source, because that construction is also how a broken
/// configuration turns into the defaults without anyone being told. That test
/// greps text, so it cannot tell the two uses apart — and the right answer is
/// to keep the text out of that file, not to teach the test exceptions.
#[cfg(test)]
pub(crate) fn lock_policy_for_test() -> std::sync::MutexGuard<'static, ()> {
    policy_test_lock().lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------- the build

/// Install the process-wide rustls provider if nothing has yet — see the
/// module note for why a client build panics without one.
pub fn ensure_crypto_provider() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        // An `Err` only means somebody installed one first, which is exactly
        // what `run()` does and exactly what this must not undo.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// The builder every client starts from, minus the resolver.
///
/// Split out because the DoH resolver needs a client of its own to reach its
/// endpoint with, and that client must NOT resolve through the resolver it is
/// there to serve.
fn base(spec: Spec) -> reqwest::ClientBuilder {
    ensure_crypto_provider();
    let mut builder = reqwest::Client::builder();
    if let Some(t) = spec.timeout {
        builder = builder.timeout(t);
    }
    if let Some(t) = spec.connect_timeout {
        builder = builder.connect_timeout(t);
    }
    if let Some(ua) = spec.user_agent {
        builder = builder.user_agent(ua);
    }
    builder
}

/// Build a client under the policy in force. This is the only constructor
/// exposed to callers.
pub fn build(spec: Spec) -> reqwest::Result<reqwest::Client> {
    build_with(spec, policy())
}

/// Build a client under a named policy. The seam the DNS tests drive, and the
/// implementation [`build`] is one line of: the policy is an argument here so
/// that "which resolver did this client get" is answerable without a file.
pub fn build_with(spec: Spec, policy: DnsPolicy) -> reqwest::Result<reqwest::Client> {
    let builder = base(spec);
    match policy {
        DnsPolicy::System => builder.build(),
        DnsPolicy::Doh(url) => {
            let resolver = DohResolver::new(url)?;
            builder.dns_resolver(Arc::new(resolver)).build()
        }
    }
}

// ------------------------------------------------------------ DoH resolving

/// A resolver that asks one DNS-over-HTTPS endpoint (RFC 8484).
///
/// No cache, on purpose for now: a cache is a second answer to "what does
/// this name resolve to", with its own expiry rules and its own way of being
/// wrong, and the endpoints this talks to are one round trip away on a
/// connection reqwest keeps open. It is the thing to add when a measurement
/// asks for it, not before.
pub(crate) struct DohResolver {
    /// Reaches the endpoint. Built under [`DnsPolicy::System`] and that is
    /// load-bearing: `cloudflare-dns.com` has to be resolved by *something*,
    /// and it cannot be this. The endpoint's own name is therefore the one
    /// lookup this policy does not cover, which the settings page says.
    client: reqwest::Client,
    url: Arc<str>,
}

impl DohResolver {
    pub(crate) fn new(url: String) -> reqwest::Result<Self> {
        Ok(Self {
            client: base(Spec::default()).build()?,
            url: url.into(),
        })
    }

    /// One name, answered the way a `reqwest::Client` built under this
    /// resolver would get it — the same [`lookup`], with the same reading of
    /// an empty answer — exposed for the one caller in this program that
    /// connects its own sockets instead of going through a client: the page
    /// proxy (page_proxy.rs). This is the export that keeps resolution
    /// single-source; the proxy must not, and does not, own a resolver of
    /// its own.
    pub(crate) async fn lookup_host(&self, host: &str) -> Result<Vec<SocketAddr>, DnsError> {
        let addrs = lookup(&self.client, &self.url, host).await?;
        if addrs.is_empty() {
            return Err(format!("{} returned no address for {host}", self.url).into());
        }
        Ok(addrs)
    }
}

impl reqwest::dns::Resolve for DohResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let client = self.client.clone();
        let url = self.url.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = lookup(&client, &url, &host).await?;
            if addrs.is_empty() {
                return Err(format!("{url} returned no address for {host}").into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Record type for an IPv4 address.
const TYPE_A: u16 = 1;
/// Record type for an IPv6 address.
const TYPE_AAAA: u16 = 28;
/// The one class anything here asks about.
const CLASS_IN: u16 = 1;
/// RFC 8484's media type, sent and accepted.
const DNS_MESSAGE: &str = "application/dns-message";

/// The port every answer carries out of here.
///
/// Zero, and not 80 or 443: hyper replaces a zero port with the one the URL
/// asked for, or with the scheme's own when the URL named none (`set_port` in
/// hyper-util). A resolver that guessed would be overriding the address bar.
const PORT_UNDECIDED: u16 = 0;

/// What a lookup failure is. The trait's own error type, spelled out because
/// `reqwest::error::BoxError` is not public. Crate-visible because
/// [`DohResolver::lookup_host`] hands one to the page proxy.
pub(crate) type DnsError = Box<dyn std::error::Error + Send + Sync>;

/// Ask the endpoint for one name: IPv4, and IPv6 only if that came back with
/// nothing.
///
/// Sequential rather than concurrent, because the second query is usually not
/// made at all — an address-less-over-IPv4 host is the exception, and asking
/// for both every time would pay for the exception in the common case.
async fn lookup(
    client: &reqwest::Client,
    url: &str,
    host: &str,
) -> Result<Vec<SocketAddr>, DnsError> {
    let v4 = query(client, url, host, TYPE_A).await?;
    if !v4.is_empty() {
        return Ok(v4);
    }
    query(client, url, host, TYPE_AAAA).await
}

/// One question, asked as RFC 8484 §4.1 asks it: POST, wire format in the
/// body, wire format back.
///
/// POST and not the GET form, because GET carries the same message
/// base64url-encoded in the query string — a second encoding to get wrong,
/// bought for a caching property this has no cache to use.
async fn query(
    client: &reqwest::Client,
    url: &str,
    host: &str,
    qtype: u16,
) -> Result<Vec<SocketAddr>, DnsError> {
    let response = client
        .post(url)
        .header("content-type", DNS_MESSAGE)
        .header("accept", DNS_MESSAGE)
        .body(encode_query(host, qtype)?)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url} answered {status} for {host}").into());
    }
    decode_addresses(&response.bytes().await?)
}

/// One question as a DNS message.
fn encode_query(host: &str, qtype: u16) -> Result<Vec<u8>, DnsError> {
    let name = host.trim_end_matches('.');
    if name.is_empty() {
        return Err("cannot look up the empty name".into());
    }
    let mut out: Vec<u8> = Vec::with_capacity(name.len() + 18);
    // Identifier zero, which RFC 8484 §4.1 asks for: over HTTP the request
    // and its answer are already paired, and a varying id would only make two
    // identical questions two different bodies.
    out.extend_from_slice(&0u16.to_be_bytes());
    // Recursion desired, everything else clear. The endpoint is a resolver,
    // not an authority; without this it would answer with a referral.
    out.extend_from_slice(&0x0100u16.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes()); // one question
    out.extend_from_slice(&0u16.to_be_bytes()); // no answers
    out.extend_from_slice(&0u16.to_be_bytes()); // no authority records
    out.extend_from_slice(&0u16.to_be_bytes()); // no additional records
    for label in name.split('.') {
        if label.is_empty() {
            return Err(format!("`{host}` has an empty label").into());
        }
        if label.len() > 63 {
            return Err(format!("`{host}` has a label longer than 63 bytes").into());
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0); // the root label ends the name
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&CLASS_IN.to_be_bytes());
    Ok(out)
}

/// Every address an answer section carries, in the order it carries them.
///
/// Records that are not addresses — a CNAME chain, most often — are stepped
/// over rather than refused: a resolver answers the alias and the address it
/// leads to in one message, and the addresses are what a connection needs.
fn decode_addresses(msg: &[u8]) -> Result<Vec<SocketAddr>, DnsError> {
    if msg.len() < 12 {
        return Err("the answer is too short to be a DNS message".into());
    }
    let flags = u16::from_be_bytes([msg[2], msg[3]]);
    let rcode = flags & 0x000F;
    if rcode != 0 {
        return Err(format!("the resolver refused the question (RCODE {rcode})").into());
    }
    let questions = u16::from_be_bytes([msg[4], msg[5]]);
    let answers = u16::from_be_bytes([msg[6], msg[7]]);
    let mut pos = 12;
    for _ in 0..questions {
        pos = skip_name(msg, pos)?;
        pos = step(msg, pos, 4)?; // the question's type and class
    }
    let mut out = Vec::new();
    for _ in 0..answers {
        pos = skip_name(msg, pos)?;
        let head = step(msg, pos, 10)?;
        let rtype = u16::from_be_bytes([msg[pos], msg[pos + 1]]);
        let rdlength = u16::from_be_bytes([msg[pos + 8], msg[pos + 9]]) as usize;
        let end = step(msg, head, rdlength)?;
        let rdata = &msg[head..end];
        match (rtype, rdata.len()) {
            (TYPE_A, 4) => {
                let octets: [u8; 4] = rdata.try_into().expect("four bytes");
                out.push(SocketAddr::from((
                    std::net::Ipv4Addr::from(octets),
                    PORT_UNDECIDED,
                )));
            }
            (TYPE_AAAA, 16) => {
                let octets: [u8; 16] = rdata.try_into().expect("sixteen bytes");
                out.push(SocketAddr::from((
                    std::net::Ipv6Addr::from(octets),
                    PORT_UNDECIDED,
                )));
            }
            _ => {}
        }
        pos = end;
    }
    Ok(out)
}

/// `pos` advanced by `n`, or a refusal when that would leave the message.
fn step(msg: &[u8], pos: usize, n: usize) -> Result<usize, DnsError> {
    match pos.checked_add(n) {
        Some(next) if next <= msg.len() => Ok(next),
        _ => Err("a DNS record runs past the end of the message".into()),
    }
}

/// The offset just past a name, following the length-prefixed labels.
///
/// A compression pointer is not followed — this only ever needs to know where
/// the name STOPS, and a pointer is the last two bytes of the name it appears
/// in (RFC 1035 §4.1.4). Not following it is also what makes this immune to
/// the pointer loop a malicious answer would otherwise spin it in.
fn skip_name(msg: &[u8], mut pos: usize) -> Result<usize, DnsError> {
    loop {
        let len = match msg.get(pos) {
            Some(b) => *b,
            None => return Err("a name runs past the end of the message".into()),
        };
        if len & 0xC0 == 0xC0 {
            return step(msg, pos, 2);
        }
        if len & 0xC0 != 0 {
            return Err("a name label has reserved bits set".into());
        }
        pos = step(msg, pos, 1)?;
        if len == 0 {
            return Ok(pos);
        }
        pos = step(msg, pos, len as usize)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};

    fn rust_sources(root: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(root).expect("read Rust source tree") {
            let path = entry.expect("read source entry").path();
            if path.is_dir() {
                rust_sources(&path, out);
            } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn every_reqwest_client_is_built_by_this_module() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root");
        let factory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/http.rs")
            .canonicalize()
            .expect("canonical factory path");
        let mut sources = Vec::new();
        rust_sources(&workspace.join("src-tauri/src"), &mut sources);
        rust_sources(&workspace.join("crates"), &mut sources);

        let qualified = [
            ["reqwest::Client", "::builder("].concat(),
            ["reqwest::Client", "::new("].concat(),
            ["reqwest::ClientBuilder", "::new("].concat(),
            ["reqwest::ClientBuilder", "::default("].concat(),
        ];
        let imported = [
            ["Client", "::builder("].concat(),
            ["Client", "::new("].concat(),
            ["ClientBuilder", "::new("].concat(),
            ["ClientBuilder", "::default("].concat(),
        ];
        let mut violations = Vec::new();
        for path in sources {
            if path.canonicalize().expect("canonical source path") == factory {
                continue;
            }
            let source = fs::read_to_string(&path).expect("read Rust source");
            let imports_reqwest_client = source.lines().any(|line| {
                let code = line.split("//").next().unwrap_or_default();
                code.contains("use reqwest::Client")
                    || (code.contains("use reqwest::{")
                        && (code.contains("Client,") || code.contains("ClientBuilder")))
            });
            for (line_no, line) in source.lines().enumerate() {
                let code = line.split("//").next().unwrap_or_default();
                let found = qualified.iter().any(|needle| code.contains(needle))
                    || (imports_reqwest_client
                        && imported.iter().any(|needle| code.contains(needle)));
                if found {
                    violations.push(format!(
                        "{}:{}",
                        path.strip_prefix(workspace).unwrap_or(&path).display(),
                        line_no + 1
                    ));
                }
            }
        }
        assert!(
            violations.is_empty(),
            "HTTP clients bypass the shared factory: {}",
            violations.join(", ")
        );
    }

    /// A name reserved by RFC 6761 §6.2 precisely so that it resolves
    /// nowhere. Using it is what makes the control below mean something: with
    /// the system resolver there is no answer to be had, so a fetch that
    /// succeeds can only have gone through the stub.
    const PROBE_HOST: &str = "tabverse-doh-probe.test";

    // ------------------------------------------------------------- stubs
    //
    // Both listeners run on 127.0.0.1 and neither leaves this machine. Their
    // accept loops are not joined: a thread parked in `accept` cannot be
    // joined without closing the listener it is parked on, and the test
    // binary's exit is what ends them. Nothing is asserted about their
    // shutdown, so nothing is being papered over.

    /// One request off a socket: the head, and a body of `Content-Length`.
    fn read_request(stream: &mut TcpStream) -> (String, Vec<u8>) {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        while !buf.ends_with(b"\r\n\r\n") {
            match stream.read(&mut byte) {
                Ok(0) | Err(_) => return (String::from_utf8_lossy(&buf).into_owned(), Vec::new()),
                Ok(_) => buf.push(byte[0]),
            }
        }
        let head = String::from_utf8_lossy(&buf).into_owned();
        let length = head
            .lines()
            .find_map(|l| {
                let (name, value) = l.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())?
            })
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        if length > 0 && stream.read_exact(&mut body).is_err() {
            body.clear();
        }
        (head, body)
    }

    /// The question a DNS query carries, read with a parser of this test's
    /// own.
    ///
    /// Deliberately not `skip_name`: a stub that decoded the request with the
    /// code under test would agree with it about a malformed message, and the
    /// point of the stub is to be an independent witness of what arrived.
    /// Returns the name and the offset just past the question.
    fn question_of(msg: &[u8]) -> (String, usize) {
        let mut pos = 12;
        let mut labels: Vec<String> = Vec::new();
        while pos < msg.len() {
            let len = msg[pos] as usize;
            pos += 1;
            if len == 0 {
                break;
            }
            labels.push(String::from_utf8_lossy(&msg[pos..pos + len]).into_owned());
            pos += len;
        }
        (labels.join("."), pos + 4)
    }

    /// A DNS-over-HTTPS endpoint on loopback that answers every question with
    /// 127.0.0.1, and records what it was asked.
    struct DohStub {
        url: String,
        asked: Arc<Mutex<Vec<String>>>,
    }

    fn doh_stub() -> DohStub {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the stub");
        let port = listener.local_addr().unwrap().port();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&asked);
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(mut stream) = incoming else { continue };
                let (_head, body) = read_request(&mut stream);
                if body.len() < 12 {
                    continue;
                }
                let (name, question_end) = question_of(&body);
                recorded.lock().unwrap().push(name);

                let mut answer: Vec<u8> = Vec::new();
                answer.extend_from_slice(&body[0..2]); // the id it asked with
                answer.extend_from_slice(&0x8180u16.to_be_bytes()); // reply, recursion done
                answer.extend_from_slice(&1u16.to_be_bytes()); // one question
                answer.extend_from_slice(&1u16.to_be_bytes()); // one answer
                answer.extend_from_slice(&0u16.to_be_bytes());
                answer.extend_from_slice(&0u16.to_be_bytes());
                answer.extend_from_slice(&body[12..question_end]); // echoed
                                                                   // The name, as a compression pointer back to the question —
                                                                   // which is how a real resolver writes it, and therefore the
                                                                   // shape `skip_name` has to survive.
                answer.extend_from_slice(&[0xC0, 0x0C]);
                answer.extend_from_slice(&1u16.to_be_bytes()); // A
                answer.extend_from_slice(&1u16.to_be_bytes()); // IN
                answer.extend_from_slice(&60u32.to_be_bytes()); // ttl
                answer.extend_from_slice(&4u16.to_be_bytes()); // rdlength
                answer.extend_from_slice(&[127, 0, 0, 1]);

                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: {DNS_MESSAGE}\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n",
                    answer.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&answer);
                let _ = stream.flush();
            }
        });
        DohStub {
            url: format!("http://127.0.0.1:{port}/dns-query"),
            asked,
        }
    }

    /// What the probe fetch is actually fetching: a page on loopback, so that
    /// "the resolution was used" is visible as a body and not only as a log.
    fn page_server(body: &'static str, hold: Duration) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the page");
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(mut stream) = incoming else { continue };
                let _ = read_request(&mut stream);
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.flush();
                // Held between the head and the body, which is what tells a
                // whole-exchange deadline apart from a connect one.
                std::thread::sleep(hold);
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
            }
        });
        port
    }

    fn fetch(client: &reqwest::Client, url: String) -> Result<String, String> {
        tauri::async_runtime::block_on(async move {
            let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
            response.text().await.map_err(|e| e.to_string())
        })
    }

    // ------------------------------------------- the policy reaches the wire

    #[test]
    fn a_configured_endpoint_receives_the_lookups_and_its_answer_is_used() {
        let stub = doh_stub();
        let page = page_server("through the stub", Duration::ZERO);

        // Through the file, not through a constructor: the TOML is parsed by
        // the loader, validated by the registry's own rules, and composed
        // into a policy by the same function the running program uses.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            format!(
                "[network]\ndns_mode = \"custom\"\ndns_custom_url = \"{}\"\n",
                stub.url
            ),
        )
        .expect("write the configuration");
        let loaded = crate::config::load_from_paths(&[path]).expect("the file loads");
        let policy = DnsPolicy::from_settings(
            loaded.config.network.dns_mode,
            &loaded.config.network.dns_custom_url,
        );
        assert_eq!(policy, DnsPolicy::Doh(stub.url.clone()));

        let client = build_with(Spec::default(), policy).expect("a client");
        let outcome = fetch(&client, format!("http://{PROBE_HOST}:{page}/"));

        // The criterion's own sentence first: the lookup ARRIVED at the
        // endpoint the configuration named. Asserted before the fetch's
        // outcome so that a factory ignoring the policy fails here — on the
        // resolution path — rather than further downstream on a fetch that
        // could have failed for a dozen other reasons.
        let asked = stub.asked.lock().unwrap().clone();
        assert_eq!(
            asked,
            vec![PROBE_HOST.to_string()],
            "the configured endpoint was not asked to resolve the name"
        );
        // And the second half: the answer was USED. Without this the test
        // would pass on a client that asks the endpoint and then resolves
        // some other way.
        assert_eq!(
            outcome.as_deref(),
            Ok("through the stub"),
            "the address the endpoint answered with was not the one connected to"
        );
    }

    /// The control, and the half that makes the test above discriminating:
    /// under the default policy the endpoint hears nothing at all.
    #[test]
    fn the_system_policy_never_asks_the_endpoint() {
        let stub = doh_stub();
        let page = page_server("never reached", Duration::ZERO);

        let client = build_with(Spec::default(), DnsPolicy::System).expect("a client");
        let outcome = fetch(&client, format!("http://{PROBE_HOST}:{page}/"));

        assert!(
            stub.asked.lock().unwrap().is_empty(),
            "the system resolver must not route lookups through a DoH endpoint, \
             yet it asked for {:?}",
            stub.asked.lock().unwrap()
        );
        // A reserved name has no answer anywhere, so this is a failure to
        // resolve — reported rather than asserted on its wording, which is
        // hyper's and not ours.
        assert!(
            outcome.is_err(),
            "a reserved name resolved through the system: {outcome:?}"
        );
    }

    /// [`build`] — the entry the product calls, which takes no policy — reads
    /// the one in force. Without this the test above would only prove that
    /// `build_with` works when handed a policy by a test.
    #[test]
    fn build_reads_the_policy_in_force() {
        let _serialized = lock_policy_for_test();
        let stub = doh_stub();
        let page = page_server("through the live policy", Duration::ZERO);

        set_policy(DnsPolicy::Doh(stub.url.clone()));
        let client = build(Spec::default()).expect("a client");
        let outcome = fetch(&client, format!("http://{PROBE_HOST}:{page}/"));
        // Put back, so a later test in this process composes from the file.
        forget();

        assert_eq!(
            stub.asked.lock().unwrap().len(),
            1,
            "`build` did not resolve through the policy in force"
        );
        assert_eq!(outcome.as_deref(), Ok("through the live policy"));
    }

    // -------------------------------------------- the call sites keep theirs

    /// The whole-exchange deadline is a knob the factory really turns, and
    /// `None` really means none — which is the property `agent_http`'s
    /// streamed answer depends on.
    #[test]
    fn a_total_deadline_cuts_a_slow_answer_off_and_no_deadline_does_not() {
        let page = page_server("slow but complete", Duration::from_millis(700));

        let impatient = build_with(
            Spec {
                timeout: Some(Duration::from_millis(200)),
                ..Spec::default()
            },
            DnsPolicy::System,
        )
        .expect("a client");
        let patient = build_with(
            Spec {
                timeout: None,
                ..Spec::default()
            },
            DnsPolicy::System,
        )
        .expect("a client");

        assert!(
            fetch(&impatient, format!("http://127.0.0.1:{page}/")).is_err(),
            "a 200ms deadline should not survive a 700ms answer"
        );
        assert_eq!(
            fetch(&patient, format!("http://127.0.0.1:{page}/")).as_deref(),
            Ok("slow but complete"),
            "a client built with no total deadline must wait for the answer"
        );
    }

    // ----------------------------------------------------- policy composition

    #[test]
    fn each_mode_names_the_endpoint_it_means() {
        assert_eq!(
            DnsPolicy::from_settings(DnsMode::System, ""),
            DnsPolicy::System
        );
        assert_eq!(
            DnsPolicy::from_settings(DnsMode::Cloudflare, "https://ignored/"),
            DnsPolicy::Doh("https://cloudflare-dns.com/dns-query".into()),
            "a built-in provider must not be overridden by a stale custom address"
        );
        assert_eq!(
            DnsPolicy::from_settings(DnsMode::Custom, "https://doh.example/dns-query"),
            DnsPolicy::Doh("https://doh.example/dns-query".into())
        );
        assert_eq!(
            DnsPolicy::from_settings(DnsMode::Custom, ""),
            DnsPolicy::System,
            "custom with nothing filled in is the system resolver, not a broken one"
        );
        // Every mode answers something: a token added to the enum and
        // forgotten here would be caught by this rather than by a user.
        for token in DnsMode::TOKENS {
            let mode = DnsMode::from_token(token).expect("a listed token parses");
            let policy = DnsPolicy::from_settings(mode, "https://filled.example/dns-query");
            assert!(
                matches!(policy, DnsPolicy::System | DnsPolicy::Doh(_)),
                "{token} composed into nothing"
            );
        }
    }

    // ------------------------------------------------------- the wire format

    #[test]
    fn a_query_is_the_message_a_resolver_expects() {
        let msg = encode_query("dns.example.com", TYPE_A).expect("a query");
        assert_eq!(&msg[0..2], &[0, 0], "RFC 8484 asks for identifier zero");
        assert_eq!(&msg[2..4], &[0x01, 0x00], "recursion desired, nothing else");
        assert_eq!(&msg[4..6], &[0, 1], "exactly one question");
        assert_eq!(
            &msg[6..12],
            &[0, 0, 0, 0, 0, 0],
            "no records of any other kind"
        );
        assert_eq!(
            &msg[12..],
            b"\x03dns\x07example\x03com\x00\x00\x01\x00\x01",
            "the name is length-prefixed labels, then type A and class IN"
        );
        assert_eq!(
            &encode_query("dns.example.com.", TYPE_AAAA).expect("a query")[12..],
            b"\x03dns\x07example\x03com\x00\x00\x1c\x00\x01",
            "a trailing root dot is the same name, and AAAA is 28"
        );
        assert!(encode_query("", TYPE_A).is_err());
        assert!(encode_query("a..b", TYPE_A).is_err());
    }

    #[test]
    fn an_answer_yields_its_addresses_and_leaves_the_port_undecided() {
        // Question for one.example, then a CNAME (stepped over) and an A.
        let mut msg: Vec<u8> = Vec::new();
        msg.extend_from_slice(&[0, 0, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0]);
        msg.extend_from_slice(b"\x03one\x07example\x00");
        msg.extend_from_slice(&[0, 1, 0, 1]);
        // CNAME, named by a compression pointer, whose rdata is a name.
        msg.extend_from_slice(&[0xC0, 0x0C, 0, 5, 0, 1, 0, 0, 0, 60, 0, 6]);
        msg.extend_from_slice(b"\x03two\x00\x00");
        // A, named the same way.
        msg.extend_from_slice(&[0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 7]);

        let addrs = decode_addresses(&msg).expect("the answer decodes");
        assert_eq!(addrs.len(), 1, "the CNAME is not an address: {addrs:?}");
        assert_eq!(addrs[0].ip().to_string(), "203.0.113.7");
        assert_eq!(
            addrs[0].port(),
            PORT_UNDECIDED,
            "the port belongs to the URL, and hyper fills it in"
        );
    }

    #[test]
    fn a_malformed_answer_is_refused_rather_than_read_past() {
        assert!(
            decode_addresses(&[0, 0, 0x81]).is_err(),
            "too short to be a message"
        );
        // RCODE 3 is NXDOMAIN, and an error is the honest reading of it.
        assert!(
            decode_addresses(&[0, 0, 0x81, 0x83, 0, 0, 0, 0, 0, 0, 0, 0]).is_err(),
            "a refusal must not read as an empty answer"
        );
        // One question claimed, and a name that runs off the end of it.
        assert!(
            decode_addresses(&[0, 0, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 9, b'a']).is_err(),
            "a label longer than the message must be refused"
        );
        // An answer claiming more rdata than the message holds.
        let mut over: Vec<u8> = vec![0, 0, 0x81, 0x80, 0, 0, 0, 1, 0, 0, 0, 0];
        over.extend_from_slice(&[0, 0, 1, 0, 1, 0, 0, 0, 60, 0xFF, 0xFF]);
        assert!(decode_addresses(&over).is_err(), "rdlength past the end");
    }
}
