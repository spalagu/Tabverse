use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use crate::page_proxy;
use base64::Engine as _;
/// The whole exchange one request may take — HEAD_DEADLINE's spirit
/// (page_proxy.rs), stretched over request and answer both: a viewer
/// waiting on an answer deserves it in half a minute or an error, never
/// a parked frame.
const REQ_DEADLINE: Duration = Duration::from_secs(30);

/// The most body one answer carries back. Past this the body is cut and
/// the cut is logged; the frames are for a page's intranet fetches, and
/// a mebibyte covers the documents those fetch.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// The body read buffer: transfer.rs's pump width — a loopback or
/// intranet answer moves in a handful of reads at this size.
const READ_BUFFER: usize = 8192;

/// The answer to a request that names nothing forwardable: a CONNECT, a
/// missing Host, a target that is not http.
const THE_UNAIMABLE: &str = "the request named no forwardable host";

/// What an expired deadline says, wherever it expired.
const DEADLINE_PASSED: &str = "the request outlived its deadline";

/// One request frame, executed on the host's network. The head is the
/// complete request head text (terminator optional); the answer is the
/// response head verbatim and the body as text, `None` when nothing
/// followed the head.
pub fn run(head: &str, body: Option<&str>) -> Result<(String, Option<String>), String> {
    exchange(head, body, REQ_DEADLINE)
}
fn exchange(
    head: &str,
    body: Option<&str>,
    budget: Duration,
) -> Result<(String, Option<String>), String> {
    let target = target_of(head).ok_or(THE_UNAIMABLE)?;
    if target.tls {
        return exchange_tls(head, body, budget, &target);
    }
    let addresses = page_proxy::resolve_system(&target.host, target.port)
        .ok_or_else(|| "the host resolved to no address".to_string())?;
    let deadline = Deadline(Instant::now() + budget);
    let mut stream = connect_within(&addresses, &deadline)
        .ok_or_else(|| "no address accepted the connection".to_string())?;

    let on_the_wire = forward_head(head, &target.authority, body);
    deadline.apply(&stream)?;
    stream.write_all(on_the_wire.as_bytes()).map_err(said)?;
    if let Some(body) = body {
        stream.write_all(body.as_bytes()).map_err(said)?;
    }

    deadline.apply(&stream)?;
    let answered = page_proxy::read_head(&mut stream).map_err(said)?;
    let body = read_body(&mut stream, &answered, &deadline)?;
    Ok((answered, body))
}

/// Where a request head is aimed: the authority as written (for the Host
/// header page_proxy's rewrite puts in) and the host/port split out of
/// it (for resolution). An absolute-form target says the authority
/// outright; an origin-form one says it in the Host header. `None` when
/// neither names one — CONNECT included, since the remote entry carries
/// plaintext requests, not tunnels.
fn target_of(head: &str) -> Option<Target> {
    let request_line = head.lines().next()?;
    let mut parts = request_line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    if method.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    if let Some((authority, default_port)) = page_proxy::absolute_form(target) {
        let (host, port) = page_proxy::split_authority(authority, default_port)?;
        return Some(Target {
            authority: authority.to_string(),
            host,
            port,
            tls: target.starts_with("https://"),
        });
    }
    // Origin-form: the authority lives in the Host header, port 80 when
    // unsaid — origin-form frames arrive from this app's own page seam,
    // which always writes the absolute target, so plaintext is the only
    // origin-form this carries.
    let authority = head.lines().find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("host")
            .then(|| value.trim())
    })?;
    let (host, port) = page_proxy::split_authority(authority, 80)?;
    Some(Target {
        authority: authority.to_string(),
        host,
        port,
        tls: false,
    })
}

/// A request head's aim: the authority exactly as written, the host and
/// port resolution wants, and whether the target spoke https — the flag
/// that routes the exchange to the TLS-terminating half.
struct Target {
    authority: String,
    host: String,
    port: u16,
    tls: bool,
}

