use std::io::{Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::http::{self, DnsPolicy};

/// The greeting a CONNECT waits for before its first tunneled byte.
const CONNECT_ESTABLISHED: &str = "HTTP/1.1 200 Connection Established\r\n\r\n";
/// The answer when a tunnel could not be opened at the far end.
const HTTP_502: &[u8] =
    b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
/// The answer when the request is not one this proxy can forward.
const HTTP_400: &[u8] =
    b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

/// The most request head this reads. A browser's head is a few hundred
/// bytes; sixteen kilobytes is several times past generous, and the cap is
/// what keeps a stray non-HTTP connection from parking a thread behind an
/// unbounded read.
const MAX_HEAD_BYTES: usize = 16 * 1024;

/// The pump buffer. transfer.rs's size: big enough that a page's resources
/// move in handfuls of reads, small enough that a slow direction does not
/// own a megabyte.
const PUMP_BUFFER: usize = 8192;

/// A back-off for accept errors, so a burst of them cannot spin the loop.
const ACCEPT_BACKOFF: std::time::Duration = std::time::Duration::from_millis(5);

/// How long a connection may take to deliver its request head. A page's
/// head arrives in milliseconds; a client that holds a half-written head is
/// either broken or probing, and either way its thread is not worth keeping
/// past this.
const HEAD_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

/// How long a tunnel may go quiet before its threads give the sockets back.
/// TLS tunnels between healthy peers are never this quiet — the TLS
/// heartbeat or the page's own keep-alive speaks long before — so this is
/// the reaping deadline for the connection that stopped being a tunnel and
/// became a parked thread holding two sockets.
const TUNNEL_IDLE: std::time::Duration = std::time::Duration::from_secs(60);

/// The running proxy.
///
/// Dropping it stops it: the listener closes and the accept thread is
/// joined. Connections already tunneling end when their sockets end, which
/// is the only honest thing to do to TLS streams this side cannot read.
pub struct PageProxy {
    /// The port the listener drew, for whoever points a webview here.
    pub port: u16,
    shared: Arc<Shared>,
    /// The accept thread, taken by [`PageProxy::stop`] so stopping twice is
    /// nothing.
    thread: Option<std::thread::JoinHandle<()>>,
}

impl PageProxy {
    /// Bind 127.0.0.1 on a port the OS picks, and start accepting.
    ///
    /// Binding before returning is deliberate — the agent_login.rs rule: if
    /// the port cannot be had, the caller finds out now, while it can still
    /// say so, rather than after pointing pages at a proxy that is not
    /// there. A dynamic port, because nothing upstream may depend on a
    /// fixed one being free.
    ///
    /// `on_death` runs if the accept thread ends any way OTHER than
    /// [`PageProxy::stop`] asking it to (a panic's unwind, in practice —
    /// the one way the slot above can hold a proxy whose listener is gone).
    /// It fires from the dying thread itself; tests and callers with no
    /// one to tell pass a no-op.
    pub fn start(on_death: impl FnOnce() + Send + 'static) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).inspect_err(|e| {
            eprintln!("[core] page proxy could not bind a loopback port: {e}");
        })?;
        let port = listener.local_addr()?.port();
        let shared = Arc::new(Shared::default());
        let accept_shared = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name("tabverse-page-proxy".into())
            .spawn(move || {
                // The end is bookkept from inside the thread so it is
                // recorded whatever way the thread ends — a stop, a return,
                // or a panic's unwind — which is what makes is_alive()
                // honest about all three.
                let _end = ThreadEnd {
                    shared: Arc::clone(&accept_shared),
                    on_death: Some(Box::new(on_death)),
                };
                accept_loop(listener, accept_shared);
            })?;
        Ok(Self {
            port,
            shared,
            thread: Some(thread),
        })
    }

    /// Tunnels established so far — CONNECT tunnels and forwarded plaintext
    /// requests both count, one per connection carried. Refusals do not.
    pub fn hits(&self) -> u64 {
        self.shared.hits.load(Ordering::Relaxed)
    }

    pub fn is_alive(&self) -> bool {
        !self.shared.shutdown.load(Ordering::SeqCst) && !self.shared.finished.load(Ordering::SeqCst)
    }

    /// Stop accepting and join the accept thread. Idempotent.
    pub fn stop(&mut self) {
        let Some(thread) = self.thread.take() else {
            return;
        };
        self.shared.shutdown.store(true, Ordering::SeqCst);
        // Wake the park: the one thing that reaches a thread blocked in
        // accept is a connection. The flag is already set, so whichever
        // connection accept returns for — this one or a straggler — the
        // loop exits and the listener closes under it.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        let _ = thread.join();
    }
}

