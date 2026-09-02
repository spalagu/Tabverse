//! The app-level share source: the whole interface, mirrored as state.
//!
//! WHAT THIS IS. A `ShareSource` whose kind is `App` (protocol v3): it
//! answers RPCs by dispatching into the app's own command surface, forwards
//! the store's serialized state as `AppSnapshot`, replays every action the
//! host executes as `ActionApplied` for the viewers' mirrored stores, and
//! carries the clipboard and remote-proxy frames to their owners elsewhere
//! in the app. The hub keeps policy (kind floor, access checks, version
//! withholding); this adapter is mechanism only, the same split the
//! terminal sources live by.
//!
//! WHAT IT DOES NOT DO. It does not read the store itself — the store lives
//! in the webview, in another language, and the seam this source speaks is
//! the serialized snapshot channel the app already maintains for session
//! persistence. Nor does it execute actions directly: UI actions travel to
//! the webview as events (the one direction Tauri hands us for free), and
//! the webview — which owns the reducers — applies them and reports back.
//! The Rust side never grows a second copy of what a reducer knows.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tabverse_proto::{Access, SharedTabType};
use tabverse_remote::source::{InputOutcome, InputPayload, ShareSource, ViewerId};
use tabverse_remote::{Share, ShareBinding};

/// One RPC the app knows how to run: a name and a JSON argument value.
/// Registered once per command at startup by the glue in lib.rs; the source
/// looks them up by the frame's `cmd` string.
pub type RpcHandler =
    Arc<dyn Fn(&serde_json::Value) -> Result<serde_json::Value, String> + Send + Sync>;

#[derive(Clone)]
pub struct RpcEntry {
    pub steer_only: bool,
    pub handler: RpcHandler,
}

/// Glue-injected: apply a store action in the webview (an event the React
/// side listens for), and hand back nothing — the confirmation is the
/// `ActionApplied` the webview broadcasts when the reducer runs.
pub type DispatchAction = Arc<dyn Fn(&str, &serde_json::Value) + Send + Sync>;

/// Glue-injected: the full store state, serialized the session-snapshot
/// way. Called on join and on reconnect reconciliation.
pub type SnapshotFn = Arc<dyn Fn() -> serde_json::Value + Send + Sync>;

/// Glue-injected: write text into the host clipboard (ClipPush's owner).
pub type WriteClipboard = Arc<dyn Fn(&str) + Send + Sync>;
/// Glue-injected: viewer keystrokes for the app share's terminal stream
/// leave through here as `app-share-term-input` events, for the webview
/// bridge to write into the active terminal. Swappable for the same
/// lazy-handover reason as `DispatchAction`: the construction site has no
/// AppHandle, `app_share_start` does.
pub type TermInputEmit = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// Glue-injected: run one HTTP request through the host's network (the
/// remote proxy; page_proxy's kernel under a fresh entry point).
pub type ProxyFn =
    Arc<dyn Fn(&str, Option<&str>) -> Result<(String, Option<String>), String> + Send + Sync>;

pub struct AppShareSource {
    rpc: Mutex<HashMap<String, RpcEntry>>,
    /// Swappable so the real emitter can arrive late: the construction
    /// site has no AppHandle to capture, and `app_share_start` — the one
    /// place that holds one — installs the version that forwards to the
    /// webview over the event seam (see `set_dispatch_channel`).
    dispatch_action: Mutex<DispatchAction>,
    /// The terminal-input seam's emitter, same lazy handover as
    /// `dispatch_action` (see `set_term_input_channel`).
    term_input: Mutex<TermInputEmit>,
    snapshot: SnapshotFn,
    write_clipboard: WriteClipboard,
    proxy: ProxyFn,
    browser_router: Arc<crate::remote_proxy::BrowserRequestRouter>,
    resident_browser: Mutex<Option<crate::remote_proxy::ResidentBrowserExchange>>,
    binding: Mutex<Option<ShareBinding>>,
    /// Hands the webview-ask path an AppHandle without the source holding
    /// one from construction (the app handle does not exist yet when
    /// AppState is built). Set by `app_share_start`.
    app: Mutex<Option<crate::AppHandle>>,
    /// Monotonic id for the events this source fans out, so viewers can
    /// order what they receive even across a reconnect's snapshot reset.
    seq: AtomicU64,
    /// The tab the host has front and center, named by the webview (which
    /// owns focus). App-share terminal content follows THIS tab: PTY output
    /// is tapped for its session and viewer keystrokes are written into
    /// its terminal. None = a non-terminal tab fronts, no terminal stream.
    active_tab: Mutex<Option<String>>,
    clip_watch: Mutex<Option<crate::clipboard_watch::ClipboardWatch>>,
}

/// One Single Tab share. It reuses the same v4 contribution event seam as
/// Whole App Share and may wrap a legacy source (Terminal) for v1-v3 clients.
pub struct ContributionShareSource<R: tauri::Runtime = crate::AppRuntime> {
    tab_id: String,
    app: crate::AppHandle<R>,
    base: Option<Arc<dyn ShareSource>>,
    binding: Mutex<Option<ShareBinding>>,
}

impl<R: tauri::Runtime> ContributionShareSource<R> {
    pub fn new(
        tab_id: String,
        app: crate::AppHandle<R>,
        base: Option<Arc<dyn ShareSource>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            tab_id,
            app,
            base,
            binding: Mutex::new(None),
        })
    }

    pub fn bound_share(&self) -> Option<Arc<Share>> {
        self.binding
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|binding| binding.share.clone())
    }

    fn emit(&self, name: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app.emit(name, payload);
    }
}

