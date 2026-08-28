//! Remote-control engine over iroh P2P.
//!
//! Host side: `RemoteHub` owns one iroh `Endpoint` and any number of `Share`s
//! (one per shared tab). A share hands out a `ShareTicket` (endpoint address +
//! per-share secret token). Viewers authenticate with the token over an
//! end-to-end encrypted QUIC connection (direct via holepunching, falling back
//! to public relays — the relay only ever sees ciphertext).
//!
//! Snapshot handoff: when a viewer joins, the host app injects a snapshot
//! marker into the tab's *ordered* output dispatch path and simultaneously
//! tells the share to start buffering output for that viewer. The webview
//! serializes its terminal state exactly at the marker, so
//! `snapshot + buffered output` reproduces the byte stream with no gap and no
//! duplication.
//!
//! Join side: `join()` binds a throwaway client endpoint (avoids self-dial
//! edge cases and needs no accept ALPN), dials the ticket and speaks
//! length-prefixed JSON frames of `tabverse_proto::{RemoteClientMsg, RemoteHostMsg}`.

pub mod bridge;
pub mod source;
pub use bridge::{LocalSink, SessionBridge, ShareBinding};
pub use source::{
    InputOutcome, InputPayload, ShareSource, SourceRegistry, ViewerId, ViewerInfo, Viewport,
};

use anyhow::{anyhow, bail, Context, Result};
use data_encoding::BASE32_NOPAD;
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tabverse_proto::{
    announce_proto, negotiate, Access, RemoteClientMsg, RemoteHostMsg, SharedTabType, REMOTE_ALPN,
    REMOTE_PROTO_V1, REMOTE_PROTO_VERSION,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

const MAX_FRAME: u32 = 16 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound on waiting for a peer to acknowledge final frames before we close
/// its connection. Closing immediately after buffering an `End` frame could
/// discard it, leaving the viewer without the reason for the disconnect; a
/// peer that never acks must not pin the host task forever either.
const END_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------- framing --

pub async fn write_frame<T: Serialize>(w: &mut (impl AsyncWrite + Unpin), msg: &T) -> Result<()> {
    let body = serde_json::to_vec(msg)?;
    if body.len() as u64 > MAX_FRAME as u64 {
        bail!("frame too large: {}", body.len());
    }
    w.write_all(&(body.len() as u32).to_be_bytes()).await?;
    w.write_all(&body).await?;
    Ok(())
}

pub async fn read_frame<T: for<'de> Deserialize<'de>>(
    r: &mut (impl AsyncRead + Unpin),
) -> Result<T> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len);
    if len > MAX_FRAME {
        bail!("frame too large: {len}");
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    Ok(serde_json::from_slice(&buf)?)
}

// ----------------------------------------------------------------- ticket --

/// Everything a viewer needs to reach and enter a shared tab.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShareTicket {
    pub addr: EndpointAddr,
    pub share: String,
    pub token: String,
    /// Highest protocol version the ticket's creator speaks. Absent on
    /// tickets from v0.0.1/v0.0.2 (which predate the field) → treated as 1,
    /// because those hosts close the connection on any Hello above v1 without
    /// sending a frame. Skipped when `None` so a ticket we produce for a v1
    /// share stays byte-shape-identical to what those releases emit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proto: Option<u32>,
}

const TICKET_PREFIX: &str = "tabv";

impl ShareTicket {
    pub fn encode(&self) -> String {
        let json = serde_json::to_vec(self).expect("ticket serializes");
        format!(
            "{TICKET_PREFIX}{}",
            BASE32_NOPAD.encode(&json).to_lowercase()
        )
    }

    pub fn decode(s: &str) -> Result<Self> {
        let compact: String = s.split_whitespace().collect::<Vec<_>>().join("");
        let rest = compact
            .strip_prefix(TICKET_PREFIX)
            .ok_or_else(|| anyhow!("not a Tabverse ticket (missing '{TICKET_PREFIX}' prefix)"))?;
        let bytes = BASE32_NOPAD
            .decode(rest.to_uppercase().as_bytes())
            .context("ticket base32 decode failed")?;
        serde_json::from_slice(&bytes).context("ticket payload invalid")
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 20];
    rand::fill(&mut bytes);
    BASE32_NOPAD.encode(&bytes).to_lowercase()
}

// ------------------------------------------------------------------- host --

enum ViewerState {
    /// Waiting for the snapshot; frames queue up here meanwhile.
    Buffering(Vec<RemoteHostMsg>),
    Live,
}

/// How much output may pile up for a viewer that has not caught up.
///
/// Without a ceiling, a host running something noisy while a viewer is slow
/// (or never answers the snapshot request) grows this queue until the host
/// runs out of memory. Dropping the viewer is the honest failure: they see the
/// session end and can rejoin, instead of the host degrading for everyone.
const MAX_PENDING_FRAMES: usize = 4096;

type PresenceCallback = Arc<dyn Fn(&[ViewerInfo]) + Send + Sync>;

struct Viewer {
    /// The version this viewer speaks, settled at join. Frames it cannot parse
    /// are withheld rather than sent and hoped for: its decoder treats an
    /// unknown variant as fatal for the whole connection.
    proto: u32,
    tx: mpsc::UnboundedSender<RemoteHostMsg>,
    state: ViewerState,
    name: String,
    /// What this viewer may do right now. Starts at the share's default and
    /// changes live through `set_viewer_access`; the frame-read loop looks it
    /// up fresh per frame (`viewer_access`) rather than keeping a copy taken
    /// at join, so a change takes effect on the very next frame.
    access: Access,
    /// What this viewer says it can display, when it says anything.
    viewport: Option<(u16, u16)>,
}

pub struct Share {
    pub id: String,
    token: String,
    title: Mutex<String>,
    size: Mutex<(u16, u16)>,
    /// The tab runtime this share fronts. Policy — access checks, version
    /// negotiation, buffering — stays here in the hub; mechanism lives
    /// behind this trait.
    source: Arc<dyn ShareSource>,
    /// Who is connected, with what power. A host-UI concern, which is why it
    /// rides on the share rather than on the source.
    on_presence: PresenceCallback,
    viewers: Mutex<HashMap<u64, Viewer>>,
    /// Flipped (under the viewers lock) once the share is torn down, so a
    /// joiner racing the teardown cannot insert itself into a dead share.
    stopped: Mutex<bool>,
    /// When the share was created; together with `ttl` this bounds the join
    /// window (never the session itself).
    created_at: Instant,
    /// Join window (invite-link semantics): joins after `created_at + ttl`
    /// are refused, viewers already connected are untouched. None = no expiry.
    ttl: Option<Duration>,
    /// The level NEW viewers join at. Each connected viewer carries its own
    /// current level (`Viewer::access`), adjustable live per viewer; this
    /// field is only the default handed out at join.
    access: Access,
    /// `source.kind()`, settled at construction so frame handling never asks
    /// the source a question whose answer must not change mid-share.
    tab_type: SharedTabType,
}

