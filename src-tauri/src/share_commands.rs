//! The share command surface: thin glue between the webview and the hub.
//!
//! Commands speak tab ids — the one name the UI owns — and resolve a tab's
//! runtime through the `SourceRegistry`; what kind of runtime answers is the
//! adapter's business, never this file's. The maps in `ShareGlue` are the
//! glue's own bookkeeping: which PTY session belongs to which tab, and which
//! live share fronts which session.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tabverse_remote::source::terminal::TerminalSource;
use tabverse_remote::{RemoteHub, ShareOpts, SourceRegistry, ViewerInfo};
use tauri::{AppHandle, Emitter, State};

use crate::agent_bridge;
use crate::app_share::AgentCmd;
use crate::AppState;

/// The glue layer's share bookkeeping. Entries live exactly as long as what
/// they name: a session row dies with its runtime (`term_kill` or shell
/// self-exit, both through `tab_runtime_died`), a share row dies when the
/// share stops — on every path that stops it, not just the stop command.
#[derive(Default)]
pub struct ShareGlue {
    /// session_id -> tab_id: PTY-side paths know the session and need the tab.
    pub session_tabs: Mutex<HashMap<String, String>>,
    pub share_sessions: Mutex<HashMap<String, String>>,
    /// session_id -> the tab's concrete terminal adapter, so `term_resize`
    /// can keep its grid truthful. The registry holds the same source behind
    /// the trait; this map exists because a host-side resize is a terminal
    /// fact with no place in `ShareSource`.
    pub terminal_sources: Mutex<HashMap<String, Arc<TerminalSource>>>,
    /// Tabs with a share_start future in flight. Held across the hub await so
    /// two clients cannot both pass the empty-share check.
    starting_tabs: Mutex<HashSet<String>>,
}

struct StartReservation<'a> {
    tab_id: String,
    starting: &'a Mutex<HashSet<String>>,
}

impl Drop for StartReservation<'_> {
    fn drop(&mut self) {
        self.starting.lock().unwrap().remove(&self.tab_id);
    }
}

fn reserve_start<'a>(glue: &'a ShareGlue, tab_id: &str) -> Result<StartReservation<'a>, String> {
    if !glue
        .starting_tabs
        .lock()
        .unwrap()
        .insert(tab_id.to_string())
    {
        return Err("tab sharing is already starting".into());
    }
    Ok(StartReservation {
        tab_id: tab_id.to_string(),
        starting: &glue.starting_tabs,
    })
}

/// The helper session behind a tab, if one is live. `pub(crate)`: the
/// app-share output tap (lib.rs's helper frame path) resolves the
/// webview-named active tab to the session whose bytes it forwards.
pub(crate) fn session_for_tab(glue: &ShareGlue, tab_id: &str) -> Option<String> {
    glue.session_tabs
        .lock()
        .unwrap()
        .iter()
        .find_map(|(session, tab)| (tab == tab_id).then(|| session.clone()))
}

/// The live share fronting `session_id`, if any — the reverse read of the
/// same map `stop_shares_of_session` sweeps.
fn share_for_session(glue: &ShareGlue, session_id: &str) -> Option<String> {
    glue.share_sessions
        .lock()
        .unwrap()
        .iter()
        .find_map(|(share, session)| (session == session_id).then(|| share.clone()))
}

/// Stop — and forget — every share fronting `session_id`. There is at most
/// one, because `share_start` refuses a second, but a map is swept rather
/// than trusted.
fn stop_shares_of_session(hub: &RemoteHub, glue: &ShareGlue, session_id: &str) {
    let stale: Vec<String> = glue
        .share_sessions
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, session)| *session == session_id)
        .map(|(share, _)| share.clone())
        .collect();
    for share_id in stale {
        glue.share_sessions.lock().unwrap().remove(&share_id);
        hub.share_stop(&share_id);
    }
}