/// The head rewritten the way an origin expects to hear it: page_proxy's
/// own origin-form rewrite (Host put in when the caller left it out),
/// the hop-by-hop connection headers dropped, `Connection: close`
/// forced — one request per frame, so the target must end its answer at
/// the last body byte, which is the only honest end for a head that
/// says no length — and the body's length said when the caller's head
/// did not say it. A head that DID say a length is trusted as written;
/// the length is the sender's to get right.
fn forward_head(head: &str, authority: &str, body: Option<&str>) -> String {
    let rewritten = page_proxy::origin_form_head(head, authority);
    let body_len = body.map(str::len).unwrap_or(0);
    let has_length = rewritten.lines().any(|l| {
        l.split_once(':')
            .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
    });
    let mut out = String::new();
    for line in rewritten.trim_end_matches("\r\n").lines() {
        let hop_by_hop = line.split_once(':').is_some_and(|(name, _)| {
            name.trim().eq_ignore_ascii_case("connection")
                || name.trim().eq_ignore_ascii_case("proxy-connection")
        });
        if !hop_by_hop {
            out.push_str(line);
            out.push_str("\r\n");
        }
    }
    out.push_str("Connection: close\r\n");
    if body_len > 0 && !has_length {
        out.push_str(&format!("Content-Length: {body_len}\r\n"));
    }
    out.push_str("\r\n");
    out
}

/// Connect to the first address that accepts, in the resolver's order —
/// connect_first's rule with the clock applied: page_proxy's tunnels
/// have no budget, a frame has thirty seconds, and a firewalled host
/// that drops SYNs must not spend them.
fn connect_within(addresses: &[SocketAddr], deadline: &Deadline) -> Option<TcpStream> {
    addresses.iter().find_map(|addr| {
        let left = deadline.remaining().ok()?;
        TcpStream::connect_timeout(addr, left).ok()
    })
}

/// The one deadline every socket call is checked against, so "one
/// request, thirty seconds" is true of the whole exchange and not of
/// each read separately: before every read and write, the time left is
/// what the socket is given.
struct Deadline(Instant);

impl Deadline {
    /// The time left, or the timeout error when there is none.
    fn remaining(&self) -> Result<Duration, String> {
        self.0
            .checked_duration_since(Instant::now())
            .ok_or_else(|| DEADLINE_PASSED.to_string())
    }

    /// Hand the remaining time to the socket, both directions.
    fn apply(&self, stream: &TcpStream) -> Result<(), String> {
        let left = self.remaining()?;
        stream.set_read_timeout(Some(left)).map_err(said)?;
        stream.set_write_timeout(Some(left)).map_err(said)?;
        Ok(())
    }
}

/// An IO failure said as the frame's error string: a timeout by its own
/// name (the platform says TimedOut or WouldBlock for the same
/// expired deadline), everything else as itself.
fn said(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
            DEADLINE_PASSED.to_string()
        }
        _ => format!("the exchange failed: {e}"),
    }
}

/// The response body: `content-length` bytes when the head said how
/// many, to the closing byte otherwise (`Connection: close` is forced,
/// so a head without a length still ends at EOF), never more than
/// [`MAX_BODY_BYTES`] — past that the body is cut and the cut is logged.
/// `None` when nothing followed the head.
fn read_body(
    stream: &mut TcpStream,
    head: &str,
    deadline: &Deadline,
) -> Result<Option<String>, String> {
    let length: Option<usize> = head.lines().find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())?
    });
    let mut bytes: Vec<u8> = Vec::new();
    let mut buf = [0u8; READ_BUFFER];
    match length {
        Some(exact) => {
            // Never read past the cap: the aim bounds every read, so a
            // body past the cap is cut by what is read, not truncated
            // after overshooting it.
            let aim = exact.min(MAX_BODY_BYTES);
            while bytes.len() < aim {
                deadline.apply(stream)?;
                let want = (aim - bytes.len()).min(buf.len());
                match stream.read(&mut buf[..want]) {
                    // The target ended before its head's length: give
                    // back what arrived rather than wait for bytes the
                    // connection can no longer carry.
                    Ok(0) => break,
                    Ok(n) => bytes.extend_from_slice(&buf[..n]),
                    Err(e) => return Err(said(e)),
                }
            }
            if exact > MAX_BODY_BYTES {
                eprintln!(
                    "[core] remote proxy truncated a body at {MAX_BODY_BYTES} bytes: the head said {exact}"
                );
            }
        }
        None => loop {
            deadline.apply(stream)?;
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    bytes.extend_from_slice(&buf[..n]);
                    if bytes.len() >= MAX_BODY_BYTES {
                        bytes.truncate(MAX_BODY_BYTES);
                        eprintln!(
                            "[core] remote proxy truncated a body at {MAX_BODY_BYTES} bytes: the head said no length"
                        );
                        break;
                    }
                }
                Err(e) => return Err(said(e)),
            }
        },
    }
    if bytes.is_empty() {
        Ok(None)
    } else {
        // Base64, not lossy text: an image or a font crosses intact —
        // the joiner decodes it back to the exact bytes.
        Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(&bytes),
        ))
    }
}