impl<R: tauri::Runtime> ShareSource for ContributionShareSource<R> {
    fn kind(&self) -> SharedTabType {
        match self.base.as_ref().map(|source| source.kind()) {
            Some(SharedTabType::Terminal) => SharedTabType::Terminal,
            _ => SharedTabType::Contribution,
        }
    }

    fn grid(&self) -> Option<tabverse_remote::source::Viewport> {
        self.base.as_ref().and_then(|source| source.grid())
    }

    fn request_snapshot(&self, viewer: ViewerId) {
        if let Some(base) = &self.base {
            if base.kind() == SharedTabType::Terminal {
                base.request_snapshot(viewer);
            }
        }
        self.emit(
            "tab-share-contribution-snapshot-request",
            serde_json::json!({ "viewer": viewer, "tabId": self.tab_id }),
        );
    }

    fn inject_input(
        &self,
        viewer: ViewerId,
        access: Access,
        payload: InputPayload,
    ) -> anyhow::Result<InputOutcome> {
        match payload {
            InputPayload::RemoteAck {
                tab_id,
                epoch,
                frame_seq,
            } => {
                self.emit(
                    "app-share-remote-ack",
                    serde_json::json!({
                        "viewer": viewer,
                        "tabId": tab_id,
                        "epoch": epoch,
                        "frameSeq": frame_seq,
                    }),
                );
                Ok(InputOutcome::Applied)
            }
            InputPayload::RemoteResnapshot { tab_id, epoch } => {
                self.emit(
                    "app-share-remote-resnapshot",
                    serde_json::json!({
                        "viewer": viewer,
                        "tabId": tab_id,
                        "epoch": epoch,
                    }),
                );
                Ok(InputOutcome::Applied)
            }
            InputPayload::RemoteIntent {
                tab_id,
                attachment_id,
                attachment_generation,
                intent_id,
                name,
                args,
            } => {
                self.emit(
                    "app-share-remote-intent",
                    serde_json::json!({
                        "viewer": viewer,
                        "access": access,
                        "tabId": tab_id,
                        "attachmentId": attachment_id,
                        "attachmentGeneration": attachment_generation,
                        "intentId": intent_id,
                        "name": name,
                        "args": args,
                    }),
                );
                Ok(InputOutcome::Applied)
            }
            other => self
                .base
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("semantic Tab accepts only declared v4 input"))?
                .inject_input(viewer, access, other),
        }
    }

    fn apply_viewport(&self, joint: Option<tabverse_remote::source::Viewport>) {
        if let Some(base) = &self.base {
            base.apply_viewport(joint);
        }
    }

    fn viewer_detached(&self, viewer: ViewerId) {
        if let Some(base) = &self.base {
            base.viewer_detached(viewer);
        }
    }

    fn update_browser_grant(&self, tab_id: &str, url: &str) -> anyhow::Result<()> {
        self.base
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Browser share has no network grant owner"))?
            .update_browser_grant(tab_id, url)
    }

    fn bind(&self, binding: ShareBinding) {
        if let Some(base) = &self.base {
            base.bind(binding.clone());
        }
        *self
            .binding
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(binding);
    }

    fn unbind(&self) {
        if let Some(base) = &self.base {
            base.unbind();
        }
        *self
            .binding
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }
}

impl AppShareSource {
    pub fn new(
        dispatch_action: DispatchAction,
        snapshot: SnapshotFn,
        write_clipboard: WriteClipboard,
        proxy: ProxyFn,
    ) -> Arc<Self> {
        Arc::new(Self {
            rpc: Mutex::new(HashMap::new()),
            dispatch_action: Mutex::new(dispatch_action),
            term_input: Mutex::new(Arc::new(|_| {})),
            snapshot,
            write_clipboard,
            proxy,
            browser_router: Arc::new(crate::remote_proxy::BrowserRequestRouter::default()),
            resident_browser: Mutex::new(None),
            binding: Mutex::new(None),
            app: Mutex::new(None),
            seq: AtomicU64::new(0),
            active_tab: Mutex::new(None),
            clip_watch: Mutex::new(None),
        })
    }