/// A tab's runtime is gone — `term_kill`, or the shell exiting on its own.
/// Everything that named it goes with it: the registry entry, the session
/// maps, and any share it was bound to (whose viewers get `End`). Idempotent,
/// because on the self-exit path `dispatch_exit` has already detached and
/// stopped the share by the time this runs.
pub fn tab_runtime_died(hub: &RemoteHub, sources: &SourceRegistry, glue: &ShareGlue, tab_id: &str) {
    // Unbind before stopping: from here on, nothing the dying runtime emits
    // can fan out to viewers.
    if let Some(source) = sources.unregister(tab_id) {
        source.unbind();
    }
    let session = {
        let mut tabs = glue.session_tabs.lock().unwrap();
        let session = tabs
            .iter()
            .find_map(|(session, tab)| (tab == tab_id).then(|| session.clone()));
        if let Some(session) = &session {
            tabs.remove(session);
        }
        session
    };
    if let Some(session) = session {
        glue.terminal_sources.lock().unwrap().remove(&session);
        stop_shares_of_session(hub, glue, &session);
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareStarted {
    pub share_id: String,
    pub ticket: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PresenceViewer {
    id: u64,
    /// The name the viewer's Hello carried ("tabverse@host", "Safari (web)").
    name: String,
    /// Serialises as "view" | "steer" | "approve".
    access: tabverse_proto::Access,
}

/// The full roster, addressed by tab id — the one name the UI owns. The
/// viewer count is the list's length; nothing else is derived host-side.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PresenceEvent {
    tab_id: String,
    viewers: Vec<PresenceViewer>,
}

/// The access a share hands new viewers, from the command's string form.
/// An unknown name is an error, never a fallback: a typo must not decide
/// what a stranger may do to your terminal.
fn parse_access(name: &str) -> Result<tabverse_proto::Access, String> {
    use tabverse_proto::Access;
    match name {
        "view" => Ok(Access::View),
        "steer" => Ok(Access::Steer),
        "approve" => Ok(Access::Approve),
        other => Err(format!("unknown access level {other:?}")),
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ViewportEvent {
    pub session_id: String,
    /// Smallest grid any viewer can show; absent when no viewer constrains us.
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[tauri::command]
pub async fn share_start(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    title: String,
    ttl_secs: Option<u64>,
    // "view" | "steer" | "approve" — the default level for new viewers,
    // chosen in the dialog from the capability's declared levels.
    access: String,
) -> Result<ShareStarted, String> {
    let access = parse_access(&access)?;
    let _reservation = reserve_start(&state.share_glue, &tab_id)?;
    // The registry is the gate: a tab with no entry has no shareable runtime
    // — it does not exist, it is not a kind that shares, or its runtime died.
    let source = state
        .sources
        .get(&tab_id)
        .ok_or_else(|| format!("tab {tab_id} has no shareable runtime"))?;
    let session_id = session_for_tab(&state.share_glue, &tab_id)
        .ok_or_else(|| format!("tab {tab_id} has no shareable runtime"))?;
    if state
        .share_glue
        .share_sessions
        .lock()
        .unwrap()
        .values()
        .any(|session| *session == session_id)
    {
        return Err("tab is already shared".into());
    }

    let presence_tab = tab_id.clone();
    let (share, ticket) = state
        .hub
        .share_start(ShareOpts {
            title,
            source: source.clone(),
            on_presence: Arc::new(move |roster: &[ViewerInfo]| {
                let viewers: Vec<PresenceViewer> = roster
                    .iter()
                    .map(|v| PresenceViewer {
                        id: v.id,
                        name: v.name.clone(),
                        access: v.access,
                    })
                    .collect();
                eprintln!(
                    "[core] presence tab={presence_tab} viewers={}",
                    viewers.len()
                );
                let _ = app.emit(
                    "share-presence",
                    PresenceEvent {
                        tab_id: presence_tab.clone(),
                        viewers,
                    },
                );
            }),
            // Join-window semantics: after the ttl the ticket stops admitting
            // NEW viewers; already-connected viewers are unaffected. None
            // means the ticket never expires.
            ttl: ttl_secs.map(std::time::Duration::from_secs),
            access,
        })
        .await
        .map_err(|e| format!("{e:#}"))?;

    let still_current = state
        .sources
        .get(&tab_id)
        .is_some_and(|current| Arc::ptr_eq(&current, &source))
        && session_for_tab(&state.share_glue, &tab_id).as_deref() == Some(&session_id);
    if !still_current {
        source.unbind();
        state.hub.share_stop(&share.id);
        return Err("tab runtime changed while sharing was starting".into());
    }
    state
        .share_glue
        .share_sessions
        .lock()
        .unwrap()
        .insert(share.id.clone(), session_id);
    eprintln!("[core] share_start tab={tab_id} share={}", share.id);
    Ok(ShareStarted {
        share_id: share.id.clone(),
        ticket,
    })
}

#[tauri::command]
pub fn share_stop(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    // Unbind through the trait: the command must not care what kind of
    // runtime it is stopping. A tab that is not sharing (or is already gone)
    // makes both halves no-ops, matching the old command's silence.
    if let Some(source) = state.sources.get(&tab_id) {
        source.unbind();
    }
    if let Some(session_id) = session_for_tab(&state.share_glue, &tab_id) {
        stop_shares_of_session(&state.hub, &state.share_glue, &session_id);
    }
    Ok(())
}

/// The tab id the whole-app share registers under. One app share per
/// process: the id is fixed, so a second start refuses and stop finds it.
const APP_SHARE_TAB_ID: &str = "app";

/// Share the entire app (v3). The source is the process-wide AppShareSource;
/// its glue seams were wired at AppState construction. The registry entry
/// rides the same map tab sources do, so every generic stop/kick/presence
/// path works on an app share unmodified.
#[tauri::command]
pub async fn app_share_start(
    app: AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, Arc<agent_bridge::AgentRegistry>>,
    ttl_secs: Option<u64>,
    access: String,
) -> Result<ShareStarted, String> {
    let access = parse_access(&access)?;
    if state.sources.get(APP_SHARE_TAB_ID).is_some() {
        return Err("the app is already shared".into());
    }
    let source = state.app_source.clone();
    state.sources.register(APP_SHARE_TAB_ID, source.clone());
    // The webview-ask snapshot path needs the handle; the source is
    // process-wide, so this is the one moment it can be handed over.
    source.set_app_handle(app.clone());
    // The action path's emitter, same handover: a viewer's action must
    // reach the webview's store, and only here does the handle exist.
    source.set_dispatch_channel(app.clone());
    // The terminal-input path's emitter, same handover once more: a
    // viewer's keystrokes must reach the active terminal, and the webview
    // bridge (which owns the term registry) is where they land.
    source.set_term_input_channel(app.clone());
    register_app_rpc_read_commands(&state);
    register_app_rpc_steer_commands(&state);
    {
        let registry = registry.inner().clone();
        let bind_registry = registry.clone();
        state.app_source.set_agent_seams(
            Arc::new(move |tab, target| {
                let handle = bind_registry.handle_for_session(tab)?;
                let hooks = bind_registry.agent_hooks(&handle)?;
                (hooks.set_broadcast)(target.clone());
                target.map(|_| (hooks.history)())
            }),
            Arc::new(move |tab, cmd| {
                let handle = registry
                    .handle_for_session(tab)
                    .ok_or_else(|| format!("no agent session for tab {tab}"))?;
                match cmd {
                    AgentCmd::Prompt(text) => registry.prompt(&handle, text),
                    AgentCmd::Cancel => registry.cancel(&handle),
                }
                .map_err(|e| format!("{e:#}"))
            }),
        );
    }

    let presence_app = app.clone();
    let (share, ticket) = state
        .hub
        .share_start(ShareOpts {
            title: "Tabverse".into(),
            source: source.clone(),
            on_presence: Arc::new(move |roster: &[ViewerInfo]| {
                let _ = presence_app.emit(
                    "share-presence",
                    PresenceEvent {
                        tab_id: APP_SHARE_TAB_ID.into(),
                        viewers: roster
                            .iter()
                            .map(|v| PresenceViewer {
                                id: v.id,
                                name: v.name.clone(),
                                access: v.access,
                            })
                            .collect(),
                    },
                );
            }),
            ttl: ttl_secs.map(std::time::Duration::from_secs),
            access,
        })
        .await
        .map_err(|e| format!("{e:#}"))?;

    // The app share has no per-tab session id; its bookkeeping entry maps
    // the share to the fixed id, which is all stop needs.
    state
        .share_glue
        .share_sessions
        .lock()
        .unwrap()
        .insert(share.id.clone(), APP_SHARE_TAB_ID.to_string());

    source.start_clipboard_watch();

    eprintln!("[core] app_share_start share={}", share.id);
    Ok(ShareStarted {
        share_id: share.id.clone(),
        ticket,
    })
}

fn register_app_rpc_read_commands(state: &State<'_, AppState>) {
    let fs = state.fs.clone();
    state.app_source.register_rpc(
        "fs_list",
        Arc::new(move |args| {
            let dir = args
                .get("dir")
                .and_then(|v| v.as_str())
                .ok_or("fs_list needs a string 'dir'")?;
            let listing = fs.list_dir(dir).map_err(|e| format!("{e:#}"))?;
            serde_json::to_value(listing).map_err(|e| e.to_string())
        }),
    );
    let fs = state.fs.clone();
    state.app_source.register_rpc(
        "fs_read",
        Arc::new(move |args| {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("fs_read needs a string 'path'")?;
            let meta = fs.read_file(path).map_err(|e| format!("{e:#}"))?;
            serde_json::to_value(meta).map_err(|e| e.to_string())
        }),
    );
    state.app_source.register_rpc(
        "config_get",
        Arc::new(|_args| {
            let loaded = crate::config::load().map_err(|e| e.to_string())?;
            let snapshot = crate::config::ConfigSnapshot {
                values: loaded.config,
                warnings: loaded.warnings,
                sources: loaded.sources,
            };
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }),
    );
    state.app_source.register_rpc(
        "config_schema",
        Arc::new(|_args| {
            serde_json::to_value(crate::config::config_schema()).map_err(|e| e.to_string())
        }),
    );
}

fn register_app_rpc_steer_commands(state: &State<'_, AppState>) {
    let fs = state.fs.clone();
    state.app_source.register_steer_rpc(
        "fs_write",
        Arc::new(move |args| {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("fs_write needs a string 'path'")?;
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("fs_write needs a string 'content'")?;
            fs.write_text(path, content).map_err(|e| format!("{e:#}"))?;
            Ok(serde_json::Value::Null)
        }),
    );
    state.app_source.register_steer_rpc(
        "config_set",
        Arc::new(|args| {
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or("config_set needs a string 'key'")?;
            let value = args.get("value").ok_or("config_set needs a 'value'")?;
            let path = crate::config::write_target(
                crate::config::current_platform(),
                &crate::config::EnvVars::from_process(),
            )?;
            crate::config::set_in_file(&path, key, value)?;
            Ok(serde_json::Value::Null)
        }),
    );
}

/// The webview's answer to `app-share-snapshot-request`: the full store
/// state, serialized the session-snapshot way. Broadcast to every viewer —
/// the joining one asked, and any drift a disconnect window left in the
/// others is overwritten in the same stroke.
#[tauri::command]
pub fn app_share_snapshot_deliver(
    state: State<'_, AppState>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    if let Some(share) = state.app_source.bound_share() {
        share.broadcast_app_snapshot(snapshot);
    }
    Ok(())
}

/// The active-terminal channel's report from the webview (see
/// `appTermBridge`): which tab fronts the host right now, or None when a
/// non-terminal tab does. Rust stores the fact the helper output tap keys
/// on — nothing more; the bridge decides (terminal type, registry lookup)
/// what counts as a watchable active terminal before it calls this.
#[tauri::command]
pub fn app_share_set_active_tab(
    state: State<'_, AppState>,
    tab_id: Option<String>,
) -> Result<(), String> {
    state.app_source.set_active_tab(tab_id);
    Ok(())
}

/// The webview's serialized screen of the active terminal, on every
/// active-tab change (the bridge sends it alongside the report above) and
/// on a viewer's catch-up: a reset-and-rewrite Snapshot frame that makes a
/// viewer whole regardless of what stream it followed before.
#[tauri::command]
pub fn app_share_term_snapshot(
    state: State<'_, AppState>,
    b64_data: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .app_source
        .broadcast_term_snapshot(&b64_data, cols, rows);
    Ok(())
}

#[tauri::command]
pub fn app_share_stop(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(source) = state.sources.unregister(APP_SHARE_TAB_ID) {
        source.unbind();
    }
    // The watcher stops with the unbind above (every path out shares
    // it); said out loud here because this command is where the share's
    // lifecycle reads.
    state.app_source.stop_clipboard_watch();
    if let Some(session_id) = session_for_tab(&state.share_glue, APP_SHARE_TAB_ID) {
        stop_shares_of_session(&state.hub, &state.share_glue, &session_id);
    }
    Ok(())
}
#[tauri::command]
pub fn app_share_broadcast_action(
    state: State<'_, AppState>,
    name: String,
    args: serde_json::Value,
) {
    eprintln!("[core] app_share_broadcast_action {name}");
    state.app_source.broadcast_action(&name, &args);
}
#[tauri::command]
pub fn share_snapshot(
    state: State<'_, AppState>,
    share_id: String,
    viewer: u64,
    b64_data: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let share = state
        .hub
        .share(&share_id)
        .ok_or_else(|| format!("unknown share {share_id}"))?;
    share.snapshot_ready(viewer, b64_data, cols, rows);
    Ok(())
}

/// Disconnect one viewer from a share; everyone else stays connected. Returns
/// whether that viewer was actually present (false means it already left).
#[tauri::command]
pub fn share_kick(
    state: State<'_, AppState>,
    share_id: String,
    viewer: u64,
) -> Result<bool, String> {
    Ok(state.hub.share_kick(&share_id, viewer))
}

/// Change one connected viewer's access level, live. Addressed by tab id —
/// the one name the UI owns — and resolved to the share through the glue's
/// maps, the same route share_stop takes. The hub updates the per-viewer
/// state its frame-read loop consults and resends Mode to that viewer; every
/// host UI then learns the new level through the presence event the hub
/// fires, so no caller updates a roster by hand.
#[tauri::command]
pub fn share_set_viewer_access(
    state: State<'_, AppState>,
    tab_id: String,
    viewer_id: u64,
    access: String,
) -> Result<(), String> {
    let access = parse_access(&access)?;
    let share_id = session_for_tab(&state.share_glue, &tab_id)
        .and_then(|session| share_for_session(&state.share_glue, &session))
        .ok_or_else(|| format!("tab {tab_id} is not shared"))?;
    state
        .hub
        .set_viewer_access(&share_id, viewer_id, access)
        .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tabverse_proto::{Access, SharedTabType};
    use tabverse_remote::{
        InputOutcome, InputPayload, LocalSink, SessionBridge, ShareBinding, ShareSource, Viewport,
    };

    /// The least a source can be, with an observable `unbind`.
    struct StubSource {
        unbound: AtomicBool,
    }

    impl ShareSource for StubSource {
        fn kind(&self) -> SharedTabType {
            SharedTabType::Terminal
        }
        fn grid(&self) -> Option<Viewport> {
            None
        }
        fn inject_input(
            &self,
            _viewer: u64,
            _access: Access,
            _payload: InputPayload,
        ) -> anyhow::Result<InputOutcome> {
            Ok(InputOutcome::Applied)
        }
        fn bind(&self, _binding: ShareBinding) {}
        fn unbind(&self) {
            self.unbound.store(true, Ordering::SeqCst);
        }
    }

    struct NullSink;
    impl LocalSink for NullSink {
        fn data(&self, _bytes: &[u8]) {}
        fn exit(&self, _code: Option<i32>) {}
        fn snapshot_request(&self, _viewer: u64) {}
    }

    fn null_terminal_source() -> Arc<TerminalSource> {
        Arc::new(TerminalSource::new(
            SessionBridge::new(Arc::new(NullSink)),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
            Viewport { cols: 80, rows: 24 },
        ))
    }

    #[test]
    fn shell_self_exit_forgets_the_tab_and_its_share_row() {
        let hub = RemoteHub::new();
        let sources = SourceRegistry::default();
        let glue = ShareGlue::default();

        let stub = Arc::new(StubSource {
            unbound: AtomicBool::new(false),
        });
        sources.register("tab-1", stub.clone());
        glue.session_tabs
            .lock()
            .unwrap()
            .insert("sess-1".into(), "tab-1".into());
        glue.share_sessions
            .lock()
            .unwrap()
            .insert("share-1".into(), "sess-1".into());
        glue.terminal_sources
            .lock()
            .unwrap()
            .insert("sess-1".into(), null_terminal_source());

        // A neighbour tab's rows must survive the sweep untouched.
        glue.session_tabs
            .lock()
            .unwrap()
            .insert("sess-2".into(), "tab-2".into());
        glue.share_sessions
            .lock()
            .unwrap()
            .insert("share-2".into(), "sess-2".into());

        tab_runtime_died(&hub, &sources, &glue, "tab-1");

        assert!(
            sources.get("tab-1").is_none(),
            "the dead tab must leave the registry"
        );
        assert!(
            stub.unbound.load(Ordering::SeqCst),
            "the source must be unbound so nothing more fans out"
        );
        assert!(
            !glue.session_tabs.lock().unwrap().contains_key("sess-1"),
            "the session row dies with its runtime"
        );
        assert!(
            !glue.terminal_sources.lock().unwrap().contains_key("sess-1"),
            "the resize handle dies with its runtime"
        );
        assert!(
            !glue.share_sessions.lock().unwrap().contains_key("share-1"),
            "the share row must not outlive a shell that exited by itself"
        );
        assert_eq!(
            glue.session_tabs
                .lock()
                .unwrap()
                .get("sess-2")
                .map(String::as_str),
            Some("tab-2"),
            "another tab's session row must be untouched"
        );
        assert_eq!(
            glue.share_sessions
                .lock()
                .unwrap()
                .get("share-2")
                .map(String::as_str),
            Some("sess-2"),
            "another tab's share row must be untouched"
        );
    }

    /// The same cleanup runs on a tab that never shared: only its own rows
    /// vanish, and the missing share row is not an error.
    #[test]
    fn a_tab_that_never_shared_dies_without_touching_share_rows() {
        let hub = RemoteHub::new();
        let sources = SourceRegistry::default();
        let glue = ShareGlue::default();
        sources.register(
            "tab-1",
            Arc::new(StubSource {
                unbound: AtomicBool::new(false),
            }),
        );
        glue.session_tabs
            .lock()
            .unwrap()
            .insert("sess-1".into(), "tab-1".into());

        tab_runtime_died(&hub, &sources, &glue, "tab-1");

        assert!(sources.get("tab-1").is_none());
        assert!(glue.session_tabs.lock().unwrap().is_empty());
        assert!(glue.share_sessions.lock().unwrap().is_empty());

        // And a second death of the same tab changes nothing (self-exit
        // followed by term_kill takes this path).
        tab_runtime_died(&hub, &sources, &glue, "tab-1");
    }
}