impl Drop for PageProxy {
    fn drop(&mut self) {
        self.stop();
    }
}

/// What the accept thread and the connection threads share.
#[derive(Default)]
struct Shared {
    hits: AtomicU64,
    shutdown: AtomicBool,
    /// Set by [`ThreadEnd`] the moment the accept thread ends — the flag
    /// [`PageProxy::is_alive`] reads. A thread parked in accept has not
    /// ended, so an idle proxy stays alive; only a thread that is gone
    /// reads as gone.
    finished: AtomicBool,
    /// The DoH resolver, cached under the URL of the policy that built it —
    /// a held client is the difference between one connection to the
    /// endpoint per process and one per tunnel. The POLICY is not cached
    /// here: each connection reads `http::policy()` fresh, so a settings
    /// write that calls `http::forget()` is picked up by the next connection
    /// without this module hearing about it.
    doh: Mutex<Option<(String, Arc<http::DohResolver>)>>,
}

/// The accept thread's own record of its ending, dropped wherever the
/// thread ends (the guard survives a panic's unwind) so liveness never has
/// to be guessed at from outside.
struct ThreadEnd {
    shared: Arc<Shared>,
    /// Fired only when the end was not stop()'s doing — the caller asked
    /// for that one, and it is not news. `Option` so it fires once even if
    /// the drop runs twice through re-entrant panic.
    on_death: Option<Box<dyn FnOnce() + Send>>,
}

impl Drop for ThreadEnd {
    fn drop(&mut self) {
        self.shared.finished.store(true, Ordering::SeqCst);
        if !self.shared.shutdown.load(Ordering::SeqCst) {
            if let Some(fire) = self.on_death.take() {
                fire();
            }
        }
    }
}

impl Shared {
    /// The resolver for the URL the policy names, built once per URL.
    fn resolver_for(&self, url: &str) -> Option<Arc<http::DohResolver>> {
        let mut slot = self.doh.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached, resolver)) = slot.as_ref() {
            if cached == url {
                return Some(Arc::clone(resolver));
            }
        }
        let resolver = Arc::new(http::DohResolver::new(url.to_string()).ok()?);
        *slot = Some((url.to_string(), Arc::clone(&resolver)));
        Some(resolver)
    }
}

/// Accept until told to stop, handing each connection its own thread so one
/// slow page cannot queue the rest behind it.
fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if shared.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let conn_shared = Arc::clone(&shared);
                // Spawn failures (thread exhaustion) close the stream with
                // the scope, which answers the client with the only thing a
                // proxy with no thread left can say.
                let _ = std::thread::Builder::new()
                    .name("tabverse-page-proxy-conn".into())
                    .spawn(move || handle_connection(stream, conn_shared));
            }
            Err(_) => {
                // An accept error (ECONNABORTED is the usual one) is a
                // connection that never was; the listener is still ours and
                // still open. Back off and stay up.
                std::thread::sleep(ACCEPT_BACKOFF);
            }
        }
    }
}

