use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::network_broker::{self, TargetPolicy};
use crate::page_proxy;
use base64::Engine as _;
use tabverse_proto::Access;
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

/// http-stream-v2 request and response limits. They are stream budgets, not
/// buffering targets: request bytes are assembled before dispatch, while a
/// response is emitted in fixed chunks under viewer-issued credit.
const MAX_STREAM_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_STREAM_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const RESPONSE_CHUNK_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_CREDIT: u64 = 8 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;
const FLOW_WAIT: Duration = Duration::from_secs(30);
const GRANT_LIFETIME: Duration = Duration::from_secs(10 * 60);
const RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_STREAMS_PER_VIEWER: usize = 4;
const MAX_STREAMS_PER_SHARE: usize = 16;
const MAX_OPENS_PER_WINDOW: u32 = 60;
const MAX_BYTES_PER_VIEWER_WINDOW: u64 = 256 * 1024 * 1024;

type ResolveHost = Arc<dyn Fn(&str, u16) -> Result<Vec<SocketAddr>, String> + Send + Sync>;

fn origin_of(url: &reqwest::Url) -> Result<String, String> {
    let host = url.host_str().ok_or("invalid-target: URL has no host")?;
    let port = url
        .port_or_known_default()
        .ok_or("invalid-target: URL has no effective port")?;
    Ok(format!(
        "{}://{}:{port}",
        url.scheme(),
        host.to_ascii_lowercase()
    ))
}

fn target_hash(url: &reqwest::Url) -> String {
    let mut hasher = DefaultHasher::new();
    origin_of(url).unwrap_or_default().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkAuditEvent {
    pub action: &'static str,
    pub outcome: &'static str,
    pub share_id: String,
    pub viewer: u64,
    pub attachment_generation: u64,
    pub tab_id: String,
    pub stream_id: u64,
    pub target_hash: String,
    pub bytes: u64,
    pub code: String,
}

#[derive(Debug, Clone)]
struct TabGrantScope {
    origin: String,
}

#[derive(Debug, Clone)]
struct NetworkGrant {
    grant_id: String,
    share_id: String,
    viewer: u64,
    attachment_id: String,
    attachment_generation: u64,
    tab_id: String,
    origin: String,
    method: String,
    pinned_addrs: Vec<SocketAddr>,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct ViewerBudget {
    started_at: Instant,
    opens: u32,
    bytes: u64,
}

impl ViewerBudget {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            opens: 0,
            bytes: 0,
        }
    }

    fn refresh(&mut self) {
        if self.started_at.elapsed() >= RATE_WINDOW {
            *self = Self::new();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserEvent {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
        final_url: String,
    },
    Chunk {
        seq: u64,
        b64: String,
    },
    End,
    Error {
        code: String,
        message: String,
    },
}

pub type BrowserResponseSink = Arc<dyn Fn(BrowserEvent) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct ResidentBrowserRequest {
    pub request_id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body_b64: Option<String>,
    pub grant_origin: String,
    pub grant_expires_at_ms: u64,
    pub pinned_addrs: Vec<String>,
    pub cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidentBrowserResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub type ResidentBrowserExchange = Arc<
    dyn Fn(&str, ResidentBrowserRequest) -> Option<Result<ResidentBrowserResponse, String>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct StreamKey {
    viewer: u64,
    stream_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CookieKey {
    viewer: u64,
    attachment_generation: u64,
    tab_id: String,
    origin: String,
}

struct FlowState {
    cancelled: Arc<AtomicBool>,
    credit: Mutex<u64>,
    wake: Condvar,
}

impl FlowState {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            credit: Mutex::new(0),
            wake: Condvar::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.wake.notify_all();
    }

    fn grant(&self, bytes: u64) {
        let mut credit = self.credit.lock().unwrap_or_else(|e| e.into_inner());
        *credit = credit.saturating_add(bytes).min(MAX_RESPONSE_CREDIT);
        self.wake.notify_all();
    }

    fn claim(&self, bytes: usize) -> Result<(), String> {
        let started = Instant::now();
        let mut credit = self.credit.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return Err("request cancelled".into());
            }
            if *credit >= bytes as u64 {
                *credit -= bytes as u64;
                return Ok(());
            }
            let left = FLOW_WAIT
                .checked_sub(started.elapsed())
                .ok_or_else(|| "response backpressure window timed out".to_string())?;
            let waited = self
                .wake
                .wait_timeout(credit, left)
                .unwrap_or_else(|e| e.into_inner());
            credit = waited.0;
            if waited.1.timed_out() {
                return Err("response backpressure window timed out".into());
            }
        }
    }
}

struct PendingRequest {
    tab_id: String,
    attachment_generation: u64,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body_len: Option<u64>,
    body: Vec<u8>,
    next_seq: u64,
    ended: bool,
    flow: Arc<FlowState>,
    grant: NetworkGrant,
}

pub struct BrowserExecution {
    key: StreamKey,
    tab_id: String,
    attachment_generation: u64,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    flow: Arc<FlowState>,
    grant: NetworkGrant,
}

/// The host-owned request router. One instance belongs to one live share
/// source, so cookie and stream state can never cross shares. Viewer id,
/// tab id and attachment generation remain in every key inside that source.
pub struct BrowserRequestRouter {
    requests: Mutex<HashMap<StreamKey, PendingRequest>>,
    cookies: Mutex<HashMap<CookieKey, HashMap<String, String>>>,
    share_id: Mutex<Option<String>>,
    tab_scopes: Mutex<HashMap<String, TabGrantScope>>,
    budgets: Mutex<HashMap<u64, ViewerBudget>>,
    attachments: Mutex<HashMap<u64, (String, u64)>>,
    audit: Mutex<Vec<NetworkAuditEvent>>,
    resolver: ResolveHost,
}

impl Default for BrowserRequestRouter {
    fn default() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            cookies: Mutex::new(HashMap::new()),
            share_id: Mutex::new(None),
            tab_scopes: Mutex::new(HashMap::new()),
            budgets: Mutex::new(HashMap::new()),
            attachments: Mutex::new(HashMap::new()),
            audit: Mutex::new(Vec::new()),
            resolver: Arc::new(network_broker::system_resolve),
        }
    }
}