impl Share {
    /// Smallest viewport over all viewers that reported one.
    fn joint_viewport(&self) -> Option<(u16, u16)> {
        self.viewers
            .lock()
            .unwrap()
            .values()
            .filter_map(|v| v.viewport)
            .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1)))
    }

    fn notify_viewport(&self) {
        self.source.apply_viewport(
            self.joint_viewport()
                .map(|(cols, rows)| Viewport { cols, rows }),
        );
    }

    fn presence(&self) {
        // One pass computes the roster and fans the count out to the wire, so
        // the local callback and remote viewers can never disagree on who is
        // connected.
        let roster = {
            let mut viewers = self.viewers.lock().unwrap();
            let n = viewers.len() as u32;
            for v in viewers.values_mut() {
                let msg = RemoteHostMsg::Presence { viewers: n };
                match &mut v.state {
                    ViewerState::Buffering(buf) => {
                        // Honour the same ceiling as other broadcasts, but
                        // skip instead of dropping the viewer: dropping would
                        // re-enter presence(), and a viewer at the cap gets
                        // dropped by the next output frame anyway. Presence
                        // carries the full count, so a skipped update is
                        // superseded by the next one, not lost.
                        if buf.len() < MAX_PENDING_FRAMES {
                            buf.push(msg);
                        }
                    }
                    ViewerState::Live => {
                        let _ = v.tx.send(msg);
                    }
                }
            }
            // Sorted so the host UI sees a stable roster; HashMap iteration
            // order would reshuffle the list on every update. The access is
            // each viewer's own current level, not the share default — this
            // roster is how a live change reaches every host UI.
            let mut roster: Vec<ViewerInfo> = viewers
                .iter()
                .map(|(id, v)| ViewerInfo {
                    id: *id,
                    name: v.name.clone(),
                    access: v.access,
                })
                .collect();
            roster.sort_unstable_by_key(|v| v.id);
            roster
        };
        (self.on_presence)(&roster);
    }

    /// Fan one frame out to every viewer (buffered or live), dropping any
    /// buffering viewer whose queue already hit `MAX_PENDING_FRAMES` — see
    /// that constant for why unbounded queues are worse than dropping.
    fn broadcast(&self, msg: RemoteHostMsg) {
        let mut stalled: Vec<u64> = Vec::new();
        {
            let mut viewers = self.viewers.lock().unwrap();
            for (id, v) in viewers.iter_mut() {
                if Self::is_v2_only(&msg) && v.proto < 2 {
                    continue;
                }
                if Self::is_v3_only(&msg) && v.proto < 3 {
                    continue;
                }
                match &mut v.state {
                    ViewerState::Buffering(buf) => {
                        if buf.len() >= MAX_PENDING_FRAMES {
                            stalled.push(*id);
                        } else {
                            buf.push(msg.clone());
                        }
                    }
                    ViewerState::Live => {
                        let _ = v.tx.send(msg.clone());
                    }
                }
            }
            for id in &stalled {
                if let Some(v) = viewers.remove(id) {
                    let _ = v.tx.send(RemoteHostMsg::End {
                        reason: "viewer fell too far behind".to_string(),
                    });
                    eprintln!("[remote] dropped viewer {id} ({}): never caught up", v.name);
                }
            }
        }
        if !stalled.is_empty() {
            self.presence();
        }
    }

    /// Is this frame one that only a v2 client can parse?
    ///
    /// The compatibility rule in one place rather than at every call site: a
    /// v1 decoder fails the whole connection on a variant it does not know,
    /// so these must be withheld from anyone who joined speaking v1.
    fn is_v2_only(msg: &RemoteHostMsg) -> bool {
        matches!(
            msg,
            RemoteHostMsg::AgentEvent { .. }
                | RemoteHostMsg::AgentSnapshot { .. }
                | RemoteHostMsg::AgentDecisionTaken { .. }
        )
    }

    /// Is this frame one that only a v3 client can parse? App shares are
    /// refused below v3 at the door, so on a live app share every viewer
    /// speaks v3 — but the same Share can outlive protocol bumps, and the
    /// rule lives here rather than at call sites for the same reason the v2
    /// one does.
    fn is_v3_only(msg: &RemoteHostMsg) -> bool {
        matches!(
            msg,
            RemoteHostMsg::RpcResult { .. }
                | RemoteHostMsg::ActionApplied { .. }
                | RemoteHostMsg::AppSnapshot { .. }
                | RemoteHostMsg::ClipSync { .. }
                | RemoteHostMsg::ProxyRes { .. }
        )
    }

    /// Route PTY output to every viewer (buffered or live).
    /// MUST be called under the app's per-session dispatch lock.
    pub fn broadcast_output(&self, bytes: &[u8]) {
        let b64 = data_encoding::BASE64.encode(bytes);
        self.broadcast(RemoteHostMsg::Output { b64 });
    }

    /// Full terminal screen (serialized), to every viewer of an app share.
    ///
    /// The app-share companion to `broadcast_output`: an app viewer's grid
    /// is not a live stream it has followed since join — the host may have
    /// switched which terminal fronts the share — so the frame resets the
    /// viewer's grid (`Snapshot` semantics: reset, resize, write) rather
    /// than appending. Sent when the active terminal changes and when a
    /// joiner's catch-up asks for current state.
    pub fn broadcast_term_snapshot(&self, b64: String, cols: u16, rows: u16) {
        self.broadcast(RemoteHostMsg::Snapshot { b64, cols, rows });
    }

    /// PTY grid size changed on the host.
    pub fn broadcast_resize(&self, cols: u16, rows: u16) {
        *self.size.lock().unwrap() = (cols, rows);
        self.broadcast(RemoteHostMsg::Resize { cols, rows });
    }

    /// Full mirrored-store state, to every viewer (app shares, v3).
    pub fn broadcast_app_snapshot(&self, state: serde_json::Value) {
        self.broadcast(RemoteHostMsg::AppSnapshot { state });
    }

    /// One store action the host executed, for viewers to replay (v3).
    pub fn broadcast_action_applied(&self, name: &str, args: &serde_json::Value) {
        self.broadcast(RemoteHostMsg::ActionApplied {
            name: name.to_string(),
            args: args.clone(),
        });
    }

    /// Host clipboard contents changed (v3). `seq` is the watcher's
    /// monotonic counter, so a viewer can drop a stale frame that raced a
    /// reconnect snapshot.
    pub fn broadcast_clip_sync(&self, seq: u64, text: &str) {
        self.broadcast(RemoteHostMsg::ClipSync {
            seq,
            text: text.to_string(),
        });
    }

    /// Answer to a client Rpc (v3).
    pub fn broadcast_rpc_result(
        &self,
        id: u64,
        ok: Option<serde_json::Value>,
        err: Option<String>,
    ) {
        self.broadcast(RemoteHostMsg::RpcResult { id, ok, err });
    }

    /// Remote-proxy response head and body (v3).
    pub fn broadcast_proxy_res(&self, id: u64, head: String, body: Option<String>) {
        self.broadcast(RemoteHostMsg::ProxyRes { id, head, body });
    }

    /// Route one agent session event to every viewer.
    ///
    /// Unlike terminal output there is no buffering dance: an agent viewer's
    /// catch-up is a list of past events the host already holds, delivered in
    /// one frame the moment it joins, so there is no window in which live
    /// events would have to be queued behind a snapshot that has not arrived.
    pub fn broadcast_agent_event(&self, event: serde_json::Value) {
        self.broadcast(RemoteHostMsg::AgentEvent { event });
    }

    /// Tell whoever lost an approval race that it was decided without them.
    pub fn broadcast_decision_taken(&self, call_id: &str, by: &str) {
        self.broadcast(RemoteHostMsg::AgentDecisionTaken {
            call_id: call_id.to_string(),
            by: by.to_string(),
        });
    }

    /// Start queuing output for a joining viewer.
    /// MUST be called under the app's per-session dispatch lock, at the same
    /// point where the snapshot marker enters the webview channel, and always
    /// *before* the snapshot is requested (see `SessionBridge`).
    pub fn begin_buffering(&self, viewer: u64) {
        if let Some(v) = self.viewers.lock().unwrap().get_mut(&viewer) {
            // Never re-buffer a viewer that is already live: that would strand
            // every subsequent frame in a queue with nothing left to flush it.
            if matches!(v.state, ViewerState::Live) {
                return;
            }
            v.state = ViewerState::Buffering(Vec::new());
        }
    }

    /// Deliver the snapshot produced by the webview and flush the buffer.
    pub fn snapshot_ready(&self, viewer: u64, snapshot_b64: String, cols: u16, rows: u16) {
        let mut viewers = self.viewers.lock().unwrap();
        if let Some(v) = viewers.get_mut(&viewer) {
            let _ = v.tx.send(RemoteHostMsg::Snapshot {
                b64: snapshot_b64,
                cols,
                rows,
            });
            if let ViewerState::Buffering(buf) = std::mem::replace(&mut v.state, ViewerState::Live)
            {
                for msg in buf {
                    let _ = v.tx.send(msg);
                }
            }
        }
    }

    pub fn set_title(&self, title: &str) {
        *self.title.lock().unwrap() = title.to_string();
    }

    /// The access this viewer holds right now; None once it is gone (kicked,
    /// stalled out, left, or share stopped). Read under the viewers lock so
    /// the frame-read loop judges every frame by the level in force when it
    /// is processed, never by a copy taken at join — that re-read is what
    /// makes a mid-session access change bite on the very next frame.
    fn viewer_access(&self, viewer: u64) -> Option<Access> {
        self.viewers.lock().unwrap().get(&viewer).map(|v| v.access)
    }

    /// Change one connected viewer's access, live. Updates the state the
    /// frame-read loop consults and tells that viewer with a fresh Mode
    /// carrying both fields coherently: `read_only` is what a v1 client's
    /// gate runs on, `access` (v2 onwards — a v1 frame has no place for it)
    /// is what a v2 client reads; both always agree, the join-time rule.
    ///
    /// Sent on the viewer's channel directly — the join-time Mode's own path.
    /// Mode is not a stream-ordered frame (join sends it before the snapshot
    /// already), so overtaking a snapshot still being buffered is harmless,
    /// and a gate change must not wait behind one.
    ///
    /// Returns false if the viewer is not connected (already kicked, stalled
    /// out, or never existed); nothing is sent then.
    pub fn set_viewer_access(&self, viewer: u64, access: Access) -> bool {
        let changed = {
            let mut viewers = self.viewers.lock().unwrap();
            match viewers.get_mut(&viewer) {
                Some(v) => {
                    v.access = access;
                    let _ = v.tx.send(RemoteHostMsg::Mode {
                        read_only: access.read_only(),
                        access: (v.proto >= 2).then_some(access),
                    });
                    true
                }
                None => false,
            }
        };
        if changed {
            // The roster carries per-viewer levels, so every host UI learns
            // the change through the same presence path as join/leave.
            self.presence();
        }
        changed
    }

    pub fn viewer_count(&self) -> u32 {
        self.viewers.lock().unwrap().len() as u32
    }

    /// The lowest protocol version a viewer must speak for this share's kind.
    ///
    /// Terminal payloads have existed since v1. Agent payloads exist only
    /// from v2, and a v1 decoder fails the whole connection on a variant it
    /// does not know — so a too-old viewer is refused up front with a reason
    /// it CAN parse, instead of being admitted to a session that could only
    /// stay blank. Every future share kind gets this guard for free by
    /// naming its floor here.
    fn tab_type_min_proto(&self) -> u32 {
        match self.tab_type {
            SharedTabType::Terminal => REMOTE_PROTO_V1,
            SharedTabType::Agent => 2,
            SharedTabType::App => 3,
        }
    }

    /// Whether the join window has closed. The ttl is an invite-link expiry:
    /// it bounds *joining*, never the session — viewers already connected are
    /// untouched however long they stay.
    fn join_window_closed(&self) -> bool {
        self.ttl.is_some_and(|ttl| self.created_at.elapsed() >= ttl)
    }

    fn end_all(&self, reason: &str) {
        let mut viewers = self.viewers.lock().unwrap();
        for v in viewers.values() {
            let _ = v.tx.send(RemoteHostMsg::End {
                reason: reason.to_string(),
            });
        }
        viewers.clear();
        // Still under the viewers lock: joiners check `stopped` under that
        // same lock, so a racing viewer either landed in the map above (and
        // received End) or observes `stopped` and bails — never neither.
        *self.stopped.lock().unwrap() = true;
    }
}

pub struct ShareOpts {
    /// Tab naming is the app's concern; it only rides along for `Welcome`.
    pub title: String,
    /// The tab runtime being shared. Replaces the retired callback bag along
    /// with the explicit cols/rows/tab_type — the source itself knows what
    /// it is (`kind`) and what grid it has (`grid`).
    pub source: Arc<dyn ShareSource>,
    /// The set of connected viewers changed; delivers the roster (sorted by
    /// id, names and access included) so a host UI can list individuals and
    /// kick by id. The wire `Presence` frame keeps carrying only the count —
    /// viewers have no business knowing each other's ids. A UI concern, not
    /// a source concern, which is why it is not a trait method.
    pub on_presence: PresenceCallback,
    /// Join window measured from share creation, not a session limit: joins
    /// after `created_at + ttl` are refused with `End { "ticket expired" }`,
    /// while viewers already connected are untouched (invite-link semantics —
    /// an expired invite stops admitting people, it does not eject the ones
    /// already in the room). None = the ticket never expires.
    pub ttl: Option<std::time::Duration>,
    /// What viewers of this share may do.
    ///
    /// Enforcement must live host-side: a client-side gate cannot stop a
    /// hostile client from crafting the frame anyway. Resize and viewport
    /// reports stay honoured at every level — the tmux-style fit negotiation
    /// is not input.
    pub access: Access,
}

#[derive(Default)]
pub struct RemoteHub {
    endpoint: tokio::sync::Mutex<Option<Endpoint>>,
    shares: Mutex<HashMap<String, Arc<Share>>>,
    next_viewer: AtomicU64,
}