/// A proxy speaks plaintext pages the way origins expect to hear them:
/// the absolute-form request line becomes method + path + version, and a
/// Host header naming the authority is put in if the client left the
/// proxy to imply it. RFC 9110 lets a server insist on origin-form, and
/// the real ones do — the echo stub this proxy was born against accepted
/// anything, which is exactly how a verbatim forwarder shipped green.
/// Shared with the remote-proxy entry (remote_proxy.rs), which speaks
/// the same rewrite frame-side.
pub(crate) fn origin_form_head(head: &str, authority: &str) -> String {
    let mut lines = head.lines();
    let first = lines.next().unwrap_or_default();
    let mut segs = first.splitn(3, ' ');
    let method = segs.next().unwrap_or("GET");
    let target = segs.next().unwrap_or("/");
    let version = segs.next().unwrap_or("HTTP/1.1");
    let origin_path = target
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/'))
        .map(|(_, tail)| format!("/{tail}"))
        .unwrap_or_else(|| target.to_string());
    let mut out = format!("{method} {origin_path} {version}\r\n");
    let rest: Vec<&str> = lines.collect();
    let has_host = rest
        .iter()
        .any(|l| l.to_ascii_lowercase().starts_with("host:"));
    if !has_host {
        out.push_str(&format!("Host: {authority}\r\n"));
    }
    for line in rest {
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str("\r\n");
    out
}

/// Read one request head and carry it, or refuse it.
fn handle_connection(mut client: TcpStream, shared: Arc<Shared>) {
    let _ = client.set_nonblocking(false);
    let _ = client.set_nodelay(true);
    // The head arrives in milliseconds; the deadline turns a client that
    // never finishes one into a closed socket instead of a parked thread.
    let _ = client.set_read_timeout(Some(HEAD_DEADLINE));
    let head = match read_head(&mut client) {
        Ok(head) => head,
        Err(_) => return, // nothing parseable arrived in time; closing is the answer
    };
    let request_line = head.lines().next().unwrap_or_default().to_string();
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default().to_string();

    if method == "CONNECT" {
        // RFC 9110 §9.3.6: an authority, port optional and 443 when absent.
        // The 200 is the PROXY'S answer to its CLIENT. It must never be
        // written to the target — an echo target made that direction bug
        // look green by bouncing the misplaced greeting back.
        match split_authority(&target, 443) {
            Some((host, port)) => carry(
                client,
                &host,
                port,
                Prelude::Client(CONNECT_ESTABLISHED),
                &shared,
            ),
            None => refuse(&mut client, Refusal::NotForwardable),
        }
    } else if let Some((authority, default_port)) = absolute_form(&target) {
        match split_authority(authority, default_port) {
            Some((host, port)) => {
                let forwarded = origin_form_head(&head, authority);
                carry(client, &host, port, Prelude::Target(&forwarded), &shared)
            }
            None => refuse(&mut client, Refusal::NotForwardable),
        }
    } else {
        // A relative path means the client took this proxy for an origin
        // server. Pages are https and arrive by CONNECT; a plaintext request
        // this cannot aim is refused rather than guessed at.
        refuse(&mut client, Refusal::NotForwardable);
    }
}

/// The bytes that establish forwarding belong to exactly one side.
/// CONNECT is answered to the client; an absolute-form request is rewritten
/// and sent to the target. Making the direction a type keeps the two roads
/// from sharing a string whose ownership can silently flip.
enum Prelude<'a> {
    Client(&'a str),
    Target(&'a str),
}

/// Resolve `host` under the policy in force, connect to the first address
/// that accepts, deliver the prelude to its owner, then move bytes in both
/// directions.
fn carry(mut client: TcpStream, host: &str, port: u16, prelude: Prelude<'_>, shared: &Shared) {
    let addresses = match resolve(host, port, shared) {
        Ok(addresses) => addresses,
        Err(refusal) => {
            refuse(&mut client, refusal);
            return;
        }
    };
    let mut target = match connect_first(&addresses) {
        Some(target) => target,
        None => {
            refuse(&mut client, Refusal::ConnectFailed);
            return;
        }
    };
    let _ = target.set_nodelay(true);
    // Both directions may go quiet without either side ending — a tunnel
    // whose client vanished mid-TLS. The idle deadline turns that into a
    // closed pair of sockets instead of two threads parked forever on reads
    // that no one is left to answer.
    let _ = client.set_read_timeout(Some(TUNNEL_IDLE));
    let _ = target.set_read_timeout(Some(TUNNEL_IDLE));
    let count = shared.hits.fetch_add(1, Ordering::Relaxed) + 1;
    // Counts, not paths — the download ledger's rule: which host was
    // tunneled is the user's browsing, not this program's to log.
    eprintln!("[core] page proxy tunnel count={count}");
    let prelude_result = match prelude {
        Prelude::Client(bytes) => client.write_all(bytes.as_bytes()),
        Prelude::Target(bytes) => target.write_all(bytes.as_bytes()),
    };
    if prelude_result.is_err() {
        return; // its owner left; the tunnel goes with it
    }
    tunnel(client, target);
}

/// Why a connection was not carried.
enum Refusal {
    /// The policy gave no address for the name. Under the DoH arm this is
    /// final on purpose — the fallback to the system resolver is the one
    /// road this module must not take.
    NoAddress,
    /// Every address the policy gave refused the connection.
    ConnectFailed,
    /// The request named no host this proxy can forward to.
    NotForwardable,
}

impl Refusal {
    fn as_log(&self) -> &'static str {
        match self {
            Self::NoAddress => "the DNS policy gave no address",
            Self::ConnectFailed => "no address accepted the connection",
            Self::NotForwardable => "the request named no forwardable host",
        }
    }

    fn as_response(&self) -> &'static [u8] {
        match self {
            Self::NoAddress | Self::ConnectFailed => HTTP_502,
            Self::NotForwardable => HTTP_400,
        }
    }
}