impl BrowserRequestRouter {
    pub fn bind_share(&self, share_id: String) {
        let changed = self
            .share_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|current| current != &share_id);
        if changed {
            self.clear();
        }
        *self.share_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(share_id);
    }

    pub fn sync_authorized_tabs(&self, tabs: Vec<(String, String)>) {
        let next = tabs
            .into_iter()
            .filter_map(|(tab_id, raw_url)| {
                let url = reqwest::Url::parse(&raw_url).ok()?;
                if !matches!(url.scheme(), "http" | "https") {
                    return None;
                }
                let origin = origin_of(&url).ok()?;
                Some((tab_id, TabGrantScope { origin }))
            })
            .collect::<HashMap<_, _>>();
        let changed = {
            let current = self.tab_scopes.lock().unwrap_or_else(|e| e.into_inner());
            current
                .iter()
                .filter_map(|(tab_id, scope)| {
                    (next.get(tab_id).map(|next| &next.origin) != Some(&scope.origin))
                        .then_some(tab_id.clone())
                })
                .collect::<HashSet<_>>()
        };
        for tab_id in changed {
            self.revoke_tab(&tab_id);
        }
        *self.tab_scopes.lock().unwrap_or_else(|e| e.into_inner()) = next;
    }

    pub fn authorize_tab(&self, tab_id: String, url: String) -> Result<(), String> {
        let parsed = reqwest::Url::parse(&url).map_err(|_| "invalid grant URL")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("unsupported-scheme: Browser grant carries HTTP(S) only".into());
        }
        let scope = TabGrantScope {
            origin: origin_of(&parsed)?,
        };
        let changed = self
            .tab_scopes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&tab_id)
            .is_some_and(|current| current.origin != scope.origin);
        if changed {
            self.cancel_tab(&tab_id, "grant-scope-changed");
        }
        self.tab_scopes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(tab_id, scope);
        Ok(())
    }

    pub fn bind_attachment(
        &self,
        viewer: u64,
        attachment_id: String,
        attachment_generation: u64,
    ) -> Result<(), String> {
        if attachment_id != format!("attachment-{viewer}") || attachment_generation == 0 {
            return Err("grant-owner-mismatch: invalid attachment identity".into());
        }
        let previous = self
            .attachments
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&viewer)
            .cloned();
        if let Some((current_id, current_generation)) = &previous {
            if attachment_generation < *current_generation
                || (attachment_generation == *current_generation && attachment_id != *current_id)
            {
                return Err("grant-owner-mismatch: stale attachment generation".into());
            }
        }
        if previous
            .as_ref()
            .is_some_and(|current| current != &(attachment_id.clone(), attachment_generation))
        {
            self.cancel_viewer(viewer);
        }
        self.attachments
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(viewer, (attachment_id, attachment_generation));
        Ok(())
    }

    pub fn revoke_tab(&self, tab_id: &str) {
        self.tab_scopes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tab_id);
        self.cancel_tab(tab_id, "grant-revoked");
        self.cookies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| key.tab_id != tab_id);
    }

    fn cancel_tab(&self, tab_id: &str, code: &str) {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        requests.retain(|key, pending| {
            if pending.tab_id != tab_id {
                return true;
            }
            pending.flow.cancel();
            self.record_audit(
                "revoke",
                "denied",
                &pending.grant,
                key.stream_id,
                0,
                code,
                None,
            );
            false
        });
    }

    pub(crate) fn expected_grant_id(
        attachment_id: &str,
        attachment_generation: u64,
        tab_id: &str,
    ) -> String {
        format!("browser-grant-v1:{attachment_id}:{attachment_generation}:{tab_id}")
    }

    fn resolve_target(&self, url: &reqwest::Url) -> Result<Vec<SocketAddr>, String> {
        let host = url.host_str().ok_or("invalid-target: URL has no host")?;
        let port = url
            .port_or_known_default()
            .ok_or("invalid-target: URL has no effective port")?;
        network_broker::approve_addresses(
            (self.resolver)(host, port)?,
            port,
            TargetPolicy::RemoteGrant,
        )
    }

    fn validate_grant(&self, grant: &NetworkGrant, url: &reqwest::Url) -> Result<(), String> {
        if grant.expires_at <= Instant::now() {
            return Err("grant-expired: NetworkGrant expired".into());
        }
        let share_id = self
            .share_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or("grant-unbound: Browser router has no live share")?;
        if share_id != grant.share_id {
            return Err("grant-owner-mismatch: share changed".into());
        }
        let scope = self
            .tab_scopes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&grant.tab_id)
            .cloned()
            .ok_or("grant-revoked: Browser Tab is no longer shared")?;
        let origin = origin_of(url)?;
        if origin != grant.origin || origin != scope.origin {
            return Err("origin-denied: target origin is outside the NetworkGrant".into());
        }
        if grant.grant_id
            != Self::expected_grant_id(
                &grant.attachment_id,
                grant.attachment_generation,
                &grant.tab_id,
            )
        {
            return Err("grant-owner-mismatch: grant id does not match owner".into());
        }
        Ok(())
    }

    fn charge_open(&self, viewer: u64) -> Result<(), String> {
        let mut budgets = self.budgets.lock().unwrap_or_else(|e| e.into_inner());
        let budget = budgets.entry(viewer).or_insert_with(ViewerBudget::new);
        budget.refresh();
        if budget.opens >= MAX_OPENS_PER_WINDOW {
            return Err("rate-limited: Browser request rate exceeded".into());
        }
        budget.opens += 1;
        Ok(())
    }

    fn charge_bytes(&self, viewer: u64, bytes: usize) -> Result<(), String> {
        let mut budgets = self.budgets.lock().unwrap_or_else(|e| e.into_inner());
        let budget = budgets.entry(viewer).or_insert_with(ViewerBudget::new);
        budget.refresh();
        let next = budget.bytes.saturating_add(bytes as u64);
        if next > MAX_BYTES_PER_VIEWER_WINDOW {
            return Err("budget-exceeded: Browser transfer window exceeded".into());
        }
        budget.bytes = next;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn record_audit(
        &self,
        action: &'static str,
        outcome: &'static str,
        grant: &NetworkGrant,
        stream_id: u64,
        bytes: u64,
        code: &str,
        url: Option<&reqwest::Url>,
    ) {
        let event = NetworkAuditEvent {
            action,
            outcome,
            share_id: grant.share_id.clone(),
            viewer: grant.viewer,
            attachment_generation: grant.attachment_generation,
            tab_id: grant.tab_id.clone(),
            stream_id,
            target_hash: url.map(target_hash).unwrap_or_default(),
            bytes,
            code: code.to_string(),
        };
        eprintln!(
            "[browser-audit] action={} outcome={} share={} viewer={} generation={} tab={} stream={} targetHash={} bytes={} code={}",
            event.action,
            event.outcome,
            event.share_id,
            event.viewer,
            event.attachment_generation,
            event.tab_id,
            event.stream_id,
            event.target_hash,
            event.bytes,
            event.code,
        );
        self.audit
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(event);
    }

    #[cfg(test)]
    fn with_resolver(resolver: ResolveHost) -> Self {
        Self {
            resolver,
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn audit_events(&self) -> Vec<NetworkAuditEvent> {
        self.audit.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &self,
        viewer: u64,
        stream_id: u64,
        tab_id: String,
        grant_id: String,
        attachment_id: String,
        attachment_generation: u64,
        access: Access,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body_len: Option<u64>,
    ) -> Result<(), String> {
        let audit_grant = NetworkGrant {
            grant_id: grant_id.clone(),
            share_id: self
                .share_id
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .unwrap_or_else(|| "unbound".into()),
            viewer,
            attachment_id: attachment_id.clone(),
            attachment_generation,
            tab_id: tab_id.clone(),
            origin: reqwest::Url::parse(&url)
                .ok()
                .and_then(|url| origin_of(&url).ok())
                .unwrap_or_default(),
            method: method.clone(),
            pinned_addrs: Vec::new(),
            expires_at: Instant::now() + GRANT_LIFETIME,
        };
        let parsed = reqwest::Url::parse(&url).ok();
        let result = self.open_checked(
            viewer,
            stream_id,
            tab_id,
            grant_id,
            attachment_id,
            attachment_generation,
            access,
            method,
            url,
            headers,
            body_len,
        );
        if let Err(error) = &result {
            let code = error.split(':').next().unwrap_or("open-denied");
            self.record_audit(
                "open",
                "denied",
                &audit_grant,
                stream_id,
                0,
                code,
                parsed.as_ref(),
            );
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn open_checked(
        &self,
        viewer: u64,
        stream_id: u64,
        tab_id: String,
        grant_id: String,
        attachment_id: String,
        attachment_generation: u64,
        access: Access,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body_len: Option<u64>,
    ) -> Result<(), String> {
        let parsed = reqwest::Url::parse(&url).map_err(|_| "invalid request URL")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("unsupported-scheme: Browser A carries HTTP(S) only".into());
        }
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| "invalid HTTP method")?
            .as_str()
            .to_string();
        let supported_method = matches!(
            method.as_str(),
            "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
        );
        if !supported_method {
            return Err("method-denied: method is outside the Browser grant".into());
        }
        if !access.may_steer() && !matches!(method.as_str(), "GET" | "HEAD") {
            return Err("access-denied: view access permits GET and HEAD only".into());
        }
        if body_len.is_some_and(|size| size > MAX_STREAM_REQUEST_BYTES as u64) {
            return Err("request-too-large: request body exceeds stream budget".into());
        }
        if headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("upgrade")
                || (name.eq_ignore_ascii_case("connection")
                    && value.to_ascii_lowercase().contains("upgrade"))
        }) {
            return Err("unsupported-websocket: protocol upgrades are not Browser A".into());
        }
        let expected_attachment = self
            .attachments
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&viewer)
            .cloned();
        if expected_attachment.as_ref() != Some(&(attachment_id.clone(), attachment_generation)) {
            return Err("grant-owner-mismatch: attachment does not belong to viewer".into());
        }
        if grant_id != Self::expected_grant_id(&attachment_id, attachment_generation, &tab_id) {
            return Err("grant-owner-mismatch: grant id does not match owner".into());
        }
        let share_id = self
            .share_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or("grant-unbound: Browser router has no live share")?;
        let scope = self
            .tab_scopes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&tab_id)
            .cloned()
            .ok_or("grant-denied: Browser Tab is not in the host-authorized Tab set")?;
        let origin = origin_of(&parsed)?;
        if origin != scope.origin {
            return Err("origin-denied: target origin is outside the NetworkGrant".into());
        }
        let key = StreamKey { viewer, stream_id };
        {
            let requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
            if requests.contains_key(&key) {
                return Err("duplicate stream id".into());
            }
            if requests.len() >= MAX_STREAMS_PER_SHARE {
                return Err("concurrency-limited: share Browser stream limit reached".into());
            }
            if requests.keys().filter(|key| key.viewer == viewer).count() >= MAX_STREAMS_PER_VIEWER
            {
                return Err("concurrency-limited: viewer Browser stream limit reached".into());
            }
        }
        self.charge_open(viewer)?;
        let pinned_addrs = self.resolve_target(&parsed)?;
        let grant = NetworkGrant {
            grant_id,
            share_id,
            viewer,
            attachment_id,
            attachment_generation,
            tab_id: tab_id.clone(),
            origin,
            method: method.clone(),
            pinned_addrs,
            expires_at: Instant::now() + GRANT_LIFETIME,
        };
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        if requests.contains_key(&key) {
            return Err("duplicate stream id".into());
        }
        if requests.len() >= MAX_STREAMS_PER_SHARE {
            return Err("concurrency-limited: share Browser stream limit reached".into());
        }
        if requests.keys().filter(|key| key.viewer == viewer).count() >= MAX_STREAMS_PER_VIEWER {
            return Err("concurrency-limited: viewer Browser stream limit reached".into());
        }
        requests.insert(
            key.clone(),
            PendingRequest {
                tab_id,
                attachment_generation,
                method,
                url,
                headers,
                body_len,
                body: Vec::new(),
                next_seq: 0,
                ended: false,
                flow: Arc::new(FlowState::new()),
                grant: grant.clone(),
            },
        );
        drop(requests);
        self.record_audit(
            "open",
            "allowed",
            &grant,
            key.stream_id,
            0,
            "ok",
            Some(&parsed),
        );
        Ok(())
    }

    pub fn request_chunk(
        &self,
        viewer: u64,
        stream_id: u64,
        seq: u64,
        b64: &str,
    ) -> Result<(), String> {
        let key = StreamKey { viewer, stream_id };
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        let pending = requests.get_mut(&key).ok_or("unknown browser stream")?;
        let parsed = reqwest::Url::parse(&pending.url).map_err(|_| "invalid request URL")?;
        self.validate_grant(&pending.grant, &parsed)?;
        if pending.ended {
            return Err("request body already ended".into());
        }
        if seq != pending.next_seq {
            return Err(format!(
                "request chunk gap: expected {}, got {seq}",
                pending.next_seq
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| "invalid request chunk base64")?;
        if pending.body.len().saturating_add(bytes.len()) > MAX_STREAM_REQUEST_BYTES {
            return Err("request-too-large: request body exceeds stream budget".into());
        }
        self.charge_bytes(viewer, bytes.len())?;
        pending.body.extend_from_slice(&bytes);
        pending.next_seq += 1;
        Ok(())
    }

    pub fn request_end(&self, viewer: u64, stream_id: u64) -> Result<BrowserExecution, String> {
        let key = StreamKey { viewer, stream_id };
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        let pending = requests.get_mut(&key).ok_or("unknown browser stream")?;
        let parsed = reqwest::Url::parse(&pending.url).map_err(|_| "invalid request URL")?;
        self.validate_grant(&pending.grant, &parsed)?;
        if pending.ended {
            return Err("request body already ended".into());
        }
        if pending
            .body_len
            .is_some_and(|size| size != pending.body.len() as u64)
        {
            return Err("request body length mismatch".into());
        }
        pending.ended = true;
        Ok(BrowserExecution {
            key,
            tab_id: pending.tab_id.clone(),
            attachment_generation: pending.attachment_generation,
            method: pending.method.clone(),
            url: pending.url.clone(),
            headers: pending.headers.clone(),
            body: pending.body.clone(),
            flow: Arc::clone(&pending.flow),
            grant: pending.grant.clone(),
        })
    }

    pub fn credit(&self, viewer: u64, stream_id: u64, bytes: u64) -> Result<(), String> {
        if bytes == 0 {
            return Err("response credit must be positive".into());
        }
        let requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        let pending = requests
            .get(&StreamKey { viewer, stream_id })
            .ok_or("unknown browser stream")?;
        pending.flow.grant(bytes);
        Ok(())
    }

    pub fn cancel(&self, viewer: u64, stream_id: u64) {
        if let Some(pending) = self
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&StreamKey { viewer, stream_id })
        {
            pending.flow.cancel();
        }
    }

    pub fn cancel_viewer(&self, viewer: u64) {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        requests.retain(|key, pending| {
            if key.viewer != viewer {
                return true;
            }
            pending.flow.cancel();
            false
        });
        self.cookies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| key.viewer != viewer);
        self.budgets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&viewer);
        self.attachments
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&viewer);
    }

    pub fn clear(&self) {
        let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        for pending in requests.values() {
            pending.flow.cancel();
        }
        requests.clear();
        self.cookies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.tab_scopes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.budgets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.attachments
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        *self.share_id.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn execute(self: &Arc<Self>, execution: BrowserExecution, sink: BrowserResponseSink) {
        let outcome = tauri::async_runtime::block_on(self.execute_async(&execution, &sink));
        self.finish_execution(&execution, &sink, outcome);
    }

    pub fn execute_resident_or_local(
        self: &Arc<Self>,
        execution: BrowserExecution,
        sink: BrowserResponseSink,
        exchange: ResidentBrowserExchange,
    ) {
        let outcome = match self.execute_resident(&execution, &sink, &exchange) {
            None => tauri::async_runtime::block_on(self.execute_async(&execution, &sink)),
            Some(outcome) => outcome,
        };
        self.finish_execution(&execution, &sink, outcome);
    }

    fn finish_execution(
        &self,
        execution: &BrowserExecution,
        sink: &BrowserResponseSink,
        outcome: Result<(), String>,
    ) {
        if let Err(message) = outcome {
            let code = if execution.flow.cancelled.load(Ordering::Acquire) {
                "cancelled"
            } else if message.starts_with("unsupported-") {
                message.split(':').next().unwrap_or("unsupported")
            } else if message.starts_with("response-too-large") {
                "response-too-large"
            } else if message.contains("backpressure") {
                "backpressure-timeout"
            } else if let Some((prefix, _)) = message.split_once(':') {
                if !prefix.contains(char::is_whitespace) {
                    prefix
                } else {
                    "network-error"
                }
            } else {
                "network-error"
            };
            let url = reqwest::Url::parse(&execution.url).ok();
            self.record_audit(
                "execute",
                "denied",
                &execution.grant,
                execution.key.stream_id,
                0,
                code,
                url.as_ref(),
            );
            sink(BrowserEvent::Error {
                code: code.into(),
                message,
            });
        }
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&execution.key);
    }

    fn execute_resident(
        &self,
        execution: &BrowserExecution,
        sink: &BrowserResponseSink,
        exchange: &ResidentBrowserExchange,
    ) -> Option<Result<(), String>> {
        let mut method = match reqwest::Method::from_bytes(execution.method.as_bytes()) {
            Ok(method) => method,
            Err(error) => return Some(Err(format!("method failed: {error}"))),
        };
        let mut url = match reqwest::Url::parse(&execution.url) {
            Ok(url) => url,
            Err(error) => return Some(Err(format!("URL failed: {error}"))),
        };
        let mut body = execution.body.clone();

        for redirect_count in 0..=MAX_REDIRECTS {
            if execution.flow.cancelled.load(Ordering::Acquire) {
                return Some(Err("request cancelled".into()));
            }
            if let Err(error) = self.validate_grant(&execution.grant, &url) {
                return Some(Err(error));
            }
            if method.as_str() != execution.grant.method && method != reqwest::Method::GET {
                return Some(Err(
                    "method-denied: redirect changed method outside grant".into()
                ));
            }
            let addrs = match self.resolve_target(&url) {
                Ok(addrs) => addrs,
                Err(error) => return Some(Err(error)),
            };
            if addrs != execution.grant.pinned_addrs {
                return Some(Err(
                    "dns-rebind-denied: resolved address set changed after grant".into(),
                ));
            }
            let mut headers = execution
                .headers
                .iter()
                .filter(|(name, _)| {
                    !name.eq_ignore_ascii_case("host")
                        && !name.eq_ignore_ascii_case("content-length")
                        && !name.eq_ignore_ascii_case("connection")
                        && !name.eq_ignore_ascii_case("proxy-connection")
                        && !name.eq_ignore_ascii_case("cookie")
                })
                .cloned()
                .collect::<Vec<_>>();
            if let Some(cookie) = self.cookie_header(execution, &url) {
                headers.push(("cookie".into(), cookie));
            }
            let expires_at = std::time::SystemTime::now()
                + execution
                    .grant
                    .expires_at
                    .saturating_duration_since(Instant::now());
            let request = ResidentBrowserRequest {
                request_id: format!("browser-{:032x}", rand::random::<u128>()),
                method: method.as_str().to_string(),
                url: url.to_string(),
                headers,
                body_b64: (!body.is_empty())
                    .then(|| base64::engine::general_purpose::STANDARD.encode(&body)),
                grant_origin: execution.grant.origin.clone(),
                grant_expires_at_ms: expires_at
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                pinned_addrs: addrs.iter().map(ToString::to_string).collect(),
                cancelled: Arc::clone(&execution.flow.cancelled),
            };
            let response = match exchange(&execution.tab_id, request) {
                None if redirect_count == 0 => return None,
                None => {
                    return Some(Err(
                        "resident-runtime-lost: Browser worker disappeared".into()
                    ))
                }
                Some(Err(error)) => return Some(Err(error)),
                Some(Ok(response)) => response,
            };
            let mut response_headers = reqwest::header::HeaderMap::new();
            for (name, value) in &response.headers {
                let Ok(name) = reqwest::header::HeaderName::from_bytes(name.as_bytes()) else {
                    continue;
                };
                let Ok(value) = reqwest::header::HeaderValue::from_str(value) else {
                    continue;
                };
                response_headers.append(name, value);
            }
            self.store_response_cookies(execution, &url, &response_headers);
            let status = match reqwest::StatusCode::from_u16(response.status) {
                Ok(status) => status,
                Err(_) => return Some(Err("network-error: invalid resident status".into())),
            };
            if status.is_redirection() {
                let location = match response_headers
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                {
                    Some(location) => location,
                    None => return Some(Err("redirect response had no valid Location".into())),
                };
                if redirect_count == MAX_REDIRECTS {
                    return Some(Err("too many redirects".into()));
                }
                url = match url.join(location) {
                    Ok(url) => url,
                    Err(error) => return Some(Err(format!("redirect URL failed: {error}"))),
                };
                if !matches!(url.scheme(), "http" | "https") {
                    return Some(Err("unsupported-scheme: redirect left HTTP(S)".into()));
                }
                if status == reqwest::StatusCode::SEE_OTHER
                    || ((status == reqwest::StatusCode::MOVED_PERMANENTLY
                        || status == reqwest::StatusCode::FOUND)
                        && method == reqwest::Method::POST)
                {
                    method = reqwest::Method::GET;
                    body.clear();
                }
                continue;
            }
            if response_headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/event-stream"))
            {
                return Some(Err(
                    "unsupported-sse: server-sent events are not enabled".into()
                ));
            }
            if response_headers
                .get_all(reqwest::header::WWW_AUTHENTICATE)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .any(|value| {
                    let lower = value.to_ascii_lowercase();
                    lower.starts_with("negotiate") || lower.starts_with("ntlm")
                })
            {
                return Some(Err(
                    "unsupported-integrated-auth: Kerberos and NTLM are not enabled".into(),
                ));
            }
            let headers = response_headers
                .iter()
                .filter(|(name, _)| {
                    !name.as_str().eq_ignore_ascii_case("set-cookie")
                        && !name.as_str().eq_ignore_ascii_case("transfer-encoding")
                        && !name.as_str().eq_ignore_ascii_case("connection")
                })
                .map(|(name, value)| {
                    (
                        name.as_str().to_string(),
                        String::from_utf8_lossy(value.as_bytes()).into_owned(),
                    )
                })
                .collect();
            sink(BrowserEvent::Head {
                status: response.status,
                headers,
                final_url: url.to_string(),
            });
            if method == reqwest::Method::HEAD {
                sink(BrowserEvent::End);
                return Some(Ok(()));
            }
            let mut total = 0usize;
            for (seq, part) in response.body.chunks(RESPONSE_CHUNK_BYTES).enumerate() {
                total = total.saturating_add(part.len());
                if total > MAX_STREAM_RESPONSE_BYTES {
                    return Some(Err(
                        "response-too-large: response exceeds stream budget".into()
                    ));
                }
                if let Err(error) = self.validate_grant(&execution.grant, &url) {
                    return Some(Err(error));
                }
                if let Err(error) = self.charge_bytes(execution.key.viewer, part.len()) {
                    return Some(Err(error));
                }
                if let Err(error) = execution.flow.claim(part.len()) {
                    return Some(Err(error));
                }
                sink(BrowserEvent::Chunk {
                    seq: seq as u64,
                    b64: base64::engine::general_purpose::STANDARD.encode(part),
                });
            }
            sink(BrowserEvent::End);
            self.record_audit(
                "response",
                "allowed",
                &execution.grant,
                execution.key.stream_id,
                total as u64,
                "ok",
                Some(&url),
            );
            return Some(Ok(()));
        }
        Some(Err("too many redirects".into()))
    }

    async fn execute_async(
        &self,
        execution: &BrowserExecution,
        sink: &BrowserResponseSink,
    ) -> Result<(), String> {
        self.execute_with_client_factory(execution, sink, |host, addrs| {
            crate::http::build_browser_stream_pinned(host, addrs)
                .map_err(|error| format!("HTTP client failed: {error}"))
        })
        .await
    }

    #[cfg(test)]
    async fn execute_with_client(
        &self,
        execution: &BrowserExecution,
        sink: &BrowserResponseSink,
        client: &reqwest::Client,
    ) -> Result<(), String> {
        self.execute_with_client_factory(execution, sink, |_host, _addrs| Ok(client.clone()))
            .await
    }

    async fn execute_with_client_factory<F>(
        &self,
        execution: &BrowserExecution,
        sink: &BrowserResponseSink,
        client_for: F,
    ) -> Result<(), String>
    where
        F: Fn(&str, &[SocketAddr]) -> Result<reqwest::Client, String>,
    {
        let mut method = reqwest::Method::from_bytes(execution.method.as_bytes())
            .map_err(|error| format!("method failed: {error}"))?;
        let mut url =
            reqwest::Url::parse(&execution.url).map_err(|error| format!("URL failed: {error}"))?;
        let mut body = execution.body.clone();

        for redirect_count in 0..=MAX_REDIRECTS {
            if execution.flow.cancelled.load(Ordering::Acquire) {
                return Err("request cancelled".into());
            }
            self.validate_grant(&execution.grant, &url)?;
            if method.as_str() != execution.grant.method && method != reqwest::Method::GET {
                return Err("method-denied: redirect changed method outside grant".into());
            }
            let addrs = self.resolve_target(&url)?;
            if addrs != execution.grant.pinned_addrs {
                return Err("dns-rebind-denied: resolved address set changed after grant".into());
            }
            let host = url.host_str().ok_or("invalid-target: URL has no host")?;
            let client = client_for(host, &addrs)?;
            let mut request = client.request(method.clone(), url.clone());
            for (name, value) in &execution.headers {
                let blocked = name.eq_ignore_ascii_case("host")
                    || name.eq_ignore_ascii_case("content-length")
                    || name.eq_ignore_ascii_case("connection")
                    || name.eq_ignore_ascii_case("proxy-connection")
                    || name.eq_ignore_ascii_case("cookie");
                if !blocked {
                    request = request.header(name, value);
                }
            }
            if let Some(cookie) = self.cookie_header(execution, &url) {
                request = request.header(reqwest::header::COOKIE, cookie);
            }
            if !body.is_empty() {
                request = request.body(body.clone());
            }
            let mut response = request
                .send()
                .await
                .map_err(|error| format!("host HTTP request failed: {error}"))?;
            self.store_response_cookies(execution, &url, response.headers());

            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| "redirect response had no valid Location".to_string())?;
                if redirect_count == MAX_REDIRECTS {
                    return Err("too many redirects".into());
                }
                url = url
                    .join(location)
                    .map_err(|error| format!("redirect URL failed: {error}"))?;
                if !matches!(url.scheme(), "http" | "https") {
                    return Err("unsupported-scheme: redirect left HTTP(S)".into());
                }
                if response.status() == reqwest::StatusCode::SEE_OTHER
                    || ((response.status() == reqwest::StatusCode::MOVED_PERMANENTLY
                        || response.status() == reqwest::StatusCode::FOUND)
                        && method == reqwest::Method::POST)
                {
                    method = reqwest::Method::GET;
                    body.clear();
                }
                continue;
            }

            if response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/event-stream"))
            {
                return Err("unsupported-sse: server-sent events are not enabled".into());
            }
            if response
                .headers()
                .get_all(reqwest::header::WWW_AUTHENTICATE)
                .iter()
                .filter_map(|value| value.to_str().ok())
                .any(|value| {
                    let lower = value.to_ascii_lowercase();
                    lower.starts_with("negotiate") || lower.starts_with("ntlm")
                })
            {
                return Err(
                    "unsupported-integrated-auth: Kerberos and NTLM are not enabled".into(),
                );
            }
            let headers = response
                .headers()
                .iter()
                .filter(|(name, _)| {
                    !name.as_str().eq_ignore_ascii_case("set-cookie")
                        && !name.as_str().eq_ignore_ascii_case("transfer-encoding")
                        && !name.as_str().eq_ignore_ascii_case("connection")
                })
                .map(|(name, value)| {
                    (
                        name.as_str().to_string(),
                        String::from_utf8_lossy(value.as_bytes()).into_owned(),
                    )
                })
                .collect();
            sink(BrowserEvent::Head {
                status: response.status().as_u16(),
                headers,
                final_url: url.to_string(),
            });
            if method == reqwest::Method::HEAD {
                sink(BrowserEvent::End);
                return Ok(());
            }
            let mut total = 0usize;
            let mut seq = 0u64;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| format!("response stream failed: {error}"))?
            {
                for part in chunk.chunks(RESPONSE_CHUNK_BYTES) {
                    total = total.saturating_add(part.len());
                    if total > MAX_STREAM_RESPONSE_BYTES {
                        return Err("response-too-large: response exceeds stream budget".into());
                    }
                    self.validate_grant(&execution.grant, &url)?;
                    self.charge_bytes(execution.key.viewer, part.len())?;
                    execution.flow.claim(part.len())?;
                    sink(BrowserEvent::Chunk {
                        seq,
                        b64: base64::engine::general_purpose::STANDARD.encode(part),
                    });
                    seq += 1;
                }
            }
            sink(BrowserEvent::End);
            self.record_audit(
                "response",
                "allowed",
                &execution.grant,
                execution.key.stream_id,
                total as u64,
                "ok",
                Some(&url),
            );
            return Ok(());
        }
        Err("too many redirects".into())
    }

    fn cookie_key(&self, execution: &BrowserExecution, url: &reqwest::Url) -> CookieKey {
        let port = url.port_or_known_default().unwrap_or_default();
        CookieKey {
            viewer: execution.key.viewer,
            attachment_generation: execution.attachment_generation,
            tab_id: execution.tab_id.clone(),
            origin: format!(
                "{}://{}:{}",
                url.scheme(),
                url.host_str().unwrap_or_default(),
                port
            ),
        }
    }

    fn cookie_header(&self, execution: &BrowserExecution, url: &reqwest::Url) -> Option<String> {
        let key = self.cookie_key(execution, url);
        let cookies = self.cookies.lock().unwrap_or_else(|e| e.into_inner());
        let values = cookies.get(&key)?;
        (!values.is_empty()).then(|| {
            values
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; ")
        })
    }

    fn store_response_cookies(
        &self,
        execution: &BrowserExecution,
        url: &reqwest::Url,
        headers: &reqwest::header::HeaderMap,
    ) {
        let key = self.cookie_key(execution, url);
        let mut jars = self.cookies.lock().unwrap_or_else(|e| e.into_inner());
        let jar = jars.entry(key).or_default();
        for value in headers
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
        {
            let Some((name, value)) = value.split(';').next().and_then(|v| v.split_once('='))
            else {
                continue;
            };
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            if value.is_empty() {
                jar.remove(name);
            } else {
                jar.insert(name.to_string(), value.to_string());
            }
        }
    }
}

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
    let addresses = network_broker::approve_addresses(
        network_broker::system_resolve(&target.host, target.port)?,
        target.port,
        TargetPolicy::LocalNavigation,
    )?;
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