impl RemoteHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn share(&self, id: &str) -> Option<Arc<Share>> {
        self.shares.lock().unwrap().get(id).cloned()
    }

    /// Bind (once) the hosting endpoint and start the accept loop.
    async fn ensure_endpoint(self: &Arc<Self>) -> Result<Endpoint> {
        let mut guard = self.endpoint.lock().await;
        if let Some(ep) = guard.as_ref() {
            return Ok(ep.clone());
        }
        let ep = Endpoint::builder(iroh::endpoint::presets::N0)
            .alpns(vec![REMOTE_ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| anyhow!("iroh bind failed: {e}"))?;
        // Wait briefly for relay/addressing to come up so tickets are dialable
        // from outside the LAN; offline hosting on a LAN still works when this
        // times out.
        let _ = tokio::time::timeout(Duration::from_secs(5), ep.online()).await;
        let accept_ep = ep.clone();
        let hub = self.clone();
        tokio::spawn(async move {
            while let Some(incoming) = accept_ep.accept().await {
                let hub = hub.clone();
                tokio::spawn(async move {
                    if let Err(e) = hub.handle_incoming(incoming).await {
                        eprintln!("[remote] incoming connection error: {e:#}");
                    }
                });
            }
        });
        *guard = Some(ep.clone());
        Ok(ep)
    }

    async fn handle_incoming(self: Arc<Self>, incoming: iroh::endpoint::Incoming) -> Result<()> {
        let conn = incoming.await.context("handshake failed")?;
        let (send, mut recv) = conn.accept_bi().await.context("accept_bi failed")?;

        let hello: RemoteClientMsg = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut recv))
            .await
            .context("hello timeout")??;
        let (name, proto, share_id, token) = match hello {
            RemoteClientMsg::Hello {
                name,
                proto,
                share,
                token,
            } => (name, proto, share, token),
            _ => bail!("first frame was not Hello"),
        };
        // Negotiated, not required to match. Clients built against v1 are out
        // there and still welcome; what would break them is being sent a frame
        // their decoder has never heard of, so the agreed version is carried
        // through to everything this connection sends.
        let effective_proto = negotiate(proto);
        let share = self
            .share(&share_id)
            .ok_or_else(|| anyhow!("unknown share {share_id}"))?;
        if share.token != token {
            bail!("bad token for share {share_id}");
        }
        // The ttl closes the JOIN window only (invite-link semantics): a
        // ticket presented too late is turned away with a clear reason, while
        // viewers that entered in time keep their session untouched.
        if share.join_window_closed() {
            refuse(send, &conn, "ticket expired").await;
            return Ok(());
        }
        // A share kind younger than the viewer's protocol: every payload that
        // makes this share what it is would be unparseable to it. Refused
        // before Welcome, with a frame v1 already knows how to read — the
        // alternative is admitting it to a session that must stay blank.
        if effective_proto < share.tab_type_min_proto() {
            refuse(send, &conn, "this share needs a newer Tabverse").await;
            return Ok(());
        }

        let viewer_id = self.next_viewer.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel::<RemoteHostMsg>();
        let accepted = {
            let mut viewers = share.viewers.lock().unwrap();
            // share_stop can race us between the share lookup above and this
            // insertion: end_all clears the map and flips `stopped` while
            // holding the viewers lock, so checking it under that same lock
            // closes the window. Inserting into a stopped share would strand
            // this viewer waiting forever for a snapshot nobody will take.
            if *share.stopped.lock().unwrap() {
                false
            } else {
                let (cols, rows) = *share.size.lock().unwrap();
                let title = share.title.lock().unwrap().clone();
                let _ = tx.send(RemoteHostMsg::Welcome {
                    proto: effective_proto,
                    tab_title: title,
                    cols,
                    rows,
                    // Only from v2: a v1 client has no field for it and only
                    // ever shared terminals anyway.
                    tab_type: (effective_proto >= 2).then_some(share.tab_type),
                });
                // Every viewer is told its capabilities up front — a
                // read-write share still sends Mode { read_only: false } so
                // clients render the badge from fact, not assumption. Queued
                // before the viewer becomes visible to broadcasts, so Mode
                // deterministically precedes the snapshot on the wire. The
                // level is the share's default; from here on the viewer owns
                // its own copy, adjustable live via set_viewer_access.
                let initial_access = share.access;
                let _ = tx.send(RemoteHostMsg::Mode {
                    read_only: initial_access.read_only(),
                    // From v2 the level itself travels; v1 gets only the bit
                    // above, which is all it has a field for.
                    access: (effective_proto >= 2).then_some(initial_access),
                });
                // An agent viewer's catch-up is already in hand here, so it
                // goes out with the handshake rather than through the
                // buffering dance a terminal needs — there is no window in
                // which live events must queue behind a snapshot that has not
                // been produced yet. After Mode, so a client knows what it may
                // do before it is shown anything to do it with.
                if share.tab_type == SharedTabType::Agent && effective_proto >= 2 {
                    let events = share.source.history();
                    if !events.is_empty() {
                        let _ = tx.send(RemoteHostMsg::AgentSnapshot { events });
                    }
                }
                viewers.insert(
                    viewer_id,
                    Viewer {
                        proto: effective_proto,
                        tx,
                        // A terminal viewer waits in Buffering until the
                        // webview hands back a snapshot; that is what the
                        // buffer is for. An agent viewer has already been sent
                        // everything it missed, so there is nothing to wait
                        // behind — leaving it buffering would strand every
                        // later event in a queue nothing ever flushes. An
                        // app viewer is the agent's case wearing the app's
                        // clothes: its catch-up is one AppSnapshot frame the
                        // source answers with directly (and reconciliation
                        // later re-sends the same way), so buffering it
                        // strands the snapshot in a queue nothing flushes —
                        // the field bug where a joiner saw no tabs at all.
                        state: if share.tab_type == SharedTabType::Agent
                            || share.tab_type == SharedTabType::App
                        {
                            ViewerState::Live
                        } else {
                            ViewerState::Buffering(Vec::new())
                        },
                        name: name.clone(),
                        access: initial_access,
                        viewport: None,
                    },
                );
                true
            }
        };
        if !accepted {
            refuse(send, &conn, "host stopped sharing").await;
            return Ok(());
        }
        share.presence();
        // Ask the source for a snapshot; it will call begin_buffering at the
        // exact stream position and snapshot_ready when the state arrives.
        share.source.request_snapshot(viewer_id);

        // Writer: fan messages out to the wire. It finishes exactly when this
        // viewer's sender disappears from the share (kick, stall drop, share
        // stop) with every queued frame — End included — flushed and acked.
        let mut writer = tokio::spawn(write_loop(send, rx));

        // Reader: viewer input. Torn down either by the viewer disconnecting
        // (read error) or by the host removing the viewer (writer completes).
        // Without the second arm, a kicked viewer's connection would stay
        // open and its frames would keep being processed.
        let read_result: Result<()> = {
            let read_fut = async {
                loop {
                    let msg: RemoteClientMsg = read_frame(&mut recv).await?;
                    match msg {
                        RemoteClientMsg::Input { b64 } => {
                            // Access is enforced here, on the host: a
                            // client-side gate cannot stop a hostile client
                            // from crafting Input frames. Resize/viewport
                            // reports below stay honored — the tmux-style fit
                            // negotiation is not input.
                            //
                            // The kind gate mirrors the agent frames below:
                            // raw bytes are the terminal's input shape. A
                            // crafted Input frame into an agent share is
                            // dropped here, before the source — the source
                            // must never be the one asked to refuse it. An
                            // app share is admitted alongside the terminal:
                            // its viewers type into the host's ACTIVE
                            // terminal (the app source forwards the bytes to
                            // the webview, which owns "active"), so Input is
                            // that share's steering shape too.
                            if !matches!(
                                share.tab_type,
                                SharedTabType::Terminal | SharedTabType::App
                            ) {
                                continue;
                            }
                            // This viewer's CURRENT level, looked up fresh on
                            // every frame: set_viewer_access changes it
                            // mid-session and the very next keystroke must be
                            // judged by the new level. None means a concurrent
                            // kick removed us — a removed viewer's keystrokes
                            // must not reach the PTY.
                            let Some(access) = share.viewer_access(viewer_id) else {
                                continue;
                            };
                            if !access.may_steer() {
                                continue;
                            }
                            let bytes = data_encoding::BASE64
                                .decode(b64.as_bytes())
                                .context("input b64")?;
                            if let Err(e) = share.source.inject_input(
                                viewer_id,
                                access,
                                InputPayload::Bytes(bytes),
                            ) {
                                eprintln!(
                                    "[remote] input from viewer {viewer_id} not applied: {e:#}"
                                );
                            }
                        }
                        RemoteClientMsg::Resize { cols, rows } => {
                            if let Some(v) = share.viewers.lock().unwrap().get_mut(&viewer_id) {
                                v.viewport = Some((cols, rows));
                            }
                            share.notify_viewport();
                        }
                        RemoteClientMsg::Ping => {
                            if let Some(v) = share.viewers.lock().unwrap().get(&viewer_id) {
                                let _ = v.tx.send(RemoteHostMsg::Pong);
                            }
                        }
                        RemoteClientMsg::Hello { .. } => bail!("unexpected Hello"),
                        // Every one of these is checked here, on the host.
                        // A client-side gate stops an honest client and
                        // nothing else.
                        RemoteClientMsg::AgentPrompt { text } => {
                            if share.tab_type != SharedTabType::Agent
                                && share.tab_type != SharedTabType::App
                            {
                                continue;
                            }
                            // removed viewer reads as None and is dropped.
                            let Some(access) = share.viewer_access(viewer_id) else {
                                continue;
                            };
                            if !access.may_steer() {
                                continue;
                            }
                            if let Err(e) = share.source.inject_input(
                                viewer_id,
                                access,
                                InputPayload::AgentPrompt { text },
                            ) {
                                eprintln!(
                                    "[remote] prompt from viewer {viewer_id} not applied: {e:#}"
                                );
                            }
                        }
                        RemoteClientMsg::AgentAnswer {
                            call_id,
                            allow,
                            reason,
                        } => {
                            // Steering and approving are separate powers: a
                            // viewer allowed to talk to the agent is not
                            // thereby allowed to authorise what it does.
                            if share.tab_type != SharedTabType::Agent {
                                continue;
                            }
                            // Current level, fresh per frame (see Input); a
                            // removed viewer reads as None and is dropped.
                            let Some(access) = share.viewer_access(viewer_id) else {
                                continue;
                            };
                            if !access.may_approve() {
                                continue;
                            }
                            match share.source.inject_input(
                                viewer_id,
                                access,
                                InputPayload::AgentAnswer {
                                    call_id: call_id.clone(),
                                    allow,
                                    reason,
                                },
                            ) {
                                Ok(InputOutcome::Applied) => {}
                                Ok(InputOutcome::Raced) => {
                                    // Losing a race is a normal outcome, and
                                    // the one who lost has to see why their
                                    // answer changed nothing.
                                    share.broadcast_decision_taken(&call_id, "somebody else");
                                }
                                Err(e) => eprintln!(
                                    "[remote] answer from viewer {viewer_id} not applied: {e:#}"
                                ),
                            }
                        }
                        RemoteClientMsg::AgentCancel => {
                            // App shares too — same fronting rule as the
                            // prompt above.
                            if share.tab_type != SharedTabType::Agent
                                && share.tab_type != SharedTabType::App
                            {
                                continue;
                            }
                            // Current level, fresh per frame (see Input); a
                            // removed viewer reads as None and is dropped.
                            let Some(access) = share.viewer_access(viewer_id) else {
                                continue;
                            };
                            if !access.may_steer() {
                                continue;
                            }
                            if let Err(e) = share.source.inject_input(
                                viewer_id,
                                access,
                                InputPayload::AgentCancel,
                            ) {
                                eprintln!(
                                    "[remote] cancel from viewer {viewer_id} not applied: {e:#}"
                                );
                            }
                        }
                        RemoteClientMsg::Rpc { id, cmd, args } => {
                            if share.tab_type != SharedTabType::App {
                                continue;
                            }
                            let Some(access) = share.viewer_access(viewer_id) else {
                                continue;
                            };
                            if let Err(e) = share.source.inject_input(
                                viewer_id,
                                access,
                                InputPayload::Rpc { id, cmd, args },
                            ) {
                                eprintln!(
                                    "[remote] rpc from viewer {viewer_id} not applied: {e:#}"
                                );
                            }
                        }
                        RemoteClientMsg::Action { name, args } => {
                            if share.tab_type != SharedTabType::App {
                                continue;
                            }
                            let Some(access) = share.viewer_access(viewer_id) else {
                                continue;
                            };
                            if !access.may_steer() {
                                continue;
                            }
                            if let Err(e) = share.source.inject_input(
                                viewer_id,
                                access,
                                InputPayload::Action { name, args },
                            ) {
                                eprintln!(
                                    "[remote] action from viewer {viewer_id} not applied: {e:#}"
                                );
                            }
                        }
                        RemoteClientMsg::ClipPush { text } => {
                            if share.tab_type != SharedTabType::App {
                                continue;
                            }
                            let Some(access) = share.viewer_access(viewer_id) else {
                                continue;
                            };
                            if !access.may_steer() {
                                continue;
                            }
                            if let Err(e) = share.source.inject_input(
                                viewer_id,
                                access,
                                InputPayload::ClipPush { text },
                            ) {
                                eprintln!(
                                    "[remote] clip push from viewer {viewer_id} not applied: {e:#}"
                                );
                            }
                        }
                        RemoteClientMsg::ProxyReq { id, head, body } => {
                            if share.tab_type != SharedTabType::App {
                                continue;
                            }
                            let Some(access) = share.viewer_access(viewer_id) else {
                                continue;
                            };
                            if !access.may_steer() {
                                continue;
                            }
                            if let Err(e) = share.source.inject_input(
                                viewer_id,
                                access,
                                InputPayload::ProxyReq { id, head, body },
                            ) {
                                eprintln!(
                                    "[remote] proxy req from viewer {viewer_id} not applied: {e:#}"
                                );
                            }
                        }
                    }
                }
            };
            tokio::select! {
                r = read_fut => r,
                _ = &mut writer => Ok(()),
            }
        };

        // Presence and viewport only need recomputing if we were still in the
        // map — a kicked or share-stopped viewer was already removed (and the
        // change already announced) by the code that removed it.
        let was_present = share.viewers.lock().unwrap().remove(&viewer_id).is_some();
        if was_present {
            share.notify_viewport();
            share.presence();
        }
        writer.abort();
        conn.close(0u32.into(), b"bye");
        // Normal disconnects surface as read errors; log only.
        if let Err(e) = read_result {
            eprintln!("[remote] viewer {viewer_id} ({name}) left: {e}");
        }
        Ok(())
    }

    /// Start sharing; returns the share plus a dialable ticket string.
    pub async fn share_start(self: &Arc<Self>, opts: ShareOpts) -> Result<(Arc<Share>, String)> {
        let ep = self.ensure_endpoint().await?;
        // A gridless source travels as 0x0 on the wire, so a client that
        // tries to lay a grid out gets an obvious answer, not a plausible
        // wrong one.
        let size = opts
            .source
            .grid()
            .map(|v| (v.cols, v.rows))
            .unwrap_or((0, 0));
        let tab_type = opts.source.kind();
        let share = Arc::new(Share {
            id: random_token()[..10].to_string(),
            token: random_token(),
            title: Mutex::new(opts.title),
            size: Mutex::new(size),
            source: opts.source,
            on_presence: opts.on_presence,
            viewers: Mutex::new(HashMap::new()),
            stopped: Mutex::new(false),
            created_at: Instant::now(),
            ttl: opts.ttl,
            access: opts.access,
            tab_type,
        });
        self.shares
            .lock()
            .unwrap()
            .insert(share.id.clone(), share.clone());
        // Nothing above this line can fail any more, and no ticket exists
        // yet: the source gets its fan-out handle before the first viewer
        // can possibly knock, so no output it produces after this call can
        // miss the share.
        share.source.bind(ShareBinding {
            share: share.clone(),
            hub: self.clone(),
        });
        let ticket = ShareTicket {
            addr: ep.addr(),
            share: share.id.clone(),
            token: share.token.clone(),
            // The ticket names the best version its creator speaks, so a
            // joiner from a newer build knows to introduce itself at ours
            // rather than at a version this host would have to refuse.
            proto: Some(REMOTE_PROTO_VERSION),
        };
        Ok((share, ticket.encode()))
    }

    pub fn share_stop(&self, share_id: &str) {
        if let Some(share) = self.shares.lock().unwrap().remove(share_id) {
            share.end_all("host stopped sharing");
        }
    }

    /// Kick a single viewer: it receives `End { "removed by host" }`, its
    /// queued frames are drained to the wire and only its connection is
    /// dropped; other viewers are untouched and presence updates. Returns
    /// whether the viewer was actually connected.
    pub fn share_kick(&self, share_id: &str, viewer: u64) -> bool {
        let Some(share) = self.share(share_id) else {
            return false;
        };
        let removed = {
            let mut viewers = share.viewers.lock().unwrap();
            // Same discipline as the stop/join race fix: `stopped` is read
            // under the viewers lock, so a kick racing end_all cannot touch a
            // share that is already tearing every viewer down.
            if *share.stopped.lock().unwrap() {
                false
            } else if let Some(v) = viewers.remove(&viewer) {
                // Queue End *before* the sender drops with `v`: the write
                // loop drains everything already queued, so the frame still
                // reaches the wire, and the loop then finishing is exactly
                // what tears down this one viewer's connection (see
                // handle_incoming).
                let _ = v.tx.send(RemoteHostMsg::End {
                    reason: "removed by host".to_string(),
                });
                true
            } else {
                false
            }
        };
        if removed {
            // The kicked viewer may have been the one constraining the joint
            // viewport; recompute both the fit and the roster for the rest.
            share.notify_viewport();
            share.presence();
        }
        removed
    }

    /// Change one viewer's access on one share, live: updates the per-viewer
    /// state the frame-read loop consults, resends Mode to that viewer so its
    /// own gate and badge follow, and refreshes presence for every host UI.
    /// Errors name what was missing — an unknown share and a viewer that
    /// already left are different mistakes, and a typo in either must not
    /// pass for success.
    pub fn set_viewer_access(&self, share_id: &str, viewer: u64, access: Access) -> Result<()> {
        let share = self
            .share(share_id)
            .ok_or_else(|| anyhow!("unknown share {share_id}"))?;
        if !share.set_viewer_access(viewer, access) {
            bail!("no viewer {viewer} connected to share {share_id}");
        }
        Ok(())
    }
}