/// Answer a connection this proxy will not carry — said in the log as a
/// category, never as a name.
fn refuse(client: &mut TcpStream, refusal: Refusal) {
    eprintln!("[core] page proxy refused a tunnel: {}", refusal.as_log());
    let _ = client.write_all(refusal.as_response());
}

/// One name's addresses, port attached, under the policy in force.
///
/// This is the seam the module exists for: the DoH arm resolves through
/// http.rs's own resolver and nothing else, and its failure is returned, not
/// retried against the system — "page traffic resolves the way the user
/// asked" has no unwitnessed path in it. The System arm resolves through the
/// OS because that arm IS the ask.
fn resolve(host: &str, port: u16, shared: &Shared) -> Result<Vec<SocketAddr>, Refusal> {
    // A literal is not a name: there is nothing to resolve and no policy
    // with an opinion, so it connects as written. A page at
    // https://127.0.0.1/ is page traffic too.
    if let Ok(literal) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(literal, port)]);
    }
    match http::policy() {
        DnsPolicy::Doh(url) => {
            let Some(resolver) = shared.resolver_for(&url) else {
                return Err(Refusal::NoAddress);
            };
            let asked = host.to_string();
            let answered =
                tauri::async_runtime::block_on(async move { resolver.lookup_host(&asked).await });
            match answered {
                // lookup_host stamps every address with the undecided port;
                // the port is the client's, attached here where it is known.
                Ok(addrs) => Ok(addrs
                    .into_iter()
                    .map(|a| SocketAddr::new(a.ip(), port))
                    .collect()),
                Err(_) => Err(Refusal::NoAddress),
            }
        }
        DnsPolicy::System => resolve_system(host, port).ok_or(Refusal::NoAddress),
    }
}

/// One name's addresses through the host's own resolver, port attached —
/// the policy's System arm on its own, factored out because the remote
/// proxy (remote_proxy.rs) is built entirely on it: the names it carries
/// are the host's intranet's, answerable only by the host's system
/// resolver, so that arm is the whole of its resolution. `None` when the
/// resolver answered with nothing or not at all.
///
/// A literal is not a name (the same rule `resolve` applies before any
/// policy): there is nothing to resolve, so it connects as written.
pub(crate) fn resolve_system(host: &str, port: u16) -> Option<Vec<SocketAddr>> {
    if let Ok(literal) = host.parse::<IpAddr>() {
        return Some(vec![SocketAddr::new(literal, port)]);
    }
    (host, port)
        .to_socket_addrs()
        .map(|addrs| addrs.collect())
        .ok()
}

/// Connect to the first address that accepts, in the order the resolver gave
/// them — that order is the resolver's preference, and it is the order
/// reqwest's own connect follows under the same answer.
fn connect_first(addresses: &[SocketAddr]) -> Option<TcpStream> {
    addresses
        .iter()
        .find_map(|addr| TcpStream::connect(addr).ok())
}

/// Move bytes in both directions until each side has ended.
///
/// One thread each way, joined here: the handler thread is the tunnel's
/// lifetime, and when both pumps are done every socket it owned is closed.
fn tunnel(client: TcpStream, target: TcpStream) {
    // Clones, so each direction owns its copy of both sockets. A clone
    // failure (descriptor exhaustion) ends the tunnel with both sides
    // closed, which tells each the other is gone.
    let (Ok(client_back), Ok(target_back)) = (client.try_clone(), target.try_clone()) else {
        return;
    };
    let up = std::thread::Builder::new()
        .name("tabverse-page-proxy-up".into())
        .spawn(move || pump(client, target_back));
    let down = std::thread::Builder::new()
        .name("tabverse-page-proxy-down".into())
        .spawn(move || pump(target, client_back));
    if let Ok(up) = up {
        let _ = up.join();
    }
    if let Ok(down) = down {
        let _ = down.join();
    }
}

/// One direction: read until the from-side ends, then propagate that end to
/// the to-side's writer, so a half-close survives the hop (transfer.rs's
/// drain shape, on sockets).
fn pump(mut from: TcpStream, mut to: TcpStream) {
    let mut buf = [0u8; PUMP_BUFFER];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if to.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = to.shutdown(Shutdown::Write);
}

/// The request head, read to the blank line.
///
/// Byte by byte — the house pattern for heads (http.rs's stubs read the same
/// way) — because a BufReader would quietly hold bytes of what follows, and
/// the tunnel that follows must see every one of them. Shared with the
/// remote-proxy entry (remote_proxy.rs), which reads answer heads the same
/// way — one blank line ends them both.
pub(crate) fn read_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut head: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte)? {
            0 => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "the head ended before its blank line",
                ));
            }
            _ => head.push(byte[0]),
        }
        if head.len() > MAX_HEAD_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "the head is larger than this proxy reads",
            ));
        }
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