    fn bound(&self) -> Option<Arc<Share>> {
        self.binding
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|b| Arc::clone(&b.share))
    }

    /// The live share, if one is bound — for command paths that broadcast
    /// on the source's behalf (the snapshot deliver command).
    pub fn bound_share(&self) -> Option<Arc<Share>> {
        self.bound()
    }

    pub fn register_rpc(&self, cmd: &str, handler: RpcHandler) {
        self.rpc.lock().unwrap_or_else(|e| e.into_inner()).insert(
            cmd.to_string(),
            RpcEntry {
                steer_only: false,
                handler,
            },
        );
    }

    /// The host serializer's already-sanitized Browser rows are the explicit
    /// network grant roots for Whole App Share. Settings/private rows never
    /// reach this method because `app_snapshot_for_wire` removed them first.
    pub fn sync_browser_grants(&self, snapshot: &serde_json::Value) {
        let tabs = snapshot
            .get("tabs")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|tab| {
                let kind = tab
                    .get("kind")
                    .or_else(|| tab.get("type"))
                    .and_then(serde_json::Value::as_str)?;
                if kind != "browser" {
                    return None;
                }
                Some((
                    tab.get("id")?.as_str()?.to_string(),
                    tab.get("url")?.as_str()?.to_string(),
                ))
            })
            .collect();
        self.browser_router.sync_authorized_tabs(tabs);
    }

    pub fn authorize_browser_tab(&self, tab_id: String, url: String) -> Result<(), String> {
        self.browser_router.authorize_tab(tab_id, url)
    }

    pub fn set_resident_browser_exchange(
        &self,
        exchange: crate::remote_proxy::ResidentBrowserExchange,
    ) {
        *self
            .resident_browser
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(exchange);
    }

    /// Register one write command: Steer only. A view-level caller gets an
    /// rpcResult error naming the requirement — an explicit refusal beats
    /// the silent drop a hub-side gate would give (the call would time out
    /// with nothing said).
    pub fn register_steer_rpc(&self, cmd: &str, handler: RpcHandler) {
        self.rpc.lock().unwrap_or_else(|e| e.into_inner()).insert(
            cmd.to_string(),
            RpcEntry {
                steer_only: true,
                handler,
            },
        );
    }

    /// The full state, to every viewer. Sent on join (from the hub's
    /// request_snapshot) and on reconnect reconciliation by the glue.
    pub fn broadcast_snapshot(&self) {
        if let Some(share) = self.bound() {
            share.broadcast_app_snapshot((self.snapshot)());
        }
    }

    /// Ask the webview for a fresh snapshot: it owns the store, so the
    /// state must come from there (the same shape terminal shares use —
    /// the request travels as an event, the answer arrives through the
    /// `app_share_snapshot_deliver` command). Until the answer lands, the
    /// last snapshot a viewer holds stays; the deliver path broadcasts the
    /// fresh one to everyone, which is also exactly the reconnect
    /// reconciliation: a rejoining viewer gets it via the join flow, and
    /// any drift the disconnect window created is overwritten for all.
    pub fn request_snapshot_from_webview(&self, app: &crate::AppHandle) {
        use tauri::Emitter;
        let _ = app.emit("app-share-snapshot-request", ());
    }

    /// The handle the webview-ask path emits through. Handed over by
    /// `app_share_start`, the one place that has one and knows the share
    /// is live.
    pub fn set_app_handle(&self, app: crate::AppHandle) {
        *self.app.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
    }

    /// Hand the action path its emitter (the same lazy handover
    /// `set_app_handle` gives the snapshot path): from here on a viewer's
    /// action travels to the webview as an `app-share-action` event — the
    /// webview owns the reducers, runs the action in its store, and the
    /// store's broadcast wrapper answers every viewer with the
    /// `ActionApplied` that is the confirmation. Until this is called the
    /// construction-time no-op stands and viewer actions are dropped
    /// (there is no share to act on before `app_share_start`).
    pub fn set_dispatch_channel<R: tauri::Runtime>(&self, app: crate::AppHandle<R>) {
        let emitter = app.clone();
        self.set_dispatch(Arc::new(move |name, args| {
            use tauri::Emitter;
            let _ = emitter.emit(
                "app-share-action",
                serde_json::json!({ "name": name, "args": args }),
            );
        }));
    }

    /// Hand the terminal-input path its emitter (the same lazy handover
    /// `set_dispatch_channel` gives the action path): from here on a
    /// viewer's keystrokes travel to the webview as an
    /// `app-share-term-input` event, and the webview bridge writes them
    /// into the active terminal — the webview owns "active" and the term
    /// registry. Until this is called the construction no-op stands and
    /// viewer keystrokes are dropped (there is no share before
    /// `app_share_start`).
    pub fn set_term_input_channel<R: tauri::Runtime>(&self, app: crate::AppHandle<R>) {
        let emitter = app.clone();
        *self.term_input.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(move |bytes| {
            use base64::Engine as _;
            use tauri::Emitter;
            let _ = emitter.emit(
                "app-share-term-input",
                serde_json::json!({
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                }),
            );
        });
    }

    /// The one writer of the dispatch slot. Private so the event name and
    /// payload shape have a single home next to their sibling seam
    /// (`app-share-snapshot-request` above).
    fn set_dispatch(&self, f: DispatchAction) {
        *self
            .dispatch_action
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = f;
    }

    /// One action the webview executed; viewers replay it into their
    /// mirrored stores. Called by the webview-side bridge over the event
    /// seam, in store order.
    pub fn broadcast_action(&self, name: &str, args: &serde_json::Value) {
        if let Some(share) = self.bound() {
            share.broadcast_action_applied(name, args);
        }
    }

    /// Host clipboard contents changed (the NSPasteboard watcher's call).
    pub fn broadcast_clip(&self, text: &str) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        if let Some(share) = self.bound() {
            share.broadcast_clip_sync(seq, text);
        }
    }

    /// Start the host half of the clipboard channel: a named thread walks
    /// the general pasteboard's changeCount and every sendable change
    /// leaves as a ClipSync (see `clipboard_watch`). A no-op while one
    /// already runs — there is one app share, and its start refuses a
    /// second. The thread holds this source until it is stopped, which
    /// is why every start pairs with an unbind-side stop.
    pub fn start_clipboard_watch(self: &Arc<Self>) {
        let mut slot = self.clip_watch.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return;
        }
        let src = Arc::clone(self);
        *slot = Some(crate::clipboard_watch::ClipboardWatch::start(Arc::new(
            move |text| src.broadcast_clip(text),
        )));
    }

    /// Stop the watcher and join its thread. Idempotent.
    pub fn stop_clipboard_watch(&self) {
        if let Some(mut watch) = self
            .clip_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            watch.stop();
        }
    }

    /// Whether a watcher is installed — the lifecycle fact the tests
    /// below assert; tests only, because nothing in production asks (the
    /// watch is an implementation detail of a live binding).
    #[cfg(test)]
    fn clip_watch_installed(&self) -> bool {
        self.clip_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// One app event (a Tauri `app.emit` the glue also wants viewers to
    /// see) — carried as an action named "event", the cheapest shape that
    /// already round-trips through the mirrored store's reducer seam.
    pub fn broadcast_event(&self, name: &str, payload: &serde_json::Value) {
        self.broadcast_action(&format!("event:{name}"), payload);
    }

    /// The active-tab channel's host bookkeeping (webview → Rust): the tab
    /// the host fronts right now, or None when none does. The webview
    /// bridge reports every change; Rust keeps no second opinion about
    /// focus — the webview owns that fact.
    ///
    pub fn set_active_tab(&self, tab_id: Option<String>) {
        *self.active_tab.lock().unwrap_or_else(|e| e.into_inner()) = tab_id;
    }

    /// The fronting tab the bridge last named — what the output tap and the
    /// input seam key terminal streaming on.
    pub fn active_tab(&self) -> Option<String> {
        self.active_tab
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Incremental PTY output of the ACTIVE terminal, to every viewer (the
    /// app-share terminal stream; same Output frame a tab share uses). The
    /// caller — the helper output tap — has already decided this session is
    /// the active tab's; a no-op when no share is bound.
    pub fn broadcast_term(&self, bytes: &[u8]) {
        if let Some(share) = self.bound() {
            share.broadcast_output(bytes);
        }
    }

    /// Full serialized screen of the active terminal, to every viewer: a
    /// reset-and-rewrite (Snapshot semantics) so a viewer that followed a
    /// different stream, or joined mid-idle-shell, is made whole. Sent when
    /// the bridge switches the active terminal and when a joiner's
    /// catch-up asks. A no-op when no share is bound.
    pub fn broadcast_term_snapshot(&self, b64: &str, cols: u16, rows: u16) {
        if let Some(share) = self.bound() {
            share.broadcast_term_snapshot(b64.to_string(), cols, rows);
        }
    }
}

impl ShareSource for AppShareSource {
    fn kind(&self) -> SharedTabType {
        SharedTabType::App
    }

    /// Gridless at welcome: the app share fronts
    /// many tabs, so no single grid rides the Welcome. The ACTIVE
    /// terminal's real grid travels its snapshot instead, and viewer
    /// viewports flow back through `apply_viewport` to cap that terminal
    /// (tmux semantics — see the terminal stream's bridge).
    fn grid(&self) -> Option<tabverse_remote::source::Viewport> {
        None
    }

    fn request_snapshot(&self, _viewer: ViewerId) {
        // The real store lives in the webview; the ask travels as an event
        // and the answer arrives through app_share_snapshot_deliver, which
        // broadcasts it to every viewer (join and reconciliation both).
        let app = self.app.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(app) = app {
            self.request_snapshot_from_webview(&app);
        } else {
            // No handle (share started outside the command path, i.e. a
            // test): the seam's fallback snapshot is the honest answer.
            self.broadcast_snapshot();
        }
    }

    fn inject_input(
        &self,
        viewer: ViewerId,
        access: Access,
        payload: InputPayload,
    ) -> anyhow::Result<InputOutcome> {
        match payload {
            InputPayload::Rpc { id, cmd, args } => {
                let entry = self
                    .rpc
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&cmd)
                    .cloned();
                let Some(entry) = entry else {
                    if let Some(share) = self.bound() {
                        share.send_rpc_result(
                            viewer,
                            id,
                            None,
                            Some(format!("no such command: {cmd}")),
                        );
                    }
                    return Ok(InputOutcome::Applied);
                };
                if entry.steer_only && !access.may_steer() {
                    if let Some(share) = self.bound() {
                        share.send_rpc_result(
                            viewer,
                            id,
                            None,
                            Some("steer access required".into()),
                        );
                    }
                    return Ok(InputOutcome::Applied);
                }
                // One thread per call: handlers do blocking IO (files,
                // config), and the hub's frame loop must keep serving
                // every viewer while one runs — the proxy arm's stance.
                let share = self.bound();
                let spawned = std::thread::Builder::new()
                    .name("tabverse-app-rpc".into())
                    .spawn(move || {
                        let (ok, err) = match (entry.handler)(&args) {
                            Ok(value) => (Some(value), None),
                            Err(text) => (None, Some(text)),
                        };
                        if let Some(share) = share {
                            share.send_rpc_result(viewer, id, ok, err);
                        }
                    });
                if spawned.is_err() {
                    anyhow::bail!("an app rpc could not spawn its thread");
                }
                Ok(InputOutcome::Applied)
            }
            InputPayload::Action { name, args } => {
                let dispatch = self
                    .dispatch_action
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                dispatch(&name, &args);
                // Confirmation is the ActionApplied the webview broadcasts
                // once its reducer runs — not sent here, or a viewer would
                // hear its own action twice (once optimistically replayed,
                // once confirmed).
                Ok(InputOutcome::Applied)
            }
            InputPayload::ClipPush { text } => {
                (self.write_clipboard)(&text);
                Ok(InputOutcome::Applied)
            }
            InputPayload::ProxyReq { id, head, body } => {
                // One thread per request: a proxy fetch is seconds of
                // network, and the callers of this seam (the hub's frame
                // loop) must keep serving every viewer while it runs.
                // The id is the correlation the answer rides back on,
                // whichever frame lands first.
                let share = self.bound();
                let proxy = self.proxy.clone();
                let spawned = std::thread::Builder::new()
                    .name("tabverse-remote-proxy".into())
                    .spawn(move || match proxy(&head, body.as_deref()) {
                        Ok((resp_head, resp_body)) => {
                            if let Some(share) = share {
                                share.send_proxy_res(viewer, id, resp_head, resp_body);
                            }
                        }
                        Err(text) => {
                            if let Some(share) = share {
                                share.send_rpc_result(viewer, id, None, Some(text));
                            }
                        }
                    });
                // A thread that cannot be spawned is said out loud: the
                // hub logs it as a frame not applied, which is exactly
                // what happened.
                if spawned.is_err() {
                    anyhow::bail!("the remote proxy could not spawn its thread");
                }
                Ok(InputOutcome::Applied)
            }
            InputPayload::BrowserOpen {
                stream_id,
                tab_id,
                grant_id,
                attachment_id,
                attachment_generation,
                method,
                url,
                headers,
                body_len,
            } => {
                self.browser_router
                    .bind_attachment(viewer, attachment_id.clone(), attachment_generation)
                    .map_err(anyhow::Error::msg)?;
                self.browser_router
                    .open(
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
                    )
                    .map_err(anyhow::Error::msg)?;
                Ok(InputOutcome::Applied)
            }
            InputPayload::BrowserRequestChunk {
                stream_id,
                seq,
                b64,
            } => {
                if let Err(error) = self
                    .browser_router
                    .request_chunk(viewer, stream_id, seq, &b64)
                {
                    self.browser_router.cancel(viewer, stream_id);
                    return Err(anyhow::Error::msg(error));
                }
                Ok(InputOutcome::Applied)
            }
            InputPayload::BrowserRequestEnd { stream_id } => {
                let execution = match self.browser_router.request_end(viewer, stream_id) {
                    Ok(execution) => execution,
                    Err(error) => {
                        self.browser_router.cancel(viewer, stream_id);
                        return Err(anyhow::Error::msg(error));
                    }
                };
                let router = Arc::clone(&self.browser_router);
                let resident = self
                    .resident_browser
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                let share = self.bound();
                let sink: crate::remote_proxy::BrowserResponseSink = Arc::new(move |event| {
                    let Some(share) = &share else { return };
                    match event {
                        crate::remote_proxy::BrowserEvent::Head {
                            status,
                            headers,
                            final_url,
                        } => share.send_browser_response_head(
                            viewer, stream_id, status, headers, final_url,
                        ),
                        crate::remote_proxy::BrowserEvent::Chunk { seq, b64 } => {
                            share.send_browser_response_chunk(viewer, stream_id, seq, b64)
                        }
                        crate::remote_proxy::BrowserEvent::End => {
                            share.send_browser_response_end(viewer, stream_id)
                        }
                        crate::remote_proxy::BrowserEvent::Error { code, message } => {
                            share.send_browser_response_error(viewer, stream_id, code, message)
                        }
                    }
                });
                std::thread::Builder::new()
                    .name("tabverse-browser-request".into())
                    .spawn(move || match resident {
                        Some(exchange) => {
                            router.execute_resident_or_local(execution, sink, exchange)
                        }
                        None => router.execute(execution, sink),
                    })
                    .map_err(|_| anyhow::anyhow!("the Browser request could not spawn"))?;
                Ok(InputOutcome::Applied)
            }
            InputPayload::BrowserCredit { stream_id, bytes } => {
                self.browser_router
                    .credit(viewer, stream_id, bytes)
                    .map_err(anyhow::Error::msg)?;
                Ok(InputOutcome::Applied)
            }
            InputPayload::BrowserCancel {
                stream_id,
                reason: _,
            } => {
                self.browser_router.cancel(viewer, stream_id);
                Ok(InputOutcome::Applied)
            }
            InputPayload::Bytes(bytes) => {
                // A viewer's keystrokes for the app share's terminal
                // stream. Which terminal is active is a webview fact (it
                // owns focus and the term registry), so the bytes leave as
                // an `app-share-term-input` event and the webview bridge
                // writes them into the active terminal — the same
                // webview-owns-the-reducer split the action seam uses.
                // Without an app handle there is no share (the handover
                // happens in app_share_start) and no terminal to write
                // into: Applied-and-dropped, the action arm's stance.
                let emit = self
                    .term_input
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                emit(&bytes);
                Ok(InputOutcome::Applied)
            }
            InputPayload::RemoteAck {
                tab_id,
                epoch,
                frame_seq,
            } => {
                use tauri::Emitter;
                if let Some(app) = self.app.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                    let _ = app.emit(
                        "app-share-remote-ack",
                        serde_json::json!({
                            "viewer": viewer,
                            "tabId": tab_id,
                            "epoch": epoch,
                            "frameSeq": frame_seq,
                        }),
                    );
                }
                Ok(InputOutcome::Applied)
            }
            InputPayload::RemoteResnapshot { tab_id, epoch } => {
                use tauri::Emitter;
                if let Some(app) = self.app.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                    let _ = app.emit(
                        "app-share-remote-resnapshot",
                        serde_json::json!({
                            "viewer": viewer,
                            "tabId": tab_id,
                            "epoch": epoch,
                        }),
                    );
                }
                Ok(InputOutcome::Applied)
            }
            InputPayload::RemoteIntent {
                tab_id,
                attachment_id,
                attachment_generation,
                intent_id,
                name,
                args,
            } => {
                use tauri::Emitter;
                if let Some(app) = self.app.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                    let _ = app.emit(
                        "app-share-remote-intent",
                        serde_json::json!({
                            "viewer": viewer,
                            "access": access,
                            "tabId": tab_id,
                            "attachmentId": attachment_id,
                            "attachmentGeneration": attachment_generation,
                            "intentId": intent_id,
                            "name": name,
                            "args": args,
                        }),
                    );
                }
                Ok(InputOutcome::Applied)
            }
        }
    }

    fn apply_viewport(&self, joint: Option<tabverse_remote::source::Viewport>) {
        use tauri::Emitter;
        // The joint viewport (smallest grid every current viewer can show,
        // tmux semantics) flows to the webview bridge, which caps the
        // ACTIVE terminal with it — the same cap a tab share's TerminalView
        // applies to itself. None (no viewer constrains) travels too, so
        // the bridge can lift the cap and the host refits its own window.
        let app = self.app.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(app) = app else { return };
        let _ = app.emit(
            "app-share-term-viewport",
            serde_json::json!({
                "cols": joint.map(|v| v.cols),
                "rows": joint.map(|v| v.rows),
            }),
        );
    }

    fn bind(&self, binding: ShareBinding) {
        self.browser_router.bind_share(binding.share.id.clone());
        *self.binding.lock().unwrap_or_else(|e| e.into_inner()) = Some(binding);
    }

    fn unbind(&self) {
        *self.binding.lock().unwrap_or_else(|e| e.into_inner()) = None;
        // The watcher's frames have nowhere to go without a binding. This
        // is the one stop every path out of a share shares — the stop
        // commands and runtime death all unbind — so no path can leave a
        // polling thread behind.
        self.stop_clipboard_watch();
        self.browser_router.clear();
    }

    fn viewer_detached(&self, viewer: ViewerId) {
        self.browser_router.cancel_viewer(viewer);
    }

    fn update_browser_grant(&self, tab_id: &str, url: &str) -> anyhow::Result<()> {
        self.browser_router
            .authorize_tab(tab_id.to_string(), url.to_string())
            .map_err(anyhow::Error::msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A source with recording stubs for every glue seam.
    fn source(
        actions: Arc<Mutex<Vec<String>>>,
        clips: Arc<Mutex<Vec<String>>>,
        proxied: Arc<Mutex<Vec<String>>>,
    ) -> Arc<AppShareSource> {
        let a = actions.clone();
        let c = clips.clone();
        let p = proxied.clone();
        AppShareSource::new(
            Arc::new(move |name, _args| a.lock().unwrap().push(name.to_string())),
            Arc::new(|| serde_json::json!({"tabs": []})),
            Arc::new(move |text| c.lock().unwrap().push(text.to_string())),
            Arc::new(move |head, _body| {
                p.lock().unwrap().push(head.to_string());
                Ok((
                    "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n".into(),
                    Some("hi".into()),
                ))
            }),
        )
    }

    #[test]
    fn an_rpc_reaches_its_handler_and_missing_commands_answer_with_an_error() {
        let src = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        src.register_rpc(
            "fs_list",
            Arc::new(move |args| {
                s.lock().unwrap().push(args.clone());
                Ok(serde_json::json!([{"name": "a"}]))
            }),
        );

        // Applied without a binding: no share, nothing to answer — but the
        // handler still ran (the outcome the caller asked about).
        let out = src.inject_input(
            1,
            Access::Steer,
            InputPayload::Rpc {
                id: 7,
                cmd: "fs_list".into(),
                args: serde_json::json!({"path": "/tmp"}),
            },
        );
        assert!(matches!(out.unwrap(), InputOutcome::Applied));
        // The handler runs on its own thread now (the hub's frame loop
        // must not block on file IO) — wait for it to land rather than
        // asserting synchronously.
        for _ in 0..100 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(seen.lock().unwrap()[0], serde_json::json!({"path": "/tmp"}));

        // A command nobody registered is an error answer, not a panic and
        // not silence.
        let out = src.inject_input(
            1,
            Access::Steer,
            InputPayload::Rpc {
                id: 8,
                cmd: "nope".into(),
                args: serde_json::Value::Null,
            },
        );
        assert!(matches!(out.unwrap(), InputOutcome::Applied));
    }

    #[test]
    fn a_read_rpc_runs_at_view_level_and_a_steer_rpc_refuses_out_loud() {
        let src = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        let reads: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let writes: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));

        let r = reads.clone();
        src.register_rpc(
            "fs_read",
            Arc::new(move |_| {
                r.lock().unwrap().push(1);
                Ok(serde_json::json!({"name": "f"}))
            }),
        );
        let w = writes.clone();
        src.register_steer_rpc(
            "fs_write",
            Arc::new(move |_| {
                w.lock().unwrap().push(1);
                Ok(serde_json::Value::Null)
            }),
        );

        src.inject_input(
            1,
            Access::View,
            InputPayload::Rpc {
                id: 1,
                cmd: "fs_read".into(),
                args: serde_json::json!({"path": "/tmp/x"}),
            },
        )
        .unwrap();

        // The handler runs on its own thread; give it a moment to land
        // before asserting, the same discipline the proxy arm's tests use.
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(reads.lock().unwrap().len(), 1, "view may read");

        // View level: the write command refuses without running — and the
        // refusal is the call's own answer, not a silent drop.
        src.inject_input(
            1,
            Access::View,
            InputPayload::Rpc {
                id: 2,
                cmd: "fs_write".into(),
                args: serde_json::json!({"path": "/tmp/x", "content": ""}),
            },
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(writes.lock().unwrap().is_empty(), "view must not write");

        // Steer level: the write command runs.
        src.inject_input(
            1,
            Access::Steer,
            InputPayload::Rpc {
                id: 3,
                cmd: "fs_write".into(),
                args: serde_json::json!({"path": "/tmp/x", "content": ""}),
            },
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(writes.lock().unwrap().len(), 1, "steer may write");
    }

    #[test]
    fn actions_dispatch_and_clips_write_and_proxies_run() {
        let actions = Arc::new(Mutex::new(Vec::new()));
        let clips = Arc::new(Mutex::new(Vec::new()));
        let proxied = Arc::new(Mutex::new(Vec::new()));
        let src = source(actions.clone(), clips.clone(), proxied.clone());

        src.inject_input(
            1,
            Access::Steer,
            InputPayload::Action {
                name: "addTab".into(),
                args: serde_json::json!({"type": "terminal"}),
            },
        )
        .unwrap();
        assert_eq!(*actions.lock().unwrap(), vec!["addTab".to_string()]);

        src.inject_input(
            1,
            Access::Steer,
            InputPayload::ClipPush { text: "hi".into() },
        )
        .unwrap();
        assert_eq!(*clips.lock().unwrap(), vec!["hi".to_string()]);

        src.inject_input(
            1,
            Access::Steer,
            InputPayload::ProxyReq {
                id: 3,
                head: "GET http://intranet/ HTTP/1.1\r\n\r\n".into(),
                body: None,
            },
        )
        .unwrap();
        // The proxy runs on its own thread (one per request, so seconds
        // of network cannot park the hub's frame loop): wait for the
        // record rather than assert against a race.
        let waited = {
            use std::time::{Duration, Instant};
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let guard = proxied.lock().unwrap();
                if !guard.is_empty() || Instant::now() > deadline {
                    break guard[0].clone();
                }
                drop(guard);
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        assert!(
            waited.starts_with("GET "),
            "the frame's head reached the seam: {waited:?}"
        );
    }

    /// The seam `set_dispatch_channel` installs: a viewer's action must
    /// leave as an `app-share-action` event carrying the exact name and
    /// args the viewer sent. Driven on the mock runtime — the real event
    /// system, no GUI — because the only thing this asserts is the glue,
    /// and glue is what a unit test is for.
    #[test]
    fn set_dispatch_channel_routes_viewer_actions_to_the_event_seam() {
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let seen: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        handle.listen("app-share-action", move |e| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                sink.lock().unwrap_or_else(|e| e.into_inner()).push((
                    v.get("name").and_then(|n| n.as_str()).unwrap_or("").into(),
                    v.get("args").cloned().unwrap_or(serde_json::Value::Null),
                ));
            }
        });

        let src = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        // Before the handover the construction no-op stands: the action
        // runs (Applied) but nothing reaches the webview.
        src.inject_input(
            1,
            Access::Steer,
            InputPayload::Action {
                name: "addTab".into(),
                args: serde_json::json!({"type": "terminal"}),
            },
        )
        .unwrap();
        assert!(seen.lock().unwrap_or_else(|e| e.into_inner()).is_empty());

        src.set_dispatch_channel(handle);
        src.inject_input(
            1,
            Access::Steer,
            InputPayload::Action {
                name: "addTab".into(),
                args: serde_json::json!({"type": "terminal"}),
            },
        )
        .unwrap();
        assert_eq!(
            *seen.lock().unwrap_or_else(|e| e.into_inner()),
            vec![(
                "addTab".to_string(),
                serde_json::json!({"type": "terminal"})
            )]
        );
    }

    #[test]
    fn viewer_bytes_leave_as_an_app_share_term_input_event() {
        use base64::Engine as _;
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        handle.listen("app-share-term-input", move |e| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                if let Some(data) = v.get("data").and_then(|d| d.as_str()) {
                    sink.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(data.to_string());
                }
            }
        });

        let src = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        // Before the handover the construction-time stance is
        // Applied-and-dropped: no share exists, nothing reaches the webview.
        src.inject_input(1, Access::Steer, InputPayload::Bytes(b"no handle".to_vec()))
            .unwrap();
        assert!(seen.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
        src.set_term_input_channel(handle);
        src.inject_input(1, Access::Steer, InputPayload::Bytes(b"ls\r".to_vec()))
            .unwrap();
        assert_eq!(
            *seen.lock().unwrap_or_else(|e| e.into_inner()),
            vec![base64::engine::general_purpose::STANDARD.encode(b"ls\r")],
            "the bytes must cross the seam base64-encoded, unchanged"
        );
    }

    #[test]
    fn single_tab_source_routes_snapshot_and_declared_intent_over_the_shared_seam() {
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let snapshots: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let intents: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let snapshot_sink = snapshots.clone();
        handle.listen("tab-share-contribution-snapshot-request", move |event| {
            snapshot_sink
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
        let intent_sink = intents.clone();
        handle.listen("app-share-remote-intent", move |event| {
            intent_sink
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });

        let source = ContributionShareSource::new("files-1".into(), handle, None);
        assert_eq!(source.kind(), SharedTabType::Contribution);
        assert!(source.grid().is_none());
        source.request_snapshot(9);
        source
            .inject_input(
                9,
                Access::Steer,
                InputPayload::RemoteIntent {
                    tab_id: "files-1".into(),
                    attachment_id: "attachment-9".into(),
                    attachment_generation: 1,
                    intent_id: "intent-1".into(),
                    name: "files.open".into(),
                    args: serde_json::json!({"path": "/tmp/a"}),
                },
            )
            .unwrap();

        assert_eq!(snapshots.lock().unwrap()[0]["tabId"], "files-1");
        assert_eq!(snapshots.lock().unwrap()[0]["viewer"], 9);
        assert_eq!(intents.lock().unwrap()[0]["name"], "files.open");
        assert!(source
            .inject_input(
                9,
                Access::Steer,
                InputPayload::Action {
                    name: "arbitrary.store.patch".into(),
                    args: serde_json::Value::Null,
                },
            )
            .is_err());
    }

    #[test]
    fn the_kind_is_app_and_the_grid_is_none() {
        let src = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        assert_eq!(src.kind(), SharedTabType::App);
        assert!(src.grid().is_none());
    }

    #[test]
    fn sanitized_app_snapshot_is_the_only_browser_network_grant_source() {
        let src = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        src.browser_router.bind_share("share-snapshot".into());
        src.sync_browser_grants(&serde_json::json!({
            "tabs": [
                {"id": "browser-1", "kind": "browser", "url": "http://127.0.0.1:18080/a"},
                {"id": "settings-1", "kind": "settings", "url": "http://127.0.0.1:18081/"}
            ]
        }));
        let attachment = "attachment-1";
        src.browser_router
            .bind_attachment(1, attachment.into(), 1)
            .unwrap();
        src.browser_router
            .open(
                1,
                1,
                "browser-1".into(),
                crate::remote_proxy::BrowserRequestRouter::expected_grant_id(
                    attachment,
                    1,
                    "browser-1",
                ),
                attachment.into(),
                1,
                Access::View,
                "GET".into(),
                "http://127.0.0.1:18080/a".into(),
                vec![],
                None,
            )
            .unwrap();
        let denied = src
            .browser_router
            .open(
                1,
                2,
                "settings-1".into(),
                crate::remote_proxy::BrowserRequestRouter::expected_grant_id(
                    attachment,
                    1,
                    "settings-1",
                ),
                attachment.into(),
                1,
                Access::View,
                "GET".into(),
                "http://127.0.0.1:18081/".into(),
                vec![],
                None,
            )
            .unwrap_err();
        assert!(denied.starts_with("grant-denied:"));

        src.sync_browser_grants(&serde_json::json!({"tabs": []}));
        assert!(src.browser_router.request_end(1, 1).is_err());
    }

    #[test]
    fn single_tab_browser_contribution_rotates_its_base_network_grant() {
        let app = tauri::test::mock_app();
        let base = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        base.browser_router.bind_share("share-single".into());
        base.authorize_browser_tab("browser-1".into(), "http://127.0.0.1:18080/old".into())
            .unwrap();
        let contribution = ContributionShareSource::new(
            "browser-1".into(),
            app.handle().clone(),
            Some(base.clone()),
        );
        contribution
            .update_browser_grant("browser-1", "http://127.0.0.1:18081/new")
            .unwrap();
        let attachment = "attachment-1";
        base.browser_router
            .bind_attachment(1, attachment.into(), 1)
            .unwrap();
        let old = base
            .browser_router
            .open(
                1,
                1,
                "browser-1".into(),
                crate::remote_proxy::BrowserRequestRouter::expected_grant_id(
                    attachment,
                    1,
                    "browser-1",
                ),
                attachment.into(),
                1,
                Access::View,
                "GET".into(),
                "http://127.0.0.1:18080/old".into(),
                vec![],
                None,
            )
            .unwrap_err();
        assert!(old.starts_with("origin-denied:"));
        base.browser_router
            .open(
                1,
                2,
                "browser-1".into(),
                crate::remote_proxy::BrowserRequestRouter::expected_grant_id(
                    attachment,
                    1,
                    "browser-1",
                ),
                attachment.into(),
                1,
                Access::View,
                "GET".into(),
                "http://127.0.0.1:18081/new".into(),
                vec![],
                None,
            )
            .unwrap();
    }

    #[test]
    fn the_clipboard_watch_lives_and_dies_with_the_binding() {
        let src = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        assert!(!src.clip_watch_installed());
        src.start_clipboard_watch();
        // A second start while one runs is the one-share rule's no-op.
        src.start_clipboard_watch();
        assert!(src.clip_watch_installed());
        src.unbind();
        assert!(
            !src.clip_watch_installed(),
            "unbind must stop the watcher, not orphan it"
        );
        // Idempotent stop, and a fresh share starts a fresh watch.
        src.stop_clipboard_watch();
        src.start_clipboard_watch();
        src.stop_clipboard_watch();
        assert!(!src.clip_watch_installed());
    }
}