async fn write_loop(
    mut send: iroh::endpoint::SendStream,
    mut rx: mpsc::UnboundedReceiver<RemoteHostMsg>,
) {
    while let Some(msg) = rx.recv().await {
        if write_frame(&mut send, &msg).await.is_err() {
            break;
        }
    }
    let _ = send.finish();
    // The channel closing is how a viewer gets dropped (kick / stall / share
    // stop), and the caller closes the connection as soon as we return — but
    // `finish` only *buffers* the final frames. Wait (bounded) for the peer
    // to acknowledge them, so the close cannot discard the very End frame
    // that explains the disconnect.
    let _ = tokio::time::timeout(END_FLUSH_TIMEOUT, send.stopped()).await;
}

/// Turn a joiner away with a single `End` frame explaining why, drained to
/// the wire before the connection closes.
async fn refuse(send: iroh::endpoint::SendStream, conn: &iroh::endpoint::Connection, reason: &str) {
    let (tx, rx) = mpsc::unbounded_channel::<RemoteHostMsg>();
    let _ = tx.send(RemoteHostMsg::End {
        reason: reason.to_string(),
    });
    drop(tx);
    // write_loop drains the queued End, finishes the stream and waits for the
    // peer's ack, so the close below cannot cut the frame off.
    write_loop(send, rx).await;
    conn.close(0u32.into(), b"bye");
}

// ------------------------------------------------------------------- join --

pub struct JoinHandle {
    tx: mpsc::UnboundedSender<RemoteClientMsg>,
    endpoint: Endpoint,
}

impl JoinHandle {
    pub fn send_input(&self, bytes: &[u8]) {
        let _ = self.tx.send(RemoteClientMsg::Input {
            b64: data_encoding::BASE64.encode(bytes),
        });
    }

    pub fn send_resize(&self, cols: u16, rows: u16) {
        let _ = self.tx.send(RemoteClientMsg::Resize { cols, rows });
    }

    pub fn ping(&self) {
        let _ = self.tx.send(RemoteClientMsg::Ping);
    }

    /// Send any client frame. The agent payloads have no dedicated helper
    /// because a viewer that is only watching should not be able to reach for
    /// one by accident; the caller says what it means.
    pub fn send(&self, msg: RemoteClientMsg) {
        let _ = self.tx.send(msg);
    }

    pub async fn leave(&self) {
        self.endpoint.close().await;
    }
}

/// Dial a ticket and stream session events to `on_event`.
/// The returned handle sends input/resize; drop + `leave()` to disconnect.
pub async fn join(
    ticket_str: &str,
    client_name: &str,
    on_event: Arc<dyn Fn(RemoteHostMsg) + Send + Sync>,
) -> Result<JoinHandle> {
    let ticket = ShareTicket::decode(ticket_str)?;
    // Announce no more than the ticket's creator can answer: a v0.0.1/v0.0.2
    // host (ticket without the field) closes the connection on any Hello
    // above 1 without sending a frame, so declaring our own best at it would
    // present a working share as a dead link.
    let proto = announce_proto(ticket.proto);
    join_as(ticket, client_name, proto, on_event).await
}

/// Join announcing a particular protocol version.
///
/// Exists so the promise that older clients keep working can be tested against
/// a real host rather than asserted about the code — and so a version mismatch
/// in the field can be reproduced deliberately. Takes the ticket already
/// decoded: `join` reads it to pick the version, and decoding twice would
/// invite the two reads to drift.
pub async fn join_as(
    ticket: ShareTicket,
    client_name: &str,
    proto: u32,
    on_event: Arc<dyn Fn(RemoteHostMsg) + Send + Sync>,
) -> Result<JoinHandle> {
    // Dedicated client endpoint: no accept ALPN, avoids dial-self edge cases.
    let ep = Endpoint::builder(iroh::endpoint::presets::N0)
        .bind()
        .await
        .map_err(|e| anyhow!("iroh bind failed: {e}"))?;
    let conn = tokio::time::timeout(
        CONNECT_TIMEOUT,
        ep.connect(ticket.addr.clone(), REMOTE_ALPN),
    )
    .await
    .context("connect timeout")?
    .map_err(|e| anyhow!("connect failed: {e}"))?;

    let (mut send, mut recv) = conn.open_bi().await.context("open_bi failed")?;
    write_frame(
        &mut send,
        &RemoteClientMsg::Hello {
            name: client_name.to_string(),
            proto,
            share: ticket.share.clone(),
            token: ticket.token.clone(),
        },
    )
    .await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<RemoteClientMsg>();

    // Writer task: our input towards the host.
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write_frame(&mut send, &msg).await.is_err() {
                break;
            }
        }
        let _ = send.finish();
    });

    // Reader task: host events towards the UI.
    let events = on_event.clone();
    tokio::spawn(async move {
        loop {
            match read_frame::<RemoteHostMsg>(&mut recv).await {
                Ok(msg) => {
                    let is_end = matches!(msg, RemoteHostMsg::End { .. });
                    events(msg);
                    if is_end {
                        break;
                    }
                }
                Err(e) => {
                    events(RemoteHostMsg::End {
                        reason: format!("connection lost: {e}"),
                    });
                    break;
                }
            }
        }
    });

    Ok(JoinHandle { tx, endpoint: ep })
}