/// An absolute-form target's authority and the port its scheme defaults to,
/// or `None` when the target is not absolute (a path, or another scheme).
/// Shared with the remote-proxy entry (remote_proxy.rs).
pub(crate) fn absolute_form(target: &str) -> Option<(&str, u16)> {
    let (rest, default_port) = if let Some(rest) = target.strip_prefix("http://") {
        (rest, 80u16)
    } else {
        let rest = target.strip_prefix("https://")?;
        (rest, 443u16)
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some((&rest[..end], default_port))
}

/// Split an authority into host and port, square brackets understood for
/// IPv6 literals; `None` when the port is not a number. Shared with the
/// remote-proxy entry (remote_proxy.rs).
pub(crate) fn split_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, rest) = rest.split_once(']')?;
        let port = match rest.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None => default_port,
        };
        return Some((host.to_string(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => Some((host.to_string(), port.parse().ok()?)),
        None => Some((authority.to_string(), default_port)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{self, DnsPolicy};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{mpsc, Mutex as StdMutex};
    use std::time::{Duration, Instant};

    /// A name reserved by RFC 6761 §6.2 so that it resolves nowhere on its
    /// own: any answer the tests below see for it can only have come from
    /// the stub, and any system-resolution mutation can only fail it.
    const PROBE_HOST: &str = "tabverse-proxy-probe.test";

    /// The wall-clock patience of the waits below. Loopback answers in
    /// milliseconds; five seconds is a deadline that never fires when things
    /// work, and fires fast enough to fail a test rather than hang a run.
    const PATIENCE: Duration = Duration::from_secs(5);

    // ------------------------------------------------------------- the stubs
    //
    // Listeners on 127.0.0.1 that never leave this machine, in the shape of
    // http.rs's own DoH stub — an independent witness of what arrived, with
    // its own parser, so the code under test is not asked to grade itself.

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

    /// The question a DNS query carries, read with a parser of this test's
    /// own (not `skip_name`) so the stub remains an independent witness.
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

    /// What the stub answers with.
    enum Answer {
        /// One A record, 127.0.0.1 — "the name is this machine."
        Loopback,
        /// Zero records, no error — "the name has no address."
        Nothing,
    }

    /// A DoH endpoint on loopback that records what it was asked and answers
    /// as told.
    struct DohStub {
        url: String,
        asked: Arc<StdMutex<Vec<String>>>,
    }

    fn doh_stub(answer: Answer) -> DohStub {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the stub");
        let port = listener.local_addr().unwrap().port();
        let asked = Arc::new(StdMutex::new(Vec::new()));
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

                let records = match answer {
                    Answer::Loopback => 1u16,
                    Answer::Nothing => 0u16,
                };
                let mut reply: Vec<u8> = Vec::new();
                reply.extend_from_slice(&body[0..2]); // the id it asked with
                reply.extend_from_slice(&0x8180u16.to_be_bytes()); // reply, recursion done
                reply.extend_from_slice(&1u16.to_be_bytes()); // one question
                reply.extend_from_slice(&records.to_be_bytes());
                reply.extend_from_slice(&0u16.to_be_bytes());
                reply.extend_from_slice(&0u16.to_be_bytes());
                reply.extend_from_slice(&body[12..question_end]); // echoed
                if matches!(answer, Answer::Loopback) {
                    // The name, as a compression pointer back to the
                    // question — the shape a real resolver writes and the
                    // decoder has to survive.
                    reply.extend_from_slice(&[0xC0, 0x0C]);
                    reply.extend_from_slice(&1u16.to_be_bytes()); // A
                    reply.extend_from_slice(&1u16.to_be_bytes()); // IN
                    reply.extend_from_slice(&60u32.to_be_bytes()); // ttl
                    reply.extend_from_slice(&4u16.to_be_bytes()); // rdlength
                    reply.extend_from_slice(&[127, 0, 0, 1]);
                }

                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/dns-message\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n",
                    reply.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&reply);
                let _ = stream.flush();
            }
        });
        DohStub {
            url: format!("http://127.0.0.1:{port}/dns-query"),
            asked,
        }
    }

    /// Wait until the stub has been asked for the name, and say so — the
    /// DoH half of every assertion below, polled because the question is
    /// asked on another thread.
    fn stub_was_asked(stub: &DohStub, name: &str) -> bool {
        let deadline = Instant::now() + PATIENCE;
        while Instant::now() < deadline {
            if stub.asked.lock().unwrap().iter().any(|n| n == name) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    /// A TCP echo server: the "target host" the tunnel is aimed at. What a
    /// test writes at one end must come back the other, byte for byte, or
    /// the tunnel changed something.
    fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the echo server");
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(mut stream) = incoming else { continue };
                std::thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    loop {
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if stream.write_all(&buf[..n]).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        });
        port
    }

    /// A client side with deadlines, so a proxy that never answers fails a
    /// test instead of hanging it.
    fn connect_to_proxy(proxy: &PageProxy) -> TcpStream {
        let stream = TcpStream::connect(("127.0.0.1", proxy.port)).expect("reach the proxy");
        stream
            .set_read_timeout(Some(PATIENCE))
            .expect("set the read timeout");
        stream
            .set_write_timeout(Some(PATIENCE))
            .expect("set the write timeout");
        stream
    }

    /// Read one head off the client side; errors (a timeout above all)
    /// return empty so the assertion on the contents is the thing that
    /// fails, with the emptiness in its own message.
    fn read_reply_head(stream: &mut TcpStream) -> String {
        read_head(stream).unwrap_or_default()
    }

    fn first_line(head: &str) -> &str {
        head.lines().next().unwrap_or_default()
    }

    // ------------------------------------------------------------- the tests

    /// The whole path in one: a CONNECT is resolved by the configured
    /// endpoint (asserted FIRST — it is the discriminating half, and a
    /// mutation to system resolution must fail HERE rather than downstream
    /// on a fetch that could fail for other reasons), greeted with a 200,
    /// carries bytes unchanged in both directions, and counts as a hit.
    #[test]
    fn a_connect_tunnel_resolves_through_doh_carries_bytes_and_counts() {
        let stub = doh_stub(Answer::Loopback);
        let echo_port = echo_server();
        let _serialized = http::lock_policy_for_test();
        http::set_policy(DnsPolicy::Doh(stub.url.clone()));

        let proxy = PageProxy::start(|| {}).expect("the proxy starts");
        let mut client = connect_to_proxy(&proxy);
        client
            .write_all(
                format!(
                    "CONNECT {PROBE_HOST}:{echo_port} HTTP/1.1\r\n\
                     Host: {PROBE_HOST}:{echo_port}\r\n\r\n"
                )
                .as_bytes(),
            )
            .expect("send the CONNECT");

        assert!(
            stub_was_asked(&stub, PROBE_HOST),
            "the page proxy must resolve tunnel hosts through the configured \
             DoH endpoint, but it was never asked for {PROBE_HOST:?}"
        );

        let reply = read_reply_head(&mut client);
        assert_eq!(
            first_line(&reply),
            "HTTP/1.1 200 Connection Established",
            "the tunnel must be greeted with a 200 before any tunneled byte; \
             got {reply:?}"
        );

        const PAYLOAD: &[u8] = b"through the tunnel, byte for byte";
        client.write_all(PAYLOAD).expect("send the payload");
        client
            .shutdown(std::net::Shutdown::Write)
            .expect("end the write side");
        let mut echoed = Vec::new();
        client.read_to_end(&mut echoed).expect("read the echo back");
        assert_eq!(
            echoed, PAYLOAD,
            "the tunnel must carry bytes unchanged in both directions"
        );

        assert_eq!(proxy.hits(), 1, "one carried tunnel must read as one hit");

        http::forget();
        drop(proxy);
    }

    /// The failure path that IS the semantics: a name the endpoint cannot
    /// answer gets a 502, never a system-resolver rescue, and the proxy
    /// takes the next connection — a refusal is not a crash.
    #[test]
    fn a_name_with_no_answer_is_refused_with_502_and_the_proxy_takes_the_next_connection() {
        let stub = doh_stub(Answer::Nothing);
        let _serialized = http::lock_policy_for_test();
        http::set_policy(DnsPolicy::Doh(stub.url.clone()));

        let proxy = PageProxy::start(|| {}).expect("the proxy starts");
        for attempt in 0..2 {
            let mut client = connect_to_proxy(&proxy);
            client
                .write_all(
                    format!(
                        "CONNECT {PROBE_HOST}:443 HTTP/1.1\r\n\
                         Host: {PROBE_HOST}:443\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .expect("send the CONNECT");
            let reply = read_reply_head(&mut client);
            assert!(
                first_line(&reply).starts_with("HTTP/1.1 502"),
                "a name with no address must be refused with 502 (attempt \
                 {attempt}), not tunneled and not a crash; got {reply:?}"
            );
            assert!(
                stub_was_asked(&stub, PROBE_HOST),
                "the refusal must come from the endpoint's own answer — the \
                 proxy asked the configured DoH endpoint, unlike a silent \
                 fallback, which would have answered nothing and nowhere"
            );
        }
        assert_eq!(proxy.hits(), 0, "a refused tunnel is not a hit");

        http::forget();
        drop(proxy);
    }

    /// Plaintext absolute-form: the same resolution, then the request
    /// forwarded verbatim — origin servers must accept absolute-form
    /// (RFC 9110 §7.1, ex 7230 §5.3.2), and rewriting it here would be a
    /// second place with opinions about request shape.
    #[test]
    fn the_connect_greeting_belongs_to_the_client_not_the_target() {
        let stub = doh_stub(Answer::Loopback);
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the target");
        let target_port = listener.local_addr().unwrap().port();
        let (seen_tx, seen_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut target, _) = listener.accept().expect("accept the proxy");
            target
                .set_read_timeout(Some(PATIENCE))
                .expect("bound the target read");
            let mut buf = [0u8; 64];
            let n = target
                .read(&mut buf)
                .expect("read the first tunneled bytes");
            seen_tx
                .send(buf[..n].to_vec())
                .expect("report target bytes");
        });

        let _serialized = http::lock_policy_for_test();
        http::set_policy(DnsPolicy::Doh(stub.url.clone()));
        let proxy = PageProxy::start(|| {}).expect("the proxy starts");
        let mut client = connect_to_proxy(&proxy);
        client
            .write_all(format!("CONNECT {PROBE_HOST}:{target_port} HTTP/1.1\r\n\r\n").as_bytes())
            .expect("send CONNECT");
        let greeting = read_reply_head(&mut client);
        assert_eq!(
            greeting, CONNECT_ESTABLISHED,
            "the proxy client must receive the CONNECT greeting"
        );
        client
            .write_all(b"first-client-payload")
            .expect("send payload");
        let target_first = seen_rx
            .recv_timeout(PATIENCE)
            .expect("the target receives the client payload");
        assert_eq!(
            target_first, b"first-client-payload",
            "the target's first byte must be the tunneled client's — never the proxy's 200 greeting"
        );

        http::forget();
        drop(proxy);
    }

    #[test]
    fn an_absolute_form_request_is_forwarded_as_origin_form() {
        let stub = doh_stub(Answer::Loopback);
        let echo_port = echo_server();
        let _serialized = http::lock_policy_for_test();
        http::set_policy(DnsPolicy::Doh(stub.url.clone()));

        let proxy = PageProxy::start(|| {}).expect("the proxy starts");
        let mut client = connect_to_proxy(&proxy);
        client
            .write_all(
                format!(
                    "GET http://{PROBE_HOST}:{echo_port}/round-trip HTTP/1.1\r\n\
                     Host: {PROBE_HOST}:{echo_port}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .expect("send the request");
        client
            .shutdown(std::net::Shutdown::Write)
            .expect("end the write side");

        assert!(
            stub_was_asked(&stub, PROBE_HOST),
            "an absolute-form request must be resolved through the \
             configured DoH endpoint too"
        );

        let mut all = Vec::new();
        client.read_to_end(&mut all).expect("read the echo back");
        let text = String::from_utf8_lossy(&all);
        assert!(
            text.contains("GET /round-trip HTTP/1.1"),
            "the origin must hear an origin-form request line; got {text:?}"
        );
        assert!(
            text.contains(&format!("Host: {PROBE_HOST}:{echo_port}")),
            "the Host header must name the authority; got {text:?}"
        );
        assert!(
            !text.contains("GET http://"),
            "the absolute-form line must not survive the proxy; got {text:?}"
        );
        assert_eq!(proxy.hits(), 1, "a forwarded request counts as one hit");

        http::forget();
        drop(proxy);
    }

    /// The 400 half of the plaintext rule: a request with no host to aim is
    /// refused, not guessed at.
    #[test]
    fn a_relative_form_request_is_refused_with_400() {
        let proxy = PageProxy::start(|| {}).expect("the proxy starts");
        let mut client = connect_to_proxy(&proxy);
        client
            .write_all(b"GET /only/a/path HTTP/1.1\r\nHost: nothing\r\n\r\n")
            .expect("send the request");
        let reply = read_reply_head(&mut client);
        assert!(
            first_line(&reply).starts_with("HTTP/1.1 400"),
            "a relative-form request names no host to forward to; got {reply:?}"
        );
        assert_eq!(proxy.hits(), 0, "a refused request is not a hit");
    }

    /// The authority parser, on the shapes a real client sends.
    #[test]
    fn authorities_split_into_host_and_port() {
        assert_eq!(
            split_authority("example.com:8443", 443),
            Some(("example.com".into(), 8443))
        );
        assert_eq!(
            split_authority("example.com", 443),
            Some(("example.com".into(), 443))
        );
        assert_eq!(
            split_authority("example.com", 80),
            Some(("example.com".into(), 80))
        );
        assert_eq!(
            split_authority("[2001:db8::1]:443", 443),
            Some(("2001:db8::1".into(), 443))
        );
        assert_eq!(split_authority("example.com:notaport", 443), None);
        assert_eq!(
            absolute_form("http://example.com:8080/x?y"),
            Some(("example.com:8080", 80))
        );
        assert_eq!(
            absolute_form("https://example.com/#frag"),
            Some(("example.com", 443))
        );
        assert_eq!(absolute_form("/relative/only"), None);
    }

    #[test]
    fn the_health_probe_says_alive_while_parked_and_dead_after_stop() {
        let mut proxy = PageProxy::start(|| {}).expect("the proxy starts");
        assert!(
            proxy.is_alive(),
            "a proxy whose accept thread is parked waiting for connections \
             is alive — being blocked in accept is the job, not death"
        );
        proxy.stop();
        assert!(
            !proxy.is_alive(),
            "after stop() the proxy must report dead: the port is closed, and \
             a new tab pointed here would resolve nothing"
        );
    }
    #[test]
    fn a_half_written_head_is_given_back_at_the_deadline_not_kept_forever() {
        let _serialized = http::lock_policy_for_test();
        http::set_policy(DnsPolicy::System);
        let proxy = PageProxy::start(|| {}).expect("the proxy starts");

        // Half a head and then silence: the connection neither finishes its
        // request nor closes. Without the read deadline this parks a
        // connection thread forever; with it, the socket errors and the
        // thread returns. The test holds its side open the whole while, so
        // the ONLY way the proxy side closes is the deadline firing.
        let mut client = connect_to_proxy(&proxy);
        client
            .set_read_timeout(None)
            .expect("the client waits, not times");
        client
            .write_all(b"CONNECT half.example:443 HTTP/1.1\r\n")
            .expect("send the half head");

        let started = Instant::now();
        let mut saw_close = false;
        let mut probe = [0u8; 1];
        while Instant::now() - started < HEAD_DEADLINE + PATIENCE {
            match client.read(&mut probe) {
                Ok(0) | Err(_) => {
                    saw_close = true;
                    break;
                }
                Ok(_) => continue,
            }
        }
        assert!(
            saw_close,
            "a connection holding a half-written head must be closed at the \
             deadline, not parked forever holding a thread"
        );
    }

    #[test]
    fn a_tunnel_that_goes_silent_is_reaped_at_the_idle_deadline() {
        let _serialized = http::lock_policy_for_test();
        http::set_policy(DnsPolicy::System);
        let proxy = PageProxy::start(|| {}).expect("the proxy starts");
        // A target that accepts and then says nothing: a peer that went
        // quiet mid-conversation, the shape a vanished client leaves.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the silent target");
        let target_port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept the tunnel");
            // Hold the socket open without ever reading or writing — the
            // far side of a silent tunnel.
            let _held = stream;
            loop {
                std::thread::sleep(PATIENCE);
            }
        });

        let mut client = connect_to_proxy(&proxy);
        client
            .set_read_timeout(None)
            .expect("the client waits, not times");
        client
            .write_all(format!("CONNECT 127.0.0.1:{target_port} HTTP/1.1\r\n\r\n").as_bytes())
            .expect("send CONNECT");
        let greeting = read_reply_head(&mut client);
        assert!(
            greeting.starts_with("HTTP/1.1 200"),
            "the tunnel must establish before it can go silent: got {greeting:?}"
        );

        // Both sides hold their sockets and say nothing. Only the idle
        // deadline can end this; without it the pump threads park forever.
        let started = Instant::now();
        let mut saw_close = false;
        let mut probe = [0u8; 1];
        while Instant::now() - started < TUNNEL_IDLE + PATIENCE {
            match client.read(&mut probe) {
                Ok(0) | Err(_) => {
                    saw_close = true;
                    break;
                }
                Ok(_) => continue,
            }
        }
        assert!(
            saw_close,
            "a tunnel silent on both sides must be reaped at the idle \
             deadline, not parked forever holding two threads and two sockets"
        );
    }
}
