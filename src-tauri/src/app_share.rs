//! The app-level share source: the whole interface, mirrored as state.
//!
//! WHAT THIS IS. A `ShareSource` whose kind is `App` (protocol v3): it
//! answers RPCs by dispatching into the app's own command surface, forwards
//! the store's serialized state as `AppSnapshot`, replays every action the
//! host executes as `ActionApplied` for the viewers' mirrored stores, and
//! carries the clipboard and remote-proxy frames to their owners elsewhere
//! in the app. The hub keeps policy (kind floor, access checks, version
//! withholding); this adapter is mechanism only, the same split the
//! terminal and agent sources live by.
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

/// One viewer verb for the agent session behind the ACTIVE tab.
pub enum AgentCmd {
    Prompt(String),
    Cancel,
}

/// Glue-injected: point the named tab's agent session at a share (Some) or
/// away from one (None); on bind, the session's history is the return —
/// the catch-up a viewer fronts an agent tab with. None when the tab runs
/// no agent session (the common case: bind is a query, not an assertion).
pub type AgentBindFn =
    Arc<dyn Fn(&str, Option<Arc<Share>>) -> Option<Vec<serde_json::Value>> + Send + Sync>;
/// Glue-injected: run one viewer verb against the named tab's session.
pub type AgentInputFn = Arc<dyn Fn(&str, AgentCmd) -> Result<(), String> + Send + Sync>;

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
    binding: Mutex<Option<ShareBinding>>,
    /// Hands the webview-ask path an AppHandle without the source holding
    /// one from construction (the app handle does not exist yet when
    /// AppState is built). Set by `app_share_start`.
    app: Mutex<Option<tauri::AppHandle>>,
    /// Monotonic id for the events this source fans out, so viewers can
    /// order what they receive even across a reconnect's snapshot reset.
    seq: AtomicU64,
    /// The tab the host has front and center, named by the webview (which
    /// owns focus). App-share terminal content follows THIS tab: PTY output
    /// is tapped for its session and viewer keystrokes are written into
    /// its terminal. None = a non-terminal tab fronts, no terminal stream.
    active_tab: Mutex<Option<String>>,
    agent_bind: Mutex<AgentBindFn>,
    agent_input: Mutex<AgentInputFn>,
    /// The tab whose agent session is currently bound — the bind's own
    /// bookkeeping, so switching away releases it and rebinding the same
    /// tab does not duplicate its history.
    agent_bound_tab: Mutex<Option<String>>,
    clip_watch: Mutex<Option<crate::clipboard_watch::ClipboardWatch>>,
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
            agent_bind: Mutex::new(Arc::new(|_tab, _target| None)),
            agent_input: Mutex::new(Arc::new(|_tab, _cmd| {
                Err("the agent seam is not installed".into())
            })),
            agent_bound_tab: Mutex::new(None),
            snapshot,
            write_clipboard,
            proxy,
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

    pub fn set_agent_seams(&self, bind: AgentBindFn, input: AgentInputFn) {
        *self.agent_bind.lock().unwrap_or_else(|e| e.into_inner()) = bind;
        *self.agent_input.lock().unwrap_or_else(|e| e.into_inner()) = input;
        // The seams arriving late must not miss a tab that already fronts:
        // re-derive the binding from the active-tab fact as of now.
        self.rebind_agent();
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
    pub fn request_snapshot_from_webview(&self, app: &tauri::AppHandle) {
        use tauri::Emitter;
        let _ = app.emit("app-share-snapshot-request", ());
    }

    /// The handle the webview-ask path emits through. Handed over by
    /// `app_share_start`, the one place that has one and knows the share
    /// is live.
    pub fn set_app_handle(&self, app: tauri::AppHandle) {
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
    pub fn set_dispatch_channel<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>) {
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
    pub fn set_term_input_channel<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>) {
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
    /// An agent tab also BINDS here: the session's events are pointed at
    /// the share and its history goes out as the catch-up, the same
    /// fronting semantics the terminal stream has (a viewer fronts an
    /// agent tab with its transcript, not a placeholder).
    pub fn set_active_tab(&self, tab_id: Option<String>) {
        *self.active_tab.lock().unwrap_or_else(|e| e.into_inner()) = tab_id;
        self.rebind_agent();
    }

    /// Point the agent seam at whatever the active tab now fronts. Idempotent
    /// per tab; a no-op until the seams exist (pre-start, tests).
    fn rebind_agent(&self) {
        let bind = self
            .agent_bind
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let active = self.active_tab();
        let mut bound = self
            .agent_bound_tab
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if bound.as_deref() == active.as_deref() {
            return; // same tab (or both none): nothing moved
        }
        if let Some(prev) = bound.take() {
            let _ = bind(&prev, None);
        }
        let Some(tab) = active else { return };
        let Some(share) = self.bound() else { return };
        let share2 = Arc::clone(&share);
        if let Some(history) = bind(&tab, Some(share)) {
            *bound = Some(tab);
            for event in history {
                share2.broadcast_agent_event(event);
            }
        }
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

    /// Gridless at welcome, like the agent source: the app share fronts
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
        _viewer: ViewerId,
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
                        share.broadcast_rpc_result(
                            id,
                            None,
                            Some(format!("no such command: {cmd}")),
                        );
                    }
                    return Ok(InputOutcome::Applied);
                };
                if entry.steer_only && !access.may_steer() {
                    if let Some(share) = self.bound() {
                        share.broadcast_rpc_result(id, None, Some("steer access required".into()));
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
                            share.broadcast_rpc_result(id, ok, err);
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
                                share.broadcast_proxy_res(id, resp_head, resp_body);
                            }
                        }
                        Err(text) => {
                            if let Some(share) = share {
                                share.broadcast_rpc_result(id, None, Some(text));
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
            InputPayload::AgentPrompt { text } => {
                let Some(tab) = self.active_tab() else {
                    anyhow::bail!("no tab fronts the app share");
                };
                let input = self
                    .agent_input
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                if let Err(e) = input(&tab, AgentCmd::Prompt(text)) {
                    anyhow::bail!("agent input for tab {tab}: {e}");
                }
                Ok(InputOutcome::Applied)
            }
            InputPayload::AgentCancel => {
                let Some(tab) = self.active_tab() else {
                    anyhow::bail!("no tab fronts the app share");
                };
                let input = self
                    .agent_input
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                if let Err(e) = input(&tab, AgentCmd::Cancel) {
                    anyhow::bail!("agent input for tab {tab}: {e}");
                }
                Ok(InputOutcome::Applied)
            }
            InputPayload::AgentAnswer { .. } => {
                anyhow::bail!("an app source cannot take agent approvals")
            } // (Prompt/Cancel routed above; Answer refused above.)
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
        *self.binding.lock().unwrap_or_else(|e| e.into_inner()) = Some(binding);
    }

    fn unbind(&self) {
        *self.binding.lock().unwrap_or_else(|e| e.into_inner()) = None;
        // The watcher's frames have nowhere to go without a binding. This
        // is the one stop every path out of a share shares — the stop
        // commands and runtime death all unbind — so no path can leave a
        // polling thread behind.
        self.stop_clipboard_watch();
        // The bound agent session's fan-out has nowhere to go either: a
        // share that ends must not keep streaming a session to nobody.
        if let Some(prev) = self
            .agent_bound_tab
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let bind = self
                .agent_bind
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let _ = bind(&prev, None);
        }
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
    fn agent_verbs_route_by_active_tab_and_binding_follows_the_front() {
        let src = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        // Recording seams: binds by (tab, bound?), verbs by (tab, cmd).
        let binds: Arc<Mutex<Vec<(String, bool)>>> = Arc::new(Mutex::new(Vec::new()));
        let verbs: Arc<Mutex<Vec<(String, &'static str)>>> = Arc::new(Mutex::new(Vec::new()));
        let b = binds.clone();
        let v = verbs.clone();
        src.set_agent_seams(
            Arc::new(move |tab, target| {
                let bound = target.is_some();
                if bound {
                    b.lock().unwrap().push((tab.to_string(), true));
                    Some(vec![serde_json::json!({"type": "turn_started"})])
                } else {
                    b.lock().unwrap().push((tab.to_string(), false));
                    None
                }
            }),
            Arc::new(move |tab, cmd| {
                let which = match cmd {
                    AgentCmd::Prompt(_) => "prompt",
                    AgentCmd::Cancel => "cancel",
                };
                v.lock().unwrap().push((tab.to_string(), which));
                Ok(())
            }),
        );

        // Without a live share there is nothing to bind a session's
        // fan-out TO, so a fronting change binds nothing — the gate is
        // the share. The verbs below still pin the tab-keyed routing.
        src.set_active_tab(Some("ag1".into()));
        assert!(
            binds.lock().unwrap().is_empty(),
            "no bind without a live share"
        );

        // Viewer verbs route by the ACTIVE tab (the hub only delivers
        // them on a live share; this pins the routing itself).
        src.inject_input(
            1,
            Access::Steer,
            InputPayload::AgentPrompt { text: "hi".into() },
        )
        .unwrap();
        src.inject_input(1, Access::Steer, InputPayload::AgentCancel)
            .unwrap();
        assert_eq!(
            verbs.lock().unwrap().as_slice(),
            &[("ag1".into(), "prompt"), ("ag1".into(), "cancel")]
        );

        // No tab fronts: the verb refuses out loud rather than guessing.
        src.set_active_tab(None);
        assert!(src
            .inject_input(
                1,
                Access::Steer,
                InputPayload::AgentPrompt { text: "x".into() }
            )
            .is_err());

        src.set_active_tab(Some("ag1".into()));
        assert!(src
            .inject_input(
                1,
                Access::Steer,
                InputPayload::AgentAnswer {
                    call_id: "c1".into(),
                    allow: true,
                    reason: None,
                }
            )
            .is_err());
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
    fn agent_frames_are_refused_out_loud() {
        let src = source(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        for payload in [
            InputPayload::AgentPrompt {
                text: String::new(),
            },
            InputPayload::AgentCancel,
        ] {
            let out = src.inject_input(1, Access::Approve, payload);
            assert!(out.is_err(), "the app source must refuse, not ignore");
        }
    }

    /// The terminal-input seam (the app share's active-terminal channel):
    /// a viewer's raw bytes must leave as an `app-share-term-input` event
    /// carrying exactly what arrived, for the webview bridge to write into
    /// the active terminal. Mock runtime, real event system — the same
    /// stance as the action-seam test above: glue is what this asserts.
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