// ------------------------------------------------------------------ tests --

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::Notify;

    type InputFn = Arc<dyn Fn(&[u8]) + Send + Sync>;
    type SnapshotRequestFn = Arc<dyn Fn(ViewerId) + Send + Sync>;
    type ViewportFn = Arc<dyn Fn(Option<Viewport>) + Send + Sync>;
    type PromptFn = Arc<dyn Fn(&str) + Send + Sync>;
    type AnswerFn = Arc<dyn Fn(&str, bool, Option<String>) -> bool + Send + Sync>;
    type CancelFn = Arc<dyn Fn() + Send + Sync>;
    type HistoryFn = Arc<dyn Fn() -> Vec<serde_json::Value> + Send + Sync>;

    /// The tests' `ShareSource`: every hook is a closure field, so a test
    /// names only what it observes and leaves the rest inert — the successor
    /// of the retired callback bag, kept on the test side of the fence.
    struct TestSource {
        kind: SharedTabType,
        grid: Option<Viewport>,
        on_input: InputFn,
        on_snapshot_request: SnapshotRequestFn,
        on_viewport: ViewportFn,
        on_prompt: PromptFn,
        on_answer: AnswerFn,
        on_cancel: CancelFn,
        on_history: HistoryFn,
    }

    impl TestSource {
        fn terminal() -> Self {
            Self {
                kind: SharedTabType::Terminal,
                grid: Some(Viewport { cols: 80, rows: 24 }),
                on_input: Arc::new(|_| {}),
                on_snapshot_request: Arc::new(|_| {}),
                on_viewport: Arc::new(|_| {}),
                on_prompt: Arc::new(|_| {}),
                // Nothing here can take an answer, so nothing here took it.
                on_answer: Arc::new(|_, _, _| false),
                on_cancel: Arc::new(|| {}),
                on_history: Arc::new(Vec::new),
            }
        }
    }

    impl ShareSource for TestSource {
        fn kind(&self) -> SharedTabType {
            self.kind
        }
        fn grid(&self) -> Option<Viewport> {
            self.grid
        }
        fn request_snapshot(&self, viewer: ViewerId) {
            (self.on_snapshot_request)(viewer)
        }
        fn history(&self) -> Vec<serde_json::Value> {
            (self.on_history)()
        }
        fn inject_input(
            &self,
            _viewer: ViewerId,
            _access: Access,
            payload: InputPayload,
        ) -> Result<InputOutcome> {
            Ok(match payload {
                InputPayload::Bytes(bytes) => {
                    (self.on_input)(&bytes);
                    InputOutcome::Applied
                }
                InputPayload::AgentPrompt { text } => {
                    (self.on_prompt)(&text);
                    InputOutcome::Applied
                }
                InputPayload::AgentAnswer {
                    call_id,
                    allow,
                    reason,
                } => {
                    if (self.on_answer)(&call_id, allow, reason) {
                        InputOutcome::Applied
                    } else {
                        InputOutcome::Raced
                    }
                }
                InputPayload::AgentCancel => {
                    (self.on_cancel)();
                    InputOutcome::Applied
                }
                // The app-share family never reaches this stub (its tests
                // drive terminal/agent shares only); the arm exists so a new
                // payload variant cannot compile-break every test below.
                InputPayload::Rpc { .. }
                | InputPayload::Action { .. }
                | InputPayload::ClipPush { .. }
                | InputPayload::ProxyReq { .. } => InputOutcome::Applied,
            })
        }
        fn apply_viewport(&self, joint: Option<Viewport>) {
            (self.on_viewport)(joint)
        }
        fn bind(&self, _binding: ShareBinding) {}
        fn unbind(&self) {}
    }

    /// Full protocol roundtrip over real iroh endpoints (localhost direct):
    /// share -> ticket -> join -> Welcome/Snapshot -> live output -> input.
    #[tokio::test(flavor = "multi_thread")]
    async fn share_join_roundtrip() -> Result<()> {
        let hub = RemoteHub::new();

        let inputs: Arc<StdMutex<Vec<u8>>> = Arc::new(StdMutex::new(Vec::new()));
        let input_notify = Arc::new(Notify::new());
        let snapshot_requests: Arc<StdMutex<Vec<u64>>> = Arc::new(StdMutex::new(Vec::new()));
        let snap_notify = Arc::new(Notify::new());

        let source = TestSource {
            on_input: {
                let inputs = inputs.clone();
                let n = input_notify.clone();
                Arc::new(move |b| {
                    inputs.lock().unwrap().extend_from_slice(b);
                    n.notify_waiters();
                })
            },
            on_snapshot_request: {
                let reqs = snapshot_requests.clone();
                let n = snap_notify.clone();
                Arc::new(move |viewer| {
                    reqs.lock().unwrap().push(viewer);
                    n.notify_waiters();
                })
            },
            ..TestSource::terminal()
        };

        let (share, ticket) = hub
            .share_start(ShareOpts {
                title: "test tab".into(),
                source: Arc::new(source),
                on_presence: Arc::new(|_| {}),
                ttl: None,
                access: Access::Steer,
            })
            .await?;

        let events: Arc<StdMutex<Vec<RemoteHostMsg>>> = Arc::new(StdMutex::new(Vec::new()));
        let ev_notify = Arc::new(Notify::new());
        let handle = {
            let events = events.clone();
            let n = ev_notify.clone();
            join(
                &ticket,
                "test viewer",
                Arc::new(move |msg| {
                    events.lock().unwrap().push(msg);
                    n.notify_waiters();
                }),
            )
            .await?
        };

        // Host app reacts to the snapshot request.
        let viewer_id = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Some(v) = snapshot_requests.lock().unwrap().first().copied() {
                    return v;
                }
                snap_notify.notified().await;
            }
        })
        .await
        .expect("snapshot request should arrive");
        share.begin_buffering(viewer_id);
        // Output arriving *after* the snapshot point gets buffered...
        share.broadcast_output(b"AFTER-SNAPSHOT");
        // ...and is flushed right after the snapshot itself.
        share.snapshot_ready(
            viewer_id,
            data_encoding::BASE64.encode(b"SNAPSHOT-STATE"),
            80,
            24,
        );
        share.broadcast_output(b"LIVE-OUTPUT");

        // Wait until the viewer saw Welcome, Snapshot and both outputs in order.
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                {
                    let evs = events.lock().unwrap();
                    let outputs: Vec<String> = evs
                        .iter()
                        .filter_map(|e| match e {
                            RemoteHostMsg::Output { b64 } => Some(
                                String::from_utf8(
                                    data_encoding::BASE64.decode(b64.as_bytes()).unwrap(),
                                )
                                .unwrap(),
                            ),
                            _ => None,
                        })
                        .collect();
                    let has_welcome = evs
                        .iter()
                        .any(|e| matches!(e, RemoteHostMsg::Welcome { tab_title, .. } if tab_title == "test tab"));
                    let snap_pos = evs
                        .iter()
                        .position(|e| matches!(e, RemoteHostMsg::Snapshot { .. }));
                    if has_welcome
                        && outputs == vec!["AFTER-SNAPSHOT".to_string(), "LIVE-OUTPUT".to_string()]
                    {
                        let Some(snap_pos) = snap_pos else { continue };
                        // Snapshot must precede all outputs.
                        let first_out = evs
                            .iter()
                            .position(|e| matches!(e, RemoteHostMsg::Output { .. }))
                            .unwrap();
                        assert!(snap_pos < first_out);
                        // A read-write share still announces its mode — and
                        // before the snapshot — so clients badge from fact,
                        // never from assumption.
                        let mode_pos = evs.iter().position(
                            |e| matches!(
                                e,
                                RemoteHostMsg::Mode {
                                    read_only: false,
                                    access: Some(Access::Steer)
                                }
                            ),
                        );
                        assert!(
                            mode_pos.is_some_and(|m| m < snap_pos),
                            "Mode {{ read_only: false }} must arrive before the snapshot"
                        );
                        return;
                    }
                }
                ev_notify.notified().await;
            }
        })
        .await
        .expect("viewer should receive welcome/snapshot/outputs in order");

        // Input path: viewer -> host PTY sink.
        handle.send_input(b"echo hi\n");
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if inputs.lock().unwrap().as_slice() == b"echo hi\n" {
                    return;
                }
                input_notify.notified().await;
            }
        })
        .await
        .expect("host should receive viewer input");

        assert_eq!(share.viewer_count(), 1);
        handle.leave().await;
        hub.share_stop(&share.id);
        Ok(())
    }

    /// Poll `pred` until true, panicking with `what` after a hard 20s cap.
    /// Plain polling (no Notify) cannot lose a wakeup between check and wait.
    async fn wait_until(what: &str, pred: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(20), async {
            while !pred() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
    }

    fn outputs_contain(evs: &[RemoteHostMsg], needle: &str) -> bool {
        evs.iter().any(|e| match e {
            RemoteHostMsg::Output { b64 } => String::from_utf8_lossy(
                &data_encoding::BASE64
                    .decode(b64.as_bytes())
                    .unwrap_or_default(),
            )
            .contains(needle),
            _ => false,
        })
    }

    fn ended_with(evs: &[RemoteHostMsg], expected: &str) -> bool {
        evs.iter()
            .any(|e| matches!(e, RemoteHostMsg::End { reason } if reason == expected))
    }

    type RecordedEvents = Arc<StdMutex<Vec<RemoteHostMsg>>>;
    type ViewerSink = Arc<dyn Fn(RemoteHostMsg) + Send + Sync>;
    type ViewportLog = Arc<StdMutex<Vec<Option<(u16, u16)>>>>;

    /// A joining client whose received frames land in a plain Vec.
    fn recording_viewer() -> (RecordedEvents, ViewerSink) {
        let events: RecordedEvents = Arc::new(StdMutex::new(Vec::new()));
        let sink = {
            let events = events.clone();
            Arc::new(move |msg| events.lock().unwrap().push(msg))
                as Arc<dyn Fn(RemoteHostMsg) + Send + Sync>
        };
        (events, sink)
    }

    /// Answer the `idx`-th snapshot request with an empty snapshot so the
    /// viewer goes live; returns that viewer's id.
    async fn complete_snapshot(share: &Share, reqs: &Arc<StdMutex<Vec<u64>>>, idx: usize) -> u64 {
        wait_until("snapshot request", || reqs.lock().unwrap().len() > idx).await;
        let viewer = reqs.lock().unwrap()[idx];
        share.begin_buffering(viewer);
        share.snapshot_ready(viewer, data_encoding::BASE64.encode(b""), 80, 24);
        viewer
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ttl_rejects_late_joins_but_keeps_connected_viewers() -> Result<()> {
        let hub = RemoteHub::new();
        let snapshot_requests: Arc<StdMutex<Vec<u64>>> = Arc::new(StdMutex::new(Vec::new()));
        let source = TestSource {
            on_snapshot_request: {
                let reqs = snapshot_requests.clone();
                Arc::new(move |viewer| reqs.lock().unwrap().push(viewer))
            },
            ..TestSource::terminal()
        };
        // Small enough to expire within the test, large enough that a
        // localhost join (connect + hello) lands inside the window even on a
        // loaded CI machine.
        let ttl = Duration::from_millis(1500);
        let (share, ticket) = hub
            .share_start(ShareOpts {
                title: "ttl tab".into(),
                source: Arc::new(source),
                on_presence: Arc::new(|_| {}),
                ttl: Some(ttl),
                access: Access::Steer,
            })
            .await?;

        // Viewer A joins inside the window and completes the handshake.
        let (events_a, sink_a) = recording_viewer();
        let handle_a = join(&ticket, "early viewer", sink_a).await?;
        complete_snapshot(&share, &snapshot_requests, 0).await;
        wait_until("viewer A snapshot", || {
            events_a
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RemoteHostMsg::Snapshot { .. }))
        })
        .await;

        // Let the join window lapse, with margin for scheduler slop.
        tokio::time::sleep(ttl + Duration::from_millis(700)).await;

        // Viewer B is late: refused with the exact reason, never welcomed.
        let (events_b, sink_b) = recording_viewer();
        let handle_b = join(&ticket, "late viewer", sink_b).await?;
        wait_until("late joiner rejection", || {
            ended_with(&events_b.lock().unwrap(), "ticket expired")
        })
        .await;
        assert!(
            !events_b
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RemoteHostMsg::Welcome { .. })),
            "an expired ticket must not admit the viewer at all"
        );

        // A is untouched: still counted and still receiving live output.
        share.broadcast_output(b"POST-EXPIRY-OUTPUT");
        wait_until("post-expiry output for viewer A", || {
            outputs_contain(&events_a.lock().unwrap(), "POST-EXPIRY-OUTPUT")
        })
        .await;
        assert_eq!(share.viewer_count(), 1);

        handle_a.leave().await;
        handle_b.leave().await;
        hub.share_stop(&share.id);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn read_only_drops_input_before_the_sink() -> Result<()> {
        let hub = RemoteHub::new();
        let inputs: Arc<StdMutex<Vec<u8>>> = Arc::new(StdMutex::new(Vec::new()));
        let snapshot_requests: Arc<StdMutex<Vec<u64>>> = Arc::new(StdMutex::new(Vec::new()));
        let viewports: ViewportLog = Arc::new(StdMutex::new(Vec::new()));
        let source = TestSource {
            on_input: {
                let inputs = inputs.clone();
                Arc::new(move |b| inputs.lock().unwrap().extend_from_slice(b))
            },
            on_snapshot_request: {
                let reqs = snapshot_requests.clone();
                Arc::new(move |viewer| reqs.lock().unwrap().push(viewer))
            },
            on_viewport: {
                let vps = viewports.clone();
                Arc::new(move |vp| vps.lock().unwrap().push(vp.map(|v| (v.cols, v.rows))))
            },
            ..TestSource::terminal()
        };
        let (share, ticket) = hub
            .share_start(ShareOpts {
                title: "read-only tab".into(),
                source: Arc::new(source),
                on_presence: Arc::new(|_| {}),
                ttl: None,
                access: Access::View,
            })
            .await?;

        let (events, sink) = recording_viewer();
        let handle = join(&ticket, "watcher", sink).await?;
        complete_snapshot(&share, &snapshot_requests, 0).await;

        // The viewer tries to type, then pings. Both ride one ordered
        // stream, so Pong arriving proves the Input frame was already
        // processed — and dropped — rather than still in flight.
        handle.send_input(b"MUST-NOT-REACH-THE-PTY");
        handle.ping();
        wait_until("pong after input", || {
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RemoteHostMsg::Pong))
        })
        .await;
        assert!(
            inputs.lock().unwrap().is_empty(),
            "a read-only share must drop viewer input before the sink"
        );

        // Output still flows towards the read-only viewer.
        share.broadcast_output(b"RO-OUTPUT");
        wait_until("output for read-only viewer", || {
            outputs_contain(&events.lock().unwrap(), "RO-OUTPUT")
        })
        .await;

        // The restriction was announced up front, before the snapshot.
        {
            let evs = events.lock().unwrap();
            let mode_pos = evs.iter().position(|e| {
                matches!(
                    e,
                    RemoteHostMsg::Mode {
                        read_only: true,
                        access: Some(Access::View)
                    }
                )
            });
            let snap_pos = evs
                .iter()
                .position(|e| matches!(e, RemoteHostMsg::Snapshot { .. }));
            assert!(
                mode_pos.is_some_and(|m| m < snap_pos.unwrap()),
                "Mode {{ read_only: true }} must arrive before the snapshot"
            );
        }

        // Viewport reports are negotiation, not input: still honored.
        handle.send_resize(101, 31);
        wait_until("viewport report", || {
            viewports.lock().unwrap().contains(&Some((101, 31)))
        })
        .await;

        handle.leave().await;
        hub.share_stop(&share.id);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn kick_removes_exactly_one_viewer() -> Result<()> {
        let hub = RemoteHub::new();
        let snapshot_requests: Arc<StdMutex<Vec<u64>>> = Arc::new(StdMutex::new(Vec::new()));
        let presence_log: Arc<StdMutex<Vec<Vec<u64>>>> = Arc::new(StdMutex::new(Vec::new()));
        let source = TestSource {
            on_snapshot_request: {
                let reqs = snapshot_requests.clone();
                Arc::new(move |viewer| reqs.lock().unwrap().push(viewer))
            },
            ..TestSource::terminal()
        };
        let (share, ticket) = hub
            .share_start(ShareOpts {
                title: "kick tab".into(),
                source: Arc::new(source),
                on_presence: {
                    let log = presence_log.clone();
                    Arc::new(move |roster: &[ViewerInfo]| {
                        log.lock()
                            .unwrap()
                            .push(roster.iter().map(|v| v.id).collect())
                    })
                },
                ttl: None,
                access: Access::Steer,
            })
            .await?;

        let (events_a, sink_a) = recording_viewer();
        let handle_a = join(&ticket, "survivor", sink_a).await?;
        let id_a = complete_snapshot(&share, &snapshot_requests, 0).await;

        let (events_b, sink_b) = recording_viewer();
        let handle_b = join(&ticket, "kicked", sink_b).await?;
        let id_b = complete_snapshot(&share, &snapshot_requests, 1).await;
        assert_eq!(share.viewer_count(), 2);

        assert!(
            hub.share_kick(&share.id, id_b),
            "kicking a connected viewer must report success"
        );
        // The kicked viewer learns why, and only it.
        wait_until("kicked viewer End", || {
            ended_with(&events_b.lock().unwrap(), "removed by host")
        })
        .await;
        // The viewer is really gone: a second kick has nothing to remove.
        assert!(!hub.share_kick(&share.id, id_b));
        assert!(!hub.share_kick("no-such-share", id_a));

        // The survivor still receives the live stream. B was removed from
        // the viewer map before this broadcast, so the frame cannot reach it.
        share.broadcast_output(b"SURVIVOR-OUTPUT");
        wait_until("survivor output", || {
            outputs_contain(&events_a.lock().unwrap(), "SURVIVOR-OUTPUT")
        })
        .await;
        assert!(
            !outputs_contain(&events_b.lock().unwrap(), "SURVIVOR-OUTPUT"),
            "a kicked viewer must not receive output broadcast after the kick"
        );
        assert!(
            !ended_with(&events_a.lock().unwrap(), "removed by host"),
            "the survivor must not see the kicked viewer's End"
        );

        // Host-side roster shrank to exactly the survivor.
        assert_eq!(
            presence_log.lock().unwrap().last().cloned(),
            Some(vec![id_a])
        );
        assert_eq!(share.viewer_count(), 1);

        handle_a.leave().await;
        handle_b.leave().await;
        hub.share_stop(&share.id);
        Ok(())
    }

    #[test]
    fn ticket_roundtrip_and_prefix() {
        // Junk must be rejected up front so a paste error surfaces as "not a
        // ticket" instead of a confusing connect failure much later.
        assert!(ShareTicket::decode("nope").is_err());
        assert!(ShareTicket::decode("tabv!!!").is_err());

        // A real ticket must survive encode -> decode unchanged: the encoded
        // string is the only thing that travels from host to viewer, so any
        // field lost here means a viewer that can never connect.
        let ticket = ShareTicket {
            addr: EndpointAddr::new(iroh::SecretKey::from_bytes(&[7u8; 32]).public()),
            share: "abc".to_string(),
            token: "tok".to_string(),
            proto: Some(REMOTE_PROTO_VERSION),
        };
        let encoded = ticket.encode();
        assert!(encoded.starts_with(TICKET_PREFIX));
        let decoded = ShareTicket::decode(&encoded).expect("own encoding must decode");
        // Derived PartialEq compares every field, proto included.
        assert_eq!(decoded, ticket);
    }

    #[test]
    fn ticket_proto_roundtrip_and_absence() {
        let base = ShareTicket {
            addr: EndpointAddr::new(iroh::SecretKey::from_bytes(&[7u8; 32]).public()),
            share: "abc".to_string(),
            token: "tok".to_string(),
            proto: None,
        };

        // Without the field the serialized shape must be exactly what
        // v0.0.1/v0.0.2 put on the wire: no "proto" key at all. (Mutation
        // check: dropping `skip_serializing_if` fails this assertion.)
        let json = serde_json::to_string(&base).expect("ticket serializes");
        assert!(
            !json.contains("proto"),
            "a ticket without the field must serialize without it, got {json}"
        );
        assert_eq!(
            ShareTicket::decode(&base.encode()).expect("decodes"),
            base,
            "absence must round-trip as absence"
        );

        // With the field, it travels — and is visibly present in the JSON, so
        // a joiner actually has something to read the version from.
        let versioned = ShareTicket {
            proto: Some(2),
            ..base.clone()
        };
        let json = serde_json::to_string(&versioned).expect("ticket serializes");
        assert!(
            json.contains("\"proto\":2"),
            "a versioned ticket must carry the field, got {json}"
        );
        assert_eq!(
            ShareTicket::decode(&versioned.encode()).expect("decodes"),
            versioned,
            "the version must survive encode -> decode"
        );

        // Golden: a v1-era ticket, as those releases produced it — three
        // fields, no proto — must still parse, and read as "no version
        // claimed". The literal is fixed on purpose: round-tripping current
        // code against itself would never notice current code drifting.
        let v1_json = format!(
            r#"{{"addr":{},"share":"abc","token":"tok"}}"#,
            serde_json::to_string(&base.addr).expect("addr serializes"),
        );
        let old: ShareTicket = serde_json::from_str(&v1_json).expect("a v1-era ticket must parse");
        assert_eq!(old.proto, None, "no field must read as no claim");
        assert_eq!(old.share, "abc");
        assert_eq!(old.token, "tok");
    }

    /// The reverse direction of compatibility: a ticket produced by this
    /// build, pasted into an old app, must still decode there.
    #[test]
    fn a_v2_ticket_still_feeds_a_v1_decoder() {
        // The ticket struct exactly as v0.0.2 shipped it
        // (git show v0.0.2:crates/tabverse-remote/src/lib.rs:77-81): a plain
        // serde derive, no deny_unknown_fields — which is what makes the
        // extra field safe. Mutation check: adding
        // #[serde(deny_unknown_fields)] here turns this test red, proving it
        // exercises unknown-field tolerance rather than passing vacuously.
        #[derive(Debug, serde::Deserialize)]
        struct V1Ticket {
            addr: EndpointAddr,
            share: String,
            token: String,
        }

        let ticket = ShareTicket {
            addr: EndpointAddr::new(iroh::SecretKey::from_bytes(&[7u8; 32]).public()),
            share: "abc".to_string(),
            token: "tok".to_string(),
            proto: Some(2),
        };
        // Decode the encoded ticket the way v0.0.2 does: strip the prefix,
        // base32, then serde into its three-field struct.
        let encoded = ticket.encode();
        let bytes = BASE32_NOPAD
            .decode(
                encoded
                    .strip_prefix(TICKET_PREFIX)
                    .expect("our own prefix")
                    .to_uppercase()
                    .as_bytes(),
            )
            .expect("our own base32");
        let old: V1Ticket =
            serde_json::from_slice(&bytes).expect("an old app must be able to decode a new ticket");
        assert_eq!(old.addr, ticket.addr);
        assert_eq!(old.share, ticket.share);
        assert_eq!(old.token, ticket.token);
    }

    // ── agent shares ─────────────────────────────────────────────────────

    /// Wait until `pred` holds over the collected frames, or give up.
    async fn until(
        seen: &Arc<StdMutex<Vec<RemoteHostMsg>>>,
        secs: u64,
        pred: impl Fn(&[RemoteHostMsg]) -> bool,
    ) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            if pred(&seen.lock().unwrap()) {
                return true;
            }
            if std::time::Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn event(n: u32) -> serde_json::Value {
        serde_json::json!({ "type": "assistant_text", "delta": format!("part {n}") })
    }

    /// Start an agent share whose history is `past`, and record what viewers do.
    struct AgentShareFixture {
        hub: Arc<RemoteHub>,
        share: Arc<Share>,
        ticket: String,
        prompts: Arc<StdMutex<Vec<String>>>,
        answers: Arc<StdMutex<Vec<(String, bool)>>>,
        cancels: Arc<StdMutex<u32>>,
        /// The latest host-side roster, as (id, access) pairs — what a host
        /// UI would render after each presence callback.
        roster: Arc<StdMutex<Vec<(u64, Access)>>>,
    }

    async fn agent_share(
        access: Access,
        past: Vec<serde_json::Value>,
    ) -> Result<AgentShareFixture> {
        let hub = RemoteHub::new();
        let prompts: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let answers: Arc<StdMutex<Vec<(String, bool)>>> = Arc::new(StdMutex::new(Vec::new()));
        let cancels = Arc::new(StdMutex::new(0u32));
        let roster: Arc<StdMutex<Vec<(u64, Access)>>> = Arc::new(StdMutex::new(Vec::new()));

        let p = prompts.clone();
        let a = answers.clone();
        let c = cancels.clone();
        // The real adapter, fed by recording hooks — the same shape the app's
        // glue builds from its agent registry. `set_broadcast` stays inert:
        // these tests drive the share's fan-out directly.
        let source = source::agent::AgentSource::new(source::agent::AgentHooks {
            prompt: Arc::new(move |text| p.lock().unwrap().push(text.to_string())),
            answer: Arc::new(move |id, allow, _| {
                let mut seen = a.lock().unwrap();
                // First answer wins; a later one lost the race.
                let first = seen.is_empty();
                seen.push((id.to_string(), allow));
                first
            }),
            cancel: Arc::new(move || *c.lock().unwrap() += 1),
            history: Arc::new(move || past.clone()),
            set_broadcast: Arc::new(|_| {}),
        });
        let (share, ticket) = hub
            .share_start(ShareOpts {
                title: "Agent".into(),
                source: Arc::new(source),
                on_presence: {
                    let roster = roster.clone();
                    Arc::new(move |r: &[ViewerInfo]| {
                        *roster.lock().unwrap() = r.iter().map(|v| (v.id, v.access)).collect();
                    })
                },
                ttl: None,
                access,
            })
            .await?;
        Ok(AgentShareFixture {
            hub,
            share,
            ticket,
            prompts,
            answers,
            cancels,
            roster,
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_viewer_joining_late_can_reconstruct_the_whole_run() -> Result<()> {
        // The criterion: snapshot plus the increments that follow must equal
        // what the host has, in order and with nothing doubled.
        let past = vec![event(1), event(2), event(3)];
        let f = agent_share(Access::Steer, past.clone()).await?;

        let seen: Arc<StdMutex<Vec<RemoteHostMsg>>> = Arc::new(StdMutex::new(Vec::new()));
        let handle = {
            let s = seen.clone();
            join(
                &f.ticket,
                "late",
                Arc::new(move |m| s.lock().unwrap().push(m)),
            )
            .await?
        };
        assert!(
            until(&seen, 20, |ms| ms
                .iter()
                .any(|m| matches!(m, RemoteHostMsg::AgentSnapshot { .. })))
            .await,
            "a viewer that arrives mid-run must be given what it missed"
        );

        f.share.broadcast_agent_event(event(4));
        f.share.broadcast_agent_event(event(5));
        assert!(
            until(&seen, 20, |ms| ms
                .iter()
                .filter(|m| matches!(m, RemoteHostMsg::AgentEvent { .. }))
                .count()
                == 2)
            .await,
            "and then the live ones"
        );

        // Reassembled the way a client would.
        let mut rebuilt: Vec<serde_json::Value> = Vec::new();
        for msg in seen.lock().unwrap().iter() {
            match msg {
                RemoteHostMsg::AgentSnapshot { events } => rebuilt.extend(events.clone()),
                RemoteHostMsg::AgentEvent { event } => rebuilt.push(event.clone()),
                _ => {}
            }
        }
        let expected: Vec<serde_json::Value> = (1..=5).map(event).collect();
        assert_eq!(
            rebuilt, expected,
            "snapshot + increments must equal the host's stream"
        );

        handle.leave().await;
        f.hub.share_stop(&f.share.id);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_agent_share_turns_a_v1_client_away_before_welcome() -> Result<()> {
        let f = agent_share(Access::Steer, vec![event(1)]).await?;
        let seen: Arc<StdMutex<Vec<RemoteHostMsg>>> = Arc::new(StdMutex::new(Vec::new()));
        let handle = {
            let s = seen.clone();
            join_as(
                ShareTicket::decode(&f.ticket)?,
                "old",
                1,
                Arc::new(move |m| s.lock().unwrap().push(m)),
            )
            .await?
        };
        assert!(
            until(&seen, 20, |ms| ms.iter().any(|m| matches!(
                m,
                RemoteHostMsg::End { reason } if reason == "this share needs a newer Tabverse"
            )))
            .await,
            "a v1 hello into an agent share must be met with the exact refusal reason"
        );

        {
            let got = seen.lock().unwrap();
            assert!(
                !got.iter()
                    .any(|m| matches!(m, RemoteHostMsg::Welcome { .. })),
                "the refusal must come before any Welcome, got {got:?}"
            );
            assert!(
                !got.iter().any(|m| matches!(
                    m,
                    RemoteHostMsg::AgentSnapshot { .. } | RemoteHostMsg::AgentEvent { .. }
                )),
                "no agent frame may be sent to a v1 client, got {got:?}"
            );
        }
        assert_eq!(
            f.share.viewer_count(),
            0,
            "a refused viewer must never enter the roster"
        );

        handle.leave().await;
        f.hub.share_stop(&f.share.id);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn steering_is_allowed_at_steer_and_approving_is_not() -> Result<()> {
        // The criterion for the middle level, enforced host-side: a crafted
        // frame gets no further than an honest client's disabled button.
        let f = agent_share(Access::Steer, Vec::new()).await?;
        let seen: Arc<StdMutex<Vec<RemoteHostMsg>>> = Arc::new(StdMutex::new(Vec::new()));
        let handle = {
            let s = seen.clone();
            join(
                &f.ticket,
                "steerer",
                Arc::new(move |m| s.lock().unwrap().push(m)),
            )
            .await?
        };
        assert!(
            until(&seen, 20, |ms| ms.iter().any(|m| matches!(
                m,
                RemoteHostMsg::Mode {
                    access: Some(Access::Steer),
                    ..
                }
            )))
            .await,
            "the viewer must be told which level it has"
        );

        handle.send(RemoteClientMsg::AgentPrompt {
            text: "try the other branch".into(),
        });
        handle.send(RemoteClientMsg::AgentAnswer {
            call_id: "c1".into(),
            allow: true,
            reason: None,
        });
        handle.send(RemoteClientMsg::AgentCancel);
        tokio::time::sleep(Duration::from_millis(400)).await;

        assert_eq!(
            f.prompts.lock().unwrap().as_slice(),
            &["try the other branch".to_string()],
            "steer may talk to the agent"
        );
        assert_eq!(*f.cancels.lock().unwrap(), 1, "steer may stop a turn");
        assert!(
            f.answers.lock().unwrap().is_empty(),
            "steer must not be able to authorise anything"
        );

        handle.leave().await;
        f.hub.share_stop(&f.share.id);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn raw_terminal_bytes_into_an_agent_share_are_dropped_before_the_source() -> Result<()> {
        // A crafted Input frame from a viewer that IS allowed to steer: the
        // access check alone would let it through, so what this test pins is
        // the kind gate — raw bytes are the terminal's input shape, and an
        // agent source must never be handed them. The hub drops the frame
        // silently (same treatment as an agent frame into a terminal share)
        // and the viewer stays connected.
        let hub = RemoteHub::new();
        let inputs: Arc<StdMutex<Vec<u8>>> = Arc::new(StdMutex::new(Vec::new()));
        let source = TestSource {
            kind: SharedTabType::Agent,
            grid: None,
            on_input: {
                let inputs = inputs.clone();
                Arc::new(move |b| inputs.lock().unwrap().extend_from_slice(b))
            },
            ..TestSource::terminal()
        };
        let (share, ticket) = hub
            .share_start(ShareOpts {
                title: "Agent".into(),
                source: Arc::new(source),
                on_presence: Arc::new(|_| {}),
                ttl: None,
                access: Access::Steer,
            })
            .await?;

        let (events, sink) = recording_viewer();
        let handle = join(&ticket, "steerer", sink).await?;
        wait_until("welcome", || {
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RemoteHostMsg::Welcome { .. }))
        })
        .await;

        // The viewer types, then pings. Both ride one ordered stream, so
        // Pong arriving proves the Input frame was already processed — and
        // dropped — rather than still in flight.
        handle.send_input(b"MUST-NOT-REACH-THE-AGENT");
        handle.ping();
        wait_until("pong after input", || {
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RemoteHostMsg::Pong))
        })
        .await;
        assert!(
            inputs.lock().unwrap().is_empty(),
            "raw bytes into an agent share must be dropped before the source sees them"
        );
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RemoteHostMsg::End { .. })),
            "the drop is silent: the viewer must not be disconnected over it"
        );
        assert_eq!(share.viewer_count(), 1, "and stays on the roster");

        handle.leave().await;
        hub.share_stop(&share.id);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn raw_terminal_bytes_into_an_app_share_reach_the_source() -> Result<()> {
        // The app-share arm of the Input kind gate: a Steer viewer's raw
        // bytes are forwarded as InputPayload::Bytes — the app source routes
        // them to the host's ACTIVE terminal — while the agent share beside
        // this test proves the gate still drops what an agent source must
        // never see. View-level viewers stay dropped by the access check
        // both kinds share.
        let hub = RemoteHub::new();
        let inputs: Arc<StdMutex<Vec<u8>>> = Arc::new(StdMutex::new(Vec::new()));
        let source = TestSource {
            kind: SharedTabType::App,
            grid: None,
            on_input: {
                let inputs = inputs.clone();
                Arc::new(move |b| inputs.lock().unwrap().extend_from_slice(b))
            },
            ..TestSource::terminal()
        };
        let (share, ticket) = hub
            .share_start(ShareOpts {
                title: "Tabverse".into(),
                source: Arc::new(source),
                on_presence: Arc::new(|_| {}),
                ttl: None,
                access: Access::Steer,
            })
            .await?;

        let (events, sink) = recording_viewer();
        let handle = join(&ticket, "steerer", sink).await?;
        wait_until("welcome", || {
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RemoteHostMsg::Welcome { .. }))
        })
        .await;

        // Typed bytes, then the ordered-stream marker: Pong back proves the
        // Input frame was processed — forwarded, not dropped.
        handle.send_input(b"ls -la\r");
        handle.ping();
        wait_until("pong after input", || {
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RemoteHostMsg::Pong))
        })
        .await;
        assert_eq!(
            inputs.lock().unwrap().as_slice(),
            b"ls -la\r",
            "an app share's Steer input must reach the source as raw bytes"
        );

        handle.leave().await;
        hub.share_stop(&share.id);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_view_only_viewer_can_do_neither() -> Result<()> {
        let f = agent_share(Access::View, Vec::new()).await?;
        let seen: Arc<StdMutex<Vec<RemoteHostMsg>>> = Arc::new(StdMutex::new(Vec::new()));
        let handle = {
            let s = seen.clone();
            join(
                &f.ticket,
                "watcher",
                Arc::new(move |m| s.lock().unwrap().push(m)),
            )
            .await?
        };
        assert!(
            until(&seen, 20, |ms| ms
                .iter()
                .any(|m| matches!(m, RemoteHostMsg::Welcome { .. })))
            .await
        );
        handle.send(RemoteClientMsg::AgentPrompt {
            text: "hello".into(),
        });
        handle.send(RemoteClientMsg::AgentCancel);
        tokio::time::sleep(Duration::from_millis(400)).await;

        assert!(f.prompts.lock().unwrap().is_empty());
        assert_eq!(*f.cancels.lock().unwrap(), 0);

        handle.leave().await;
        f.hub.share_stop(&f.share.id);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn approving_works_and_losing_the_race_is_said_out_loud() -> Result<()> {
        // Two answers, one effect. The one that changed nothing has to be told
        // so — a button that silently does nothing is indistinguishable from a
        // broken one.
        let f = agent_share(Access::Approve, Vec::new()).await?;
        let seen: Arc<StdMutex<Vec<RemoteHostMsg>>> = Arc::new(StdMutex::new(Vec::new()));
        let handle = {
            let s = seen.clone();
            join(
                &f.ticket,
                "approver",
                Arc::new(move |m| s.lock().unwrap().push(m)),
            )
            .await?
        };
        assert!(
            until(&seen, 20, |ms| ms
                .iter()
                .any(|m| matches!(m, RemoteHostMsg::Welcome { .. })))
            .await
        );

        handle.send(RemoteClientMsg::AgentAnswer {
            call_id: "c1".into(),
            allow: true,
            reason: None,
        });
        handle.send(RemoteClientMsg::AgentAnswer {
            call_id: "c1".into(),
            allow: false,
            reason: None,
        });

        assert!(
            until(&seen, 20, |ms| ms.iter().any(|m| matches!(
                m,
                RemoteHostMsg::AgentDecisionTaken { .. }
            )))
            .await,
            "the losing answer must come back as such"
        );
        {
            let answers = f.answers.lock().unwrap();
            assert_eq!(answers.len(), 2, "both reached the host");
            assert!(answers[0].1, "and the first one is the one that counted");
        }
        handle.leave().await;
        f.hub.share_stop(&f.share.id);
        Ok(())
    }

    /// set_viewer_access on things that are not there: each mistake gets its
    /// own clean error naming what was missing, and nothing half-applies.
    #[tokio::test(flavor = "multi_thread")]
    async fn set_viewer_access_names_the_missing_share_or_viewer() -> Result<()> {
        let hub = RemoteHub::new();
        let err = hub
            .set_viewer_access("no-such-share", 0, Access::View)
            .expect_err("an unknown share must be an error, not a silent no-op");
        assert!(err.to_string().contains("unknown share"), "{err}");

        let (share, _ticket) = hub
            .share_start(ShareOpts {
                title: "empty".into(),
                source: Arc::new(TestSource::terminal()),
                on_presence: Arc::new(|_| {}),
                ttl: None,
                access: Access::Steer,
            })
            .await?;
        let err = hub
            .set_viewer_access(&share.id, 42, Access::View)
            .expect_err("a viewer that never joined must be an error");
        assert!(err.to_string().contains("no viewer 42"), "{err}");
        hub.share_stop(&share.id);
        Ok(())
    }

    /// The agent arms are re-gated live too: a Steer viewer downgraded to
    /// View loses the prompt, and upgraded to Approve gains a power the
    /// share default never had — proof the checks read the viewer's CURRENT
    /// level, not the share's, and not a copy from join.
    #[tokio::test(flavor = "multi_thread")]
    async fn live_access_change_regates_agent_frames() -> Result<()> {
        let f = agent_share(Access::Steer, Vec::new()).await?;
        let seen: Arc<StdMutex<Vec<RemoteHostMsg>>> = Arc::new(StdMutex::new(Vec::new()));
        let handle = {
            let s = seen.clone();
            join(
                &f.ticket,
                "colleague",
                Arc::new(move |m| s.lock().unwrap().push(m)),
            )
            .await?
        };
        assert!(
            until(&seen, 20, |ms| ms.iter().any(|m| matches!(
                m,
                RemoteHostMsg::Mode {
                    access: Some(Access::Steer),
                    ..
                }
            )))
            .await,
            "join-time Mode must carry the default level"
        );
        wait_until("roster with the joined viewer", || {
            !f.roster.lock().unwrap().is_empty()
        })
        .await;
        let viewer_id = f.roster.lock().unwrap()[0].0;

        // Downgrade, live. The change is applied synchronously host-side, so
        // once the viewer has SEEN the new Mode, any frame it sends after
        // that is guaranteed to be judged by the new level.
        f.hub
            .set_viewer_access(&f.share.id, viewer_id, Access::View)?;
        assert!(
            until(&seen, 20, |ms| ms.iter().any(|m| matches!(
                m,
                RemoteHostMsg::Mode {
                    read_only: true,
                    access: Some(Access::View)
                }
            )))
            .await,
            "the downgraded viewer must be told with a coherent Mode"
        );
        assert_eq!(
            f.roster.lock().unwrap().as_slice(),
            &[(viewer_id, Access::View)],
            "the host roster must carry the viewer's new level"
        );
        handle.send(RemoteClientMsg::AgentPrompt {
            text: "dropped while view".into(),
        });
        // Pin the drop to the View window: Pong rides the same ordered
        // stream, so its arrival proves the prompt was processed — and
        // dropped — BEFORE the upgrade below could re-open the gate.
        handle.ping();
        assert!(
            until(&seen, 20, |ms| ms
                .iter()
                .any(|m| matches!(m, RemoteHostMsg::Pong)))
            .await,
            "pong must come back after the doomed prompt"
        );

        // Upgrade to Approve: more than the share default ever granted.
        f.hub
            .set_viewer_access(&f.share.id, viewer_id, Access::Approve)?;
        assert!(
            until(&seen, 20, |ms| ms.iter().any(|m| matches!(
                m,
                RemoteHostMsg::Mode {
                    read_only: false,
                    access: Some(Access::Approve)
                }
            )))
            .await,
            "the upgraded viewer must be told with a coherent Mode"
        );
        handle.send(RemoteClientMsg::AgentPrompt {
            text: "landed at approve".into(),
        });
        handle.send(RemoteClientMsg::AgentAnswer {
            call_id: "c1".into(),
            allow: true,
            reason: None,
        });

        // One ordered stream: by the time the marker prompt landed, the
        // doomed one had already been processed — and dropped.
        wait_until("the post-upgrade prompt", || {
            !f.prompts.lock().unwrap().is_empty()
        })
        .await;
        assert_eq!(
            f.prompts.lock().unwrap().as_slice(),
            &["landed at approve".to_string()],
            "the prompt sent while View must have been dropped by the hub"
        );
        wait_until("the post-upgrade answer", || {
            !f.answers.lock().unwrap().is_empty()
        })
        .await;
        assert_eq!(
            f.answers.lock().unwrap().as_slice(),
            &[("c1".to_string(), true)],
            "Approve must unlock answering, which Steer never allowed"
        );

        handle.leave().await;
        f.hub.share_stop(&f.share.id);
        Ok(())
    }

    /// An app share end to end, through the real hub and a real join: the
    /// welcome names the app kind, and the joiner receives the snapshot the
    /// source produced. This is the discriminating test for the field
    /// report "the joiner sees no tabs at all" — if this passes, the wire
    /// and the source are honest and the fault lives in the host's
    /// webview-event seam (the no-handle path here is the fallback the
    /// seam's answer replaces).
    #[tokio::test(flavor = "multi_thread")]
    async fn an_app_share_delivers_its_snapshot_to_a_joiner() -> Result<()> {
        use crate::source::ShareSource;

        struct AppSource(StdMutex<Option<ShareBinding>>);
        impl ShareSource for AppSource {
            fn kind(&self) -> tabverse_proto::SharedTabType {
                tabverse_proto::SharedTabType::App
            }
            fn grid(&self) -> Option<Viewport> {
                None
            }
            fn request_snapshot(&self, _viewer: ViewerId) {
                if let Some(b) = self.0.lock().unwrap().as_ref() {
                    b.share.broadcast_app_snapshot(serde_json::json!({
                        "version": 1,
                        "tabs": [{"id": "t1", "type": "terminal", "title": "zsh"}],
                        "groups": [],
                        "activeTabId": "t1"
                    }));
                }
            }
            fn inject_input(
                &self,
                _v: ViewerId,
                _a: Access,
                p: InputPayload,
            ) -> Result<InputOutcome> {
                match p {
                    InputPayload::Action { .. } => Ok(InputOutcome::Applied),
                    _ => bail!("an app source cannot take terminal or agent input"),
                }
            }
            fn bind(&self, b: ShareBinding) {
                *self.0.lock().unwrap() = Some(b);
            }
            fn unbind(&self) {
                *self.0.lock().unwrap() = None;
            }
        }

        let hub = RemoteHub::new();
        let (share, ticket) = hub
            .share_start(ShareOpts {
                title: "Tabverse".into(),
                source: Arc::new(AppSource(StdMutex::new(None))),
                on_presence: Arc::new(|_| {}),
                ttl: None,
                access: Access::Steer,
            })
            .await?;

        let events: Arc<StdMutex<Vec<RemoteHostMsg>>> = Arc::new(StdMutex::new(Vec::new()));
        let handle = {
            let events = events.clone();
            join(
                &ticket,
                "phone",
                Arc::new(move |msg| {
                    events.lock().unwrap().push(msg);
                }),
            )
            .await?
        };

        let saw = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let (welcome, snapshot) = {
                    let events = events.lock().unwrap();
                    let welcome = events.iter().any(|m| {
                        matches!(
                            m,
                            RemoteHostMsg::Welcome {
                                tab_type: Some(tabverse_proto::SharedTabType::App),
                                ..
                            }
                        )
                    });
                    let snapshot = events.iter().any(|m| {
                        matches!(
                            m,
                            RemoteHostMsg::AppSnapshot { state } if state.get("tabs")
                                .and_then(|t| t.as_array())
                                .is_some_and(|a| !a.is_empty())
                        )
                    });
                    (welcome, snapshot)
                };
                if welcome && snapshot {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;

        handle.leave().await;
        hub.share_stop(&share.id);
        assert!(
            saw.unwrap_or(false),
            "an app joiner must receive the app welcome and a non-empty snapshot"
        );
        Ok(())
    }
}