/// The https half: TLS terminated on the HOST, by the client the tree
/// already builds (reqwest over rustls, the ring provider http.rs
/// installs) — certificate validation, SNI and the HTTP/2-or-1.1
/// negotiation are the host's, and the joiner receives the same
/// plain-HTTP-shaped (head, base64 body) answer every origin gives it.
///
/// Resolution is SYSTEM resolution, deliberately: the names on this path
/// are the host's intranet's, answerable only by the host's own resolver
/// — the same rule the plaintext half states, applied to the client.
fn exchange_tls(
    head: &str,
    body: Option<&str>,
    budget: Duration,
    target: &Target,
) -> Result<(String, Option<String>), String> {
    static CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
        crate::http::build_with(
            crate::http::Spec {
                timeout: Some(REQ_DEADLINE),
                ..crate::http::Spec::default()
            },
            crate::http::DnsPolicy::System,
        )
        .map_err(|e| format!("the TLS client would not build: {e}"))
    });
    let client = CLIENT.as_ref().map_err(|e| e.clone())?;

    // Parse the frame's request line and headers back into a reqwest
    // request. The frame always carries an absolute target on this path
    // (the joiner's page seam writes it), so the URL is the target as
    // written; hop-by-hop and length headers stay the transport's.
    let mut lines = head.split("\r\n").flat_map(|l| l.split('\n'));
    let request_line = lines.next().ok_or(THE_UNAIMABLE)?;
    let mut parts = request_line.split(' ');
    let method = parts.next().ok_or(THE_UNAIMABLE)?;
    let url = parts.next().ok_or(THE_UNAIMABLE)?;
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("the method did not parse: {e}"))?;

    let mut request = client.request(method, url);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let hop = name.eq_ignore_ascii_case("host")
            || name.eq_ignore_ascii_case("connection")
            || name.eq_ignore_ascii_case("proxy-connection")
            || name.eq_ignore_ascii_case("content-length");
        if hop || name.is_empty() {
            continue;
        }
        request = request.header(name, value.trim());
    }
    if let Some(body) = body {
        request = request.body(body.to_string());
    }

    // The exchange runs on the proxy's own thread (one request, one
    // thread — the same stance the plaintext half takes); the app's
    // async runtime hosts the client's future.
    let outcome = tauri::async_runtime::block_on(async {
        let resp = match request.send().await {
            Ok(r) => r,
            Err(e) => return Err(format!("the https exchange failed: {e}")),
        };
        let status = resp.status();
        let headers = resp
            .headers()
            .iter()
            .filter(|(name, _)| {
                // The joiner rebuilds its Response from the actual body
                // bytes; the origin's framing headers would describe a
                // transport that no longer exists.
                !name.as_str().eq_ignore_ascii_case("content-length")
                    && !name.as_str().eq_ignore_ascii_case("transfer-encoding")
            })
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect::<Vec<_>>();
        let mut bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => return Err(format!("the https body failed: {e}")),
        };
        if bytes.len() > MAX_BODY_BYTES {
            bytes.truncate(MAX_BODY_BYTES);
            eprintln!("[core] remote proxy truncated an https body at {MAX_BODY_BYTES} bytes");
        }
        Ok((status, headers, bytes))
    });
    let _ = (budget, target); // the client's own timeout carries the budget
    let (status, headers, bytes) = outcome?;

    let mut answered = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    for (name, value) in headers {
        answered.push_str(&format!("{name}: {value}\r\n"));
    }
    answered.push_str("\r\n");
    let body_b64 = if bytes.is_empty() {
        None
    } else {
        Some(base64::engine::general_purpose::STANDARD.encode(&bytes[..]))
    };
    Ok((answered, body_b64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex as StdMutex};

    /// A name reserved by RFC 6761 §6.2 so that it resolves nowhere on
    /// its own: the system resolver can only fail it, which is the
    /// discrimination the refusal test needs.
    const PROBE_HOST: &str = "tabverse-proxy-probe.test";

    /// The wall-clock patience of the waits below — page_proxy tests'
    /// rule: a deadline that never fires when things work, and fires
    /// fast enough to fail a test rather than hang a run.
    const PATIENCE: Duration = Duration::from_secs(5);

    // ------------------------------------------------------------- the stub
    //
    // A one-shot origin on loopback, in page_proxy tests' shape: an
    // independent witness of what arrived, with its own parser, so the
    // code under test is not asked to grade itself.

    /// One request off a socket: the head, and a body of Content-Length.
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

    /// What the origin answers.
    #[derive(Clone)]
    enum Reply {
        /// A 200, `content-length` said, this body.
        Body(Vec<u8>),
        /// A 200 with no length said: the body, then the socket closes —
        /// the answer only `Connection: close` can end.
        Lengthless(Vec<u8>),
        /// A 204: no body, no length.
        Empty,
        /// The request is read and the connection sits silent — the peer
        /// whose answer never comes.
        Silent,
    }

    type ServedRequest = (String, Vec<u8>);
    type RequestLog = Arc<StdMutex<Vec<ServedRequest>>>;

    /// A loopback origin that records every request it serves and
    /// answers as told.
    fn origin(reply: Reply) -> (u16, RequestLog) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the origin");
        let port = listener.local_addr().unwrap().port();
        let seen: RequestLog = Arc::new(StdMutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(mut stream) = incoming else { continue };
                let reply = reply.clone();
                let record = Arc::clone(&record);
                std::thread::spawn(move || {
                    let (head, body) = read_request(&mut stream);
                    record.lock().unwrap().push((head, body));
                    match reply {
                        Reply::Body(bytes) => {
                            let head = format!(
                                "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\
                                 content-length: {}\r\n\r\n",
                                bytes.len()
                            );
                            let _ = stream.write_all(head.as_bytes());
                            let _ = stream.write_all(&bytes);
                        }
                        Reply::Lengthless(bytes) => {
                            let _ = stream
                                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n");
                            let _ = stream.write_all(&bytes);
                        }
                        Reply::Empty => {
                            let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\n\r\n");
                        }
                        // Outlive any deadline a test could name, so the
                        // only honest outcome is the timeout error.
                        Reply::Silent => std::thread::sleep(PATIENCE * 2),
                    }
                });
            }
        });
        (port, seen)
    }

    /// Wait until the origin has served its request — polled, because
    /// the exchange runs on the calling thread but the origin serves on
    /// its own.
    fn served(seen: &RequestLog) -> ServedRequest {
        let deadline = Instant::now() + PATIENCE;
        while Instant::now() < deadline {
            if let Some(seen) = seen.lock().unwrap().first().cloned() {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("the origin served nothing inside the patience window");
    }

    fn first_line(head: &str) -> &str {
        head.lines().next().unwrap_or_default()
    }

    /// The frame body is base64 now; assertions compare decoded bytes.
    fn decode(body: &Option<String>) -> Vec<u8> {
        use base64::Engine as _;
        body.as_ref()
            .map(|b| {
                base64::engine::general_purpose::STANDARD
                    .decode(b)
                    .expect("the frame body is valid base64")
            })
            .unwrap_or_default()
    }

    // ------------------------------------------------------------- the tests

    #[test]
    fn head_parsing_reads_both_request_forms_and_their_ports() {
        let absolute = target_of("GET http://intranet.corp:8080/wiki/A HTTP/1.1\r\n\r\n")
            .expect("an absolute target is aimable");
        assert_eq!(absolute.authority, "intranet.corp:8080");
        assert_eq!(absolute.host, "intranet.corp");
        assert_eq!(absolute.port, 8080);

        let defaulted = target_of("GET http://intranet.corp/ HTTP/1.1\r\n\r\n")
            .expect("http's default port is 80");
        assert_eq!(defaulted.host, "intranet.corp");
        assert_eq!(defaulted.port, 80);

        let origin_form = target_of("GET /wiki/A HTTP/1.1\r\nHost: intranet.corp:9090\r\n\r\n")
            .expect("a Host header aims an origin-form request");
        assert_eq!(origin_form.authority, "intranet.corp:9090");
        assert_eq!(origin_form.host, "intranet.corp");
        assert_eq!(origin_form.port, 9090);

        let secured = target_of("GET https://gitlab.corp:8443/dashboard HTTP/1.1\r\n\r\n")
            .expect("an https target is aimable");
        assert_eq!(secured.authority, "gitlab.corp:8443");
        assert_eq!(secured.port, 8443);
        assert!(secured.tls, "the https scheme routes to the TLS half");

        assert!(
            target_of("CONNECT intranet.corp:443 HTTP/1.1\r\n\r\n").is_none(),
            "a CONNECT names a tunnel, and this entry carries requests"
        );
        assert!(
            target_of("GET /nowhere HTTP/1.1\r\n\r\n").is_none(),
            "origin-form without a Host aims at nothing"
        );
    }

    /// The whole path in one, absolute-form half: the frame is rewritten
    /// the way the origin expects to hear it (origin-form request line,
    /// Host put in, Connection: close forced), the answer's head and
    /// body both come back, and the id-shaped correlation the caller
    /// needs is exactly the (head, body) pair this returns.
    #[test]
    fn an_absolute_form_request_round_trips_through_the_host_network() {
        let (port, seen) = origin(Reply::Body(b"the intranet answered".to_vec()));

        let (head, body) = run(
            &format!(
                "GET http://127.0.0.1:{port}/wiki/Home HTTP/1.1\r\n\
                 User-Agent: tabverse-test\r\n\r\n"
            ),
            None,
        )
        .expect("the exchange succeeds");

        let (arrived, arrived_body) = served(&seen);
        assert_eq!(first_line(&arrived), "GET /wiki/Home HTTP/1.1");
        assert!(
            arrived
                .lines()
                .any(|l| l.eq_ignore_ascii_case(&format!("Host: 127.0.0.1:{port}"))),
            "the Host names the authority: {arrived:?}"
        );
        assert!(
            arrived
                .lines()
                .any(|l| l.eq_ignore_ascii_case("Connection: close")),
            "the forward is one-shot: {arrived:?}"
        );
        assert!(arrived_body.is_empty(), "a GET carries no body");
        assert_eq!(first_line(&head), "HTTP/1.1 200 OK");
        assert!(head.contains("content-length: 21"));
        assert_eq!(decode(&body), b"the intranet answered");
    }

    /// The origin-form half, and the body's: the Host header alone aims
    /// the request — through `localhost`, so the system resolver is the
    /// one that answers, which is the arm this module exists for — and a
    /// body travels with its length said when the caller's head did not
    /// say it.
    #[test]
    fn an_origin_form_request_aims_by_host_and_carries_a_body() {
        let (port, seen) = origin(Reply::Body(b"stored".to_vec()));

        let (_head, body) = run(
            &format!("POST /notes HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n"),
            Some("hello=1"),
        )
        .expect("the exchange succeeds");

        let (arrived, arrived_body) = served(&seen);
        assert_eq!(first_line(&arrived), "POST /notes HTTP/1.1");
        assert!(
            arrived
                .lines()
                .any(|l| l.eq_ignore_ascii_case("Content-Length: 7")),
            "the body's length is said for it: {arrived:?}"
        );
        assert_eq!(arrived_body, b"hello=1");
        assert_eq!(decode(&body), b"stored");
    }

    #[test]
    fn a_no_body_answer_comes_back_without_a_body() {
        let (port, _seen) = origin(Reply::Empty);
        let (head, body) = run(
            &format!("GET http://127.0.0.1:{port}/ HTTP/1.1\r\n\r\n"),
            None,
        )
        .expect("the exchange succeeds");
        assert_eq!(first_line(&head), "HTTP/1.1 204 No Content");
        assert_eq!(body, None);
    }

    #[test]
    fn a_lengthless_body_ends_at_the_sockets_end() {
        let (port, _seen) = origin(Reply::Lengthless(b"chunk of text".to_vec()));
        let (_head, body) = run(
            &format!("GET http://127.0.0.1:{port}/ HTTP/1.1\r\n\r\n"),
            None,
        )
        .expect("the exchange succeeds");
        assert_eq!(decode(&body), b"chunk of text");
    }

    #[test]
    fn a_silent_origin_outlives_its_deadline_and_says_so() {
        let (port, _seen) = origin(Reply::Silent);
        let err = exchange(
            &format!("GET http://127.0.0.1:{port}/ HTTP/1.1\r\n\r\n"),
            None,
            Duration::from_millis(250),
        )
        .expect_err("a silent origin must answer with the deadline error");
        assert_eq!(err, DEADLINE_PASSED);
    }

    /// The head may promise more than a frame carries: the body is cut
    /// at a mebibyte and everything before the cut arrives intact.
    #[test]
    fn a_body_past_a_mebibyte_is_cut_and_the_cut_logged() {
        let (port, _seen) = origin(Reply::Body(vec![b'a'; MAX_BODY_BYTES + 4096]));
        let (_head, body) = run(
            &format!("GET http://127.0.0.1:{port}/big HTTP/1.1\r\n\r\n"),
            None,
        )
        .expect("a truncated answer is still an answer");
        let bytes = decode(&Some(body.expect("the cut body arrives")));
        assert_eq!(bytes.len(), MAX_BODY_BYTES);
        assert!(bytes.iter().all(|&b| b == b'a'));
    }

    /// The reserved-name probe over TLS: the exchange reaches the
    /// client, the system resolver fails the name, and the error says
    /// the exchange — not a TLS handshake against nothing.
    #[test]
    fn an_unresolvable_https_name_is_refused_by_the_exchange() {
        let err = run(&format!("GET https://{PROBE_HOST}/ HTTP/1.1\r\n\r\n"), None)
            .expect_err("a reserved name resolves nowhere, TLS included");
        assert!(
            err.contains("https exchange failed"),
            "the failure is the exchange's own wording: {err}"
        );
    }

    #[test]
    fn an_unaimable_request_is_refused() {
        assert_eq!(
            run("CONNECT intranet.corp:443 HTTP/1.1\r\n\r\n", None)
                .expect_err("CONNECT is not carried"),
            THE_UNAIMABLE
        );
        assert_eq!(
            run("GET /nowhere HTTP/1.1\r\n\r\n", None).expect_err("no Host, no aim"),
            THE_UNAIMABLE
        );
    }

    /// The reserved-name probe (RFC 6761): only the system resolver is
    /// asked — the DoH policy has no say here — and it can only fail
    /// the name. Asserted as an error, not as its wording: a network
    /// that hijacks every name still refuses the exchange further down.
    #[test]
    fn an_unresolvable_name_is_refused() {
        let err = run(&format!("GET http://{PROBE_HOST}/ HTTP/1.1\r\n\r\n"), None)
            .expect_err("a reserved name resolves nowhere");
        assert!(err.contains("no address"));
    }
}