/// Race address families within the request's remaining budget. A
/// firewalled first address can no longer consume the whole thirty seconds
/// before a reachable address from the other family is attempted.
fn connect_within(addresses: &[SocketAddr], deadline: &Deadline) -> Option<TcpStream> {
    network_broker::connect_happy_eyeballs(addresses, deadline.remaining().ok()?)
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
    use std::net::{IpAddr, TcpListener};
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
        /// A complete raw HTTP response for protocol-policy fixtures.
        Raw(Vec<u8>),
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
                        Reply::Raw(bytes) => {
                            let _ = stream.write_all(&bytes);
                        }
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

    fn open_stream(
        router: &BrowserRequestRouter,
        viewer: u64,
        stream_id: u64,
        method: &str,
        url: String,
        body: &[u8],
    ) -> BrowserExecution {
        router.bind_share("share-test".into());
        router
            .authorize_tab("browser-tab".into(), url.clone())
            .unwrap();
        let attachment_id = format!("attachment-{viewer}");
        router
            .bind_attachment(viewer, attachment_id.clone(), 1)
            .unwrap();
        router
            .open(
                viewer,
                stream_id,
                "browser-tab".into(),
                BrowserRequestRouter::expected_grant_id(&attachment_id, 1, "browser-tab"),
                attachment_id,
                1,
                Access::Steer,
                method.into(),
                url,
                vec![],
                (!body.is_empty()).then_some(body.len() as u64),
            )
            .unwrap();
        for (seq, chunk) in body.chunks(3).enumerate() {
            router
                .request_chunk(
                    viewer,
                    stream_id,
                    seq as u64,
                    &base64::engine::general_purpose::STANDARD.encode(chunk),
                )
                .unwrap();
        }
        router.request_end(viewer, stream_id).unwrap()
    }

    #[test]
    fn resident_browser_execution_keeps_router_grants_dns_budgets_and_flow_control() {
        let router = Arc::new(BrowserRequestRouter::default());
        let execution = open_stream(
            &router,
            71,
            9,
            "POST",
            "http://127.0.0.1:43119/inside".into(),
            b"host-network-request",
        );
        router.credit(71, 9, 1024).unwrap();
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let exchange: ResidentBrowserExchange = Arc::new(move |tab_id, request| {
            assert_eq!(tab_id, "browser-tab");
            captured.lock().unwrap().push(request.clone());
            Some(Ok(ResidentBrowserResponse {
                status: 200,
                headers: vec![("content-type".into(), "text/plain".into())],
                body: b"from-resident-worker".to_vec(),
            }))
        });
        let events = Arc::new(StdMutex::new(Vec::new()));
        let received = Arc::clone(&events);
        router.execute_resident_or_local(
            execution,
            Arc::new(move |event| received.lock().unwrap().push(event)),
            exchange,
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].grant_origin, "http://127.0.0.1:43119");
        assert_eq!(requests[0].pinned_addrs, ["127.0.0.1:43119"]);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(requests[0].body_b64.as_deref().unwrap())
                .unwrap(),
            b"host-network-request",
        );
        let events = events.lock().unwrap();
        assert!(matches!(
            events.first(),
            Some(BrowserEvent::Head { status: 200, .. })
        ));
        assert!(matches!(events.last(), Some(BrowserEvent::End)));
        assert!(events
            .iter()
            .any(|event| matches!(event, BrowserEvent::Chunk { .. })));
    }

    #[test]
    fn resident_browser_cancel_reaches_the_host_network_exchange() {
        let router = Arc::new(BrowserRequestRouter::default());
        let execution = open_stream(
            &router,
            72,
            10,
            "GET",
            "http://127.0.0.1:43120/slow".into(),
            &[],
        );
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
        let exchange: ResidentBrowserExchange = Arc::new(move |_tab_id, request| {
            started_tx.send(()).unwrap();
            let deadline = Instant::now() + PATIENCE;
            while Instant::now() < deadline {
                if request.cancelled.load(Ordering::Acquire) {
                    return Some(Err("resident-browser-cancelled".into()));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Some(Err("resident-browser-cancel-not-propagated".into()))
        });
        let events = Arc::new(StdMutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let running = {
            let router = Arc::clone(&router);
            std::thread::spawn(move || {
                router.execute_resident_or_local(
                    execution,
                    Arc::new(move |event| recorded.lock().unwrap().push(event)),
                    exchange,
                )
            })
        };

        started_rx.recv_timeout(PATIENCE).unwrap();
        router.cancel(72, 10);
        running.join().unwrap();

        assert!(events.lock().unwrap().iter().any(|event| {
            matches!(event, BrowserEvent::Error { code, message }
                if code == "cancelled" && message == "resident-browser-cancelled")
        }));
    }

    #[test]
    fn http_stream_v2_preserves_binary_request_and_streams_more_than_one_mebibyte() {
        let response = (0..(MAX_BODY_BYTES + 128 * 1024))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let (port, seen) = origin(Reply::Body(response.clone()));
        let router = Arc::new(BrowserRequestRouter::default());
        let request_body = [0, 255, 1, 128, 2, 127];
        let execution = open_stream(
            &router,
            4,
            9,
            "POST",
            format!("http://127.0.0.1:{port}/upload"),
            &request_body,
        );
        router.credit(4, 9, MAX_RESPONSE_CREDIT).unwrap();
        let events = Arc::new(StdMutex::new(Vec::new()));
        let recorded = events.clone();
        router.execute(
            execution,
            Arc::new(move |event| recorded.lock().unwrap().push(event)),
        );
        assert_eq!(served(&seen).1, request_body);
        let events = events.lock().unwrap();
        assert!(matches!(
            events.first(),
            Some(BrowserEvent::Head { status: 200, .. })
        ));
        assert!(matches!(events.last(), Some(BrowserEvent::End)));
        let streamed = events
            .iter()
            .filter_map(|event| match event {
                BrowserEvent::Chunk { b64, .. } => Some(
                    base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .unwrap(),
                ),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(streamed, response, "the v2 path has no legacy 1 MiB cut");
        let sequences = events
            .iter()
            .filter_map(|event| match event {
                BrowserEvent::Chunk { seq, .. } => Some(*seq),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(sequences, (0..sequences.len() as u64).collect::<Vec<_>>());
    }

    #[test]
    fn http_stream_v2_cancel_wakes_a_response_blocked_by_backpressure() {
        let (port, _seen) = origin(Reply::Body(vec![7; RESPONSE_CHUNK_BYTES * 2]));
        let router = Arc::new(BrowserRequestRouter::default());
        let execution = open_stream(
            &router,
            8,
            12,
            "GET",
            format!("http://127.0.0.1:{port}/slow-consumer"),
            &[],
        );
        let events = Arc::new(StdMutex::new(Vec::new()));
        let recorded = events.clone();
        let running = {
            let router = router.clone();
            std::thread::spawn(move || {
                router.execute(
                    execution,
                    Arc::new(move |event| recorded.lock().unwrap().push(event)),
                )
            })
        };
        let deadline = Instant::now() + PATIENCE;
        while Instant::now() < deadline
            && !events
                .lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event, BrowserEvent::Head { .. }))
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        router.cancel(8, 12);
        running.join().unwrap();
        assert!(events.lock().unwrap().iter().any(|event| {
            matches!(event, BrowserEvent::Error { code, .. } if code == "cancelled")
        }));
    }

    #[test]
    fn http_stream_v2_cookie_jar_is_scoped_by_viewer_and_tab_across_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: RequestLog = Arc::new(StdMutex::new(Vec::new()));
        let recorded = seen.clone();
        std::thread::spawn(move || {
            for step in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                recorded.lock().unwrap().push(request);
                if step == 0 {
                    let _ = stream.write_all(
                        b"HTTP/1.1 302 Found\r\nLocation: /final\r\nSet-Cookie: sid=isolated\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                } else {
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    );
                }
            }
        });
        let router = Arc::new(BrowserRequestRouter::default());
        let execution = open_stream(
            &router,
            22,
            1,
            "GET",
            format!("http://127.0.0.1:{port}/login"),
            &[],
        );
        router.credit(22, 1, 16).unwrap();
        router.execute(execution, Arc::new(|_| {}));
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1]
            .0
            .lines()
            .any(|line| line.eq_ignore_ascii_case("cookie: sid=isolated")));

        // A different viewer cannot read viewer 22's jar. The exact same
        // origin key differs at the requester identity field.
        let probe = BrowserExecution {
            key: StreamKey {
                viewer: 23,
                stream_id: 1,
            },
            tab_id: "browser-tab".into(),
            attachment_generation: 1,
            method: "GET".into(),
            url: format!("http://127.0.0.1:{port}/"),
            headers: vec![],
            body: vec![],
            flow: Arc::new(FlowState::new()),
            grant: NetworkGrant {
                grant_id: BrowserRequestRouter::expected_grant_id(
                    "attachment-23",
                    1,
                    "browser-tab",
                ),
                share_id: "share-test".into(),
                viewer: 23,
                attachment_id: "attachment-23".into(),
                attachment_generation: 1,
                tab_id: "browser-tab".into(),
                origin: format!("http://127.0.0.1:{port}"),
                method: "GET".into(),
                pinned_addrs: vec![format!("127.0.0.1:{port}").parse().unwrap()],
                expires_at: Instant::now() + GRANT_LIFETIME,
            },
        };
        assert_eq!(
            router.cookie_header(&probe, &reqwest::Url::parse(&probe.url).unwrap()),
            None
        );
    }

    #[test]
    fn http_stream_v2_supports_methods_explicit_auth_and_structured_feature_refusals() {
        for method in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] {
            let (port, seen) = origin(Reply::Body(b"ok".to_vec()));
            let router = Arc::new(BrowserRequestRouter::default());
            router.bind_share("share-test".into());
            let url = format!("http://127.0.0.1:{port}/methods");
            router
                .authorize_tab("browser-tab".into(), url.clone())
                .unwrap();
            router
                .bind_attachment(31, "attachment-31".into(), 1)
                .unwrap();
            router
                .open(
                    31,
                    1,
                    "browser-tab".into(),
                    BrowserRequestRouter::expected_grant_id("attachment-31", 1, "browser-tab"),
                    "attachment-31".into(),
                    1,
                    Access::Steer,
                    method.into(),
                    url,
                    vec![("authorization".into(), "Bearer viewer-token".into())],
                    (!matches!(method, "GET" | "HEAD")).then_some(3),
                )
                .unwrap();
            if !matches!(method, "GET" | "HEAD") {
                router
                    .request_chunk(
                        31,
                        1,
                        0,
                        &base64::engine::general_purpose::STANDARD.encode([0, 1, 255]),
                    )
                    .unwrap();
            }
            let execution = router.request_end(31, 1).unwrap();
            router.credit(31, 1, 16).unwrap();
            router.execute(execution, Arc::new(|_| {}));
            let (head, body) = served(&seen);
            assert!(head.starts_with(method), "{head}");
            assert!(head
                .lines()
                .any(|line| { line.eq_ignore_ascii_case("authorization: Bearer viewer-token") }));
            if !matches!(method, "GET" | "HEAD") {
                assert_eq!(body, [0, 1, 255]);
            }
        }

        let router = BrowserRequestRouter::default();
        router.bind_share("share-test".into());
        router
            .authorize_tab("browser-tab".into(), "http://127.0.0.1/socket".into())
            .unwrap();
        let websocket = router
            .open(
                1,
                2,
                "browser-tab".into(),
                BrowserRequestRouter::expected_grant_id("attachment-1", 1, "browser-tab"),
                "attachment-1".into(),
                1,
                Access::Steer,
                "GET".into(),
                "http://127.0.0.1/socket".into(),
                vec![("Upgrade".into(), "websocket".into())],
                None,
            )
            .unwrap_err();
        assert!(websocket.starts_with("unsupported-websocket:"));

        for (raw, code) in [
            (
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                "unsupported-sse",
            ),
            (
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                "unsupported-integrated-auth",
            ),
        ] {
            let (port, _seen) = origin(Reply::Raw(raw));
            let router = Arc::new(BrowserRequestRouter::default());
            let execution = open_stream(
                &router,
                2,
                3,
                "GET",
                format!("http://127.0.0.1:{port}/unsupported"),
                &[],
            );
            router.credit(2, 3, 16).unwrap();
            let events = Arc::new(StdMutex::new(Vec::new()));
            let recorded = events.clone();
            router.execute(
                execution,
                Arc::new(move |event| recorded.lock().unwrap().push(event)),
            );
            assert!(events.lock().unwrap().iter().any(|event| {
                matches!(event, BrowserEvent::Error { code: actual, .. } if actual == code)
            }));
        }
    }

    #[test]
    fn http_stream_v2_terminates_tls_on_host_and_refuses_an_untrusted_ca() {
        use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

        crate::http::ensure_crypto_provider();
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let certificate = cert.der().clone();
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signing_key.serialize_der()));
        let config = Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(vec![certificate.clone()], key)
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for incoming in listener.incoming().take(2) {
                let Ok(stream) = incoming else { continue };
                let Ok(connection) = rustls::ServerConnection::new(config.clone()) else {
                    continue;
                };
                let mut tls = rustls::StreamOwned::new(connection, stream);
                let mut request = [0u8; 4096];
                if tls.read(&mut request).is_ok() {
                    let _ = tls.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecure",
                    );
                }
            }
        });

        let untrusted = Arc::new(BrowserRequestRouter::default());
        let execution = open_stream(
            &untrusted,
            40,
            1,
            "GET",
            format!("https://localhost:{port}/"),
            &[],
        );
        untrusted.credit(40, 1, 16).unwrap();
        let refused = Arc::new(StdMutex::new(Vec::new()));
        let recorded = refused.clone();
        untrusted.execute(
            execution,
            Arc::new(move |event| recorded.lock().unwrap().push(event)),
        );
        assert!(refused.lock().unwrap().iter().any(|event| {
            matches!(event, BrowserEvent::Error { code, .. } if code == "network-error")
        }));

        let trusted = Arc::new(BrowserRequestRouter::default());
        let execution = open_stream(
            &trusted,
            41,
            1,
            "GET",
            format!("https://localhost:{port}/"),
            &[],
        );
        trusted.credit(41, 1, 16).unwrap();
        let client = crate::http::build_browser_stream_pinned_with_root(
            "localhost",
            &execution.grant.pinned_addrs,
            reqwest::Certificate::from_der(certificate.as_ref()).unwrap(),
        )
        .unwrap();
        let accepted = Arc::new(StdMutex::new(Vec::new()));
        let recorded = accepted.clone();
        let sink: BrowserResponseSink = Arc::new(move |event| recorded.lock().unwrap().push(event));
        tauri::async_runtime::block_on(trusted.execute_with_client(&execution, &sink, &client))
            .unwrap();
        let body = accepted
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                BrowserEvent::Chunk { b64, .. } => Some(
                    base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .unwrap(),
                ),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(body, b"secure");
    }

    fn grant_open(
        router: &BrowserRequestRouter,
        viewer: u64,
        stream_id: u64,
        generation: u64,
        access: Access,
        method: &str,
        url: &str,
    ) -> Result<(), String> {
        let attachment = format!("attachment-{viewer}");
        if !router
            .attachments
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&viewer)
        {
            router
                .bind_attachment(viewer, attachment.clone(), 1)
                .unwrap();
        }
        router.open(
            viewer,
            stream_id,
            "browser-tab".into(),
            BrowserRequestRouter::expected_grant_id(&attachment, generation, "browser-tab"),
            attachment,
            generation,
            access,
            method.into(),
            url.into(),
            vec![],
            None,
        )
    }

    #[test]
    fn network_grant_rejects_cross_viewer_old_generation_origin_port_and_viewer_writes() {
        let router = BrowserRequestRouter::default();
        router.bind_share("share-a".into());
        router
            .authorize_tab("browser-tab".into(), "http://127.0.0.1:18080/root".into())
            .unwrap();
        router.bind_attachment(1, "attachment-1".into(), 1).unwrap();
        router.bind_attachment(2, "attachment-2".into(), 1).unwrap();

        let replayed = router
            .open(
                2,
                1,
                "browser-tab".into(),
                BrowserRequestRouter::expected_grant_id("attachment-1", 1, "browser-tab"),
                "attachment-2".into(),
                1,
                Access::Steer,
                "GET".into(),
                "http://127.0.0.1:18080/root".into(),
                vec![],
                None,
            )
            .unwrap_err();
        assert!(replayed.starts_with("grant-owner-mismatch:"));

        let stale = router
            .open(
                1,
                2,
                "browser-tab".into(),
                BrowserRequestRouter::expected_grant_id("attachment-1", 2, "browser-tab"),
                "attachment-1".into(),
                2,
                Access::Steer,
                "GET".into(),
                "http://127.0.0.1:18080/root".into(),
                vec![],
                None,
            )
            .unwrap_err();
        assert!(stale.starts_with("grant-owner-mismatch:"));

        let wrong_port = grant_open(
            &router,
            1,
            3,
            1,
            Access::Steer,
            "GET",
            "http://127.0.0.1:18081/root",
        )
        .unwrap_err();
        assert!(wrong_port.starts_with("origin-denied:"));

        let cross_origin = grant_open(
            &router,
            1,
            4,
            1,
            Access::Steer,
            "GET",
            "http://localhost:18080/root",
        )
        .unwrap_err();
        assert!(cross_origin.starts_with("origin-denied:"));

        let view_write = grant_open(
            &router,
            1,
            5,
            1,
            Access::View,
            "POST",
            "http://127.0.0.1:18080/root",
        )
        .unwrap_err();
        assert!(view_write.starts_with("access-denied:"));

        grant_open(
            &router,
            1,
            6,
            1,
            Access::View,
            "GET",
            "http://127.0.0.1:18080/root",
        )
        .unwrap();
        assert!(router
            .request_chunk(
                2,
                6,
                0,
                &base64::engine::general_purpose::STANDARD.encode(b"cross-viewer-body"),
            )
            .unwrap_err()
            .contains("unknown browser stream"));
        router.bind_share("share-b".into());
        assert!(router
            .request_end(1, 6)
            .err()
            .unwrap()
            .contains("unknown browser stream"));
    }

    #[test]
    fn network_grant_isolates_same_stream_id_interleaving_cancel_and_reconnect() {
        let router = Arc::new(BrowserRequestRouter::default());
        router.bind_share("share-two-viewers".into());
        let url = "http://127.0.0.1:18080/private";
        router
            .authorize_tab("browser-tab".into(), url.into())
            .unwrap();

        let viewer_a = 41;
        let viewer_b = 42;
        let stream_id = 7;
        let attachment_a = format!("attachment-{viewer_a}");
        let attachment_b = format!("attachment-{viewer_b}");
        router
            .bind_attachment(viewer_a, attachment_a.clone(), 1)
            .unwrap();
        router
            .bind_attachment(viewer_b, attachment_b.clone(), 1)
            .unwrap();
        for (viewer, attachment) in [
            (viewer_a, attachment_a.as_str()),
            (viewer_b, attachment_b.as_str()),
        ] {
            router
                .open(
                    viewer,
                    stream_id,
                    "browser-tab".into(),
                    BrowserRequestRouter::expected_grant_id(attachment, 1, "browser-tab"),
                    attachment.into(),
                    1,
                    Access::Steer,
                    "POST".into(),
                    url.into(),
                    vec![],
                    Some(8),
                )
                .unwrap();
        }

        use base64::Engine as _;
        let encoded = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        // Both legal requesters use the same numeric stream id and their
        // chunks interleave on the same router without sharing state.
        router
            .request_chunk(viewer_a, stream_id, 0, &encoded(b"A-0-"))
            .unwrap();
        router
            .request_chunk(viewer_b, stream_id, 0, &encoded(b"B-0-"))
            .unwrap();
        router
            .request_chunk(viewer_a, stream_id, 1, &encoded(b"A-1-"))
            .unwrap();
        router
            .request_chunk(viewer_b, stream_id, 1, &encoded(b"B-1-"))
            .unwrap();

        let execution_a = router.request_end(viewer_a, stream_id).unwrap();
        let execution_b = router.request_end(viewer_b, stream_id).unwrap();
        router.credit(viewer_a, stream_id, 1024).unwrap();
        router.credit(viewer_b, stream_id, 1024).unwrap();
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let exchange: ResidentBrowserExchange = Arc::new(move |_tab_id, request| {
            let body = base64::engine::general_purpose::STANDARD
                .decode(request.body_b64.as_deref().unwrap_or_default())
                .unwrap();
            let owner = if body.starts_with(b"A-") { "A" } else { "B" };
            captured.lock().unwrap().push((owner.to_string(), body));
            Some(Ok(ResidentBrowserResponse {
                status: 200,
                headers: vec![("set-cookie".into(), format!("owner={owner}"))],
                body: format!("response-{owner}").into_bytes(),
            }))
        });
        let viewer_a_events = Arc::new(StdMutex::new(Vec::new()));
        let received_a = Arc::clone(&viewer_a_events);
        router.execute_resident_or_local(
            execution_a,
            Arc::new(move |event| received_a.lock().unwrap().push(event)),
            Arc::clone(&exchange),
        );
        let viewer_b_events = Arc::new(StdMutex::new(Vec::new()));
        let received_b = Arc::clone(&viewer_b_events);
        router.execute_resident_or_local(
            execution_b,
            Arc::new(move |event| received_b.lock().unwrap().push(event)),
            exchange,
        );

        let requests = requests.lock().unwrap();
        assert_eq!(
            requests.as_slice(),
            &[
                ("A".into(), b"A-0-A-1-".to_vec()),
                ("B".into(), b"B-0-B-1-".to_vec()),
            ],
        );
        let response_body = |events: &[BrowserEvent]| {
            events
                .iter()
                .filter_map(|event| match event {
                    BrowserEvent::Chunk { b64, .. } => Some(
                        base64::engine::general_purpose::STANDARD
                            .decode(b64)
                            .unwrap(),
                    ),
                    _ => None,
                })
                .flatten()
                .collect::<Vec<_>>()
        };
        let events_a = viewer_a_events.lock().unwrap();
        let events_b = viewer_b_events.lock().unwrap();
        assert_eq!(response_body(&events_a), b"response-A");
        assert_eq!(response_body(&events_b), b"response-B");
        assert!(!format!("{events_a:?}").contains("response-B"));
        assert!(!format!("{events_b:?}").contains("response-A"));
        drop(events_a);
        drop(events_b);
        let cookies = router.cookies.lock().unwrap();
        assert_eq!(cookies.len(), 2);
        assert_eq!(
            cookies
                .iter()
                .find(|(key, _)| key.viewer == viewer_a)
                .and_then(|(_, jar)| jar.get("owner"))
                .map(String::as_str),
            Some("A"),
        );
        assert_eq!(
            cookies
                .iter()
                .find(|(key, _)| key.viewer == viewer_b)
                .and_then(|(_, jar)| jar.get("owner"))
                .map(String::as_str),
            Some("B"),
        );
        drop(cookies);

        // A second same-id pair proves B cancellation and disconnection are
        // scoped to B and cannot remove or cancel A's pending stream.
        for (viewer, attachment) in [
            (viewer_a, attachment_a.as_str()),
            (viewer_b, attachment_b.as_str()),
        ] {
            router
                .open(
                    viewer,
                    8,
                    "browser-tab".into(),
                    BrowserRequestRouter::expected_grant_id(attachment, 1, "browser-tab"),
                    attachment.into(),
                    1,
                    Access::View,
                    "GET".into(),
                    url.into(),
                    vec![],
                    None,
                )
                .unwrap();
        }
        router.cancel(viewer_b, 8);
        router.cancel_viewer(viewer_b);
        assert!(router.request_end(viewer_a, 8).is_ok());
        assert!(router.request_end(viewer_b, 8).is_err());

        // The trusted attachment binding advances B to generation 2 after
        // reconnect. A generation-1 replay is now stale relative to a real
        // current generation, not merely rejected by a hard-coded constant.
        router
            .bind_attachment(viewer_b, attachment_b.clone(), 2)
            .unwrap();
        assert!(router
            .open(
                viewer_b,
                9,
                "browser-tab".into(),
                BrowserRequestRouter::expected_grant_id(&attachment_b, 1, "browser-tab"),
                attachment_b.clone(),
                1,
                Access::View,
                "GET".into(),
                url.into(),
                vec![],
                None,
            )
            .unwrap_err()
            .starts_with("grant-owner-mismatch:"));
        router
            .open(
                viewer_b,
                9,
                "browser-tab".into(),
                BrowserRequestRouter::expected_grant_id(&attachment_b, 2, "browser-tab"),
                attachment_b,
                2,
                Access::View,
                "GET".into(),
                url.into(),
                vec![],
                None,
            )
            .unwrap();
        router.cancel(viewer_b, 9);
    }

    #[test]
    fn network_grant_pins_dns_and_refuses_metadata_before_any_request() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let router = Arc::new(BrowserRequestRouter::with_resolver(Arc::new(
            move |_host, port| {
                let ip = if count.fetch_add(1, Ordering::SeqCst) == 0 {
                    "127.0.0.1"
                } else {
                    "127.0.0.2"
                };
                Ok(vec![format!("{ip}:{port}").parse().unwrap()])
            },
        )));
        router.bind_share("share-rebind".into());
        router
            .authorize_tab("browser-tab".into(), "http://rebind.test:18080/".into())
            .unwrap();
        grant_open(
            &router,
            7,
            1,
            1,
            Access::View,
            "GET",
            "http://rebind.test:18080/",
        )
        .unwrap();
        let execution = router.request_end(7, 1).unwrap();
        router.credit(7, 1, 16).unwrap();
        let events = Arc::new(StdMutex::new(Vec::new()));
        let recorded = events.clone();
        router.execute(
            execution,
            Arc::new(move |event| recorded.lock().unwrap().push(event)),
        );
        assert!(events.lock().unwrap().iter().any(|event| {
            matches!(event, BrowserEvent::Error { code, .. } if code == "dns-rebind-denied")
        }));

        let metadata = BrowserRequestRouter::with_resolver(Arc::new(|_host, port| {
            Ok(vec![SocketAddr::new(
                IpAddr::V4(std::net::Ipv4Addr::new(169, 254, 169, 254)),
                port,
            )])
        }));
        metadata.bind_share("share-metadata".into());
        metadata
            .authorize_tab("browser-tab".into(), "http://metadata.test/latest".into())
            .unwrap();
        let denied = grant_open(
            &metadata,
            8,
            1,
            1,
            Access::View,
            "GET",
            "http://metadata.test/latest",
        )
        .unwrap_err();
        assert!(denied.starts_with("ssrf-denied:"));

        let mapped_metadata = BrowserRequestRouter::with_resolver(Arc::new(|_host, port| {
            Ok(vec![SocketAddr::new(
                IpAddr::V6("::ffff:169.254.169.254".parse().unwrap()),
                port,
            )])
        }));
        mapped_metadata.bind_share("share-mapped-metadata".into());
        mapped_metadata
            .authorize_tab("browser-tab".into(), "http://mapped.test/latest".into())
            .unwrap();
        assert!(grant_open(
            &mapped_metadata,
            8,
            1,
            1,
            Access::View,
            "GET",
            "http://mapped.test/latest",
        )
        .unwrap_err()
        .starts_with("ssrf-denied:"));
    }

    #[test]
    fn network_grant_rechecks_redirect_before_target_cookie_body_or_response() {
        let (target_port, target_seen) = origin(Reply::Body(b"must-not-arrive".to_vec()));
        let redirect = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target_port}/private\r\nSet-Cookie: sid=must-not-leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let (source_port, source_seen) = origin(Reply::Raw(redirect.into_bytes()));
        let router = Arc::new(BrowserRequestRouter::default());
        let execution = open_stream(
            &router,
            12,
            1,
            "GET",
            format!("http://127.0.0.1:{source_port}/start"),
            &[],
        );
        router.credit(12, 1, 16).unwrap();
        let events = Arc::new(StdMutex::new(Vec::new()));
        let recorded = events.clone();
        router.execute(
            execution,
            Arc::new(move |event| recorded.lock().unwrap().push(event)),
        );
        assert_eq!(served(&source_seen).1, Vec::<u8>::new());
        assert!(target_seen.lock().unwrap().is_empty());
        assert!(events.lock().unwrap().iter().any(|event| {
            matches!(event, BrowserEvent::Error { code, .. } if code == "origin-denied")
        }));
        assert!(!events.lock().unwrap().iter().any(|event| matches!(
            event,
            BrowserEvent::Head { .. } | BrowserEvent::Chunk { .. }
        )));
    }

    #[test]
    fn network_grant_revocation_rate_and_concurrency_release_every_stream() {
        let router = BrowserRequestRouter::default();
        router.bind_share("share-budget".into());
        let url = "http://127.0.0.1:18080/root";
        router
            .authorize_tab("browser-tab".into(), url.into())
            .unwrap();

        for stream_id in 1..=MAX_STREAMS_PER_VIEWER as u64 {
            grant_open(&router, 9, stream_id, 1, Access::View, "GET", url).unwrap();
        }
        let limited = grant_open(&router, 9, 99, 1, Access::View, "GET", url).unwrap_err();
        assert!(limited.starts_with("concurrency-limited:"));
        for stream_id in 1..=MAX_STREAMS_PER_VIEWER as u64 {
            router.cancel(9, stream_id);
        }

        for stream_id in 100..(100 + MAX_OPENS_PER_WINDOW as u64 - 4) {
            grant_open(&router, 9, stream_id, 1, Access::View, "GET", url).unwrap();
            router.cancel(9, stream_id);
        }
        let rate = grant_open(&router, 9, 999, 1, Access::View, "GET", url).unwrap_err();
        assert!(rate.starts_with("rate-limited:"));

        grant_open(&router, 10, 1, 1, Access::Steer, "POST", url).unwrap();
        router.revoke_tab("browser-tab");
        assert!(router.request_end(10, 1).is_err());
        assert!(router.credit(10, 1, 1).is_err());

        assert!(router
            .charge_bytes(11, MAX_BYTES_PER_VIEWER_WINDOW as usize + 1)
            .unwrap_err()
            .starts_with("budget-exceeded:"));
        router
            .authorize_tab("browser-tab".into(), url.into())
            .unwrap();
        grant_open(&router, 12, 2, 1, Access::View, "GET", url).unwrap();
        router
            .requests
            .lock()
            .unwrap()
            .get_mut(&StreamKey {
                viewer: 12,
                stream_id: 2,
            })
            .unwrap()
            .grant
            .expires_at = Instant::now();
        assert!(router
            .request_end(12, 2)
            .err()
            .unwrap()
            .starts_with("grant-expired:"));
    }

    #[test]
    fn network_audit_is_correlated_and_never_stores_url_credentials_cookie_or_body() {
        let router = BrowserRequestRouter::default();
        router.bind_share("share-audit".into());
        let url = "http://127.0.0.1:18080/private?token=url-secret";
        router
            .authorize_tab("browser-tab".into(), url.into())
            .unwrap();
        let attachment = "attachment-11";
        router.bind_attachment(11, attachment.into(), 1).unwrap();
        router
            .open(
                11,
                1,
                "browser-tab".into(),
                BrowserRequestRouter::expected_grant_id(attachment, 1, "browser-tab"),
                attachment.into(),
                1,
                Access::Steer,
                "POST".into(),
                url.into(),
                vec![
                    ("authorization".into(), "Bearer audit-secret".into()),
                    ("cookie".into(), "sid=cookie-secret".into()),
                ],
                Some(11),
            )
            .unwrap();
        router
            .request_chunk(
                11,
                1,
                0,
                &base64::engine::general_purpose::STANDARD.encode(b"body-secret"),
            )
            .unwrap();
        let audit = format!("{:?}", router.audit_events());
        assert!(audit.contains("share-audit"));
        assert!(audit.contains("browser-tab"));
        for secret in ["url-secret", "audit-secret", "cookie-secret", "body-secret"] {
            assert!(!audit.contains(secret), "audit leaked {secret}: {audit}");
        }
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
