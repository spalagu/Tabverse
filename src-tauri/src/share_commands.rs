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
use tabverse_remote::source::ShareSource;
use tabverse_remote::{RemoteHub, ShareOpts, SourceRegistry, ViewerInfo};
use tauri::{AppHandle, Emitter, Manager, State};

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
    /// Single Tab v4 adapters, keyed by the product Tab id.
    contribution_sources: Mutex<HashMap<String, Arc<crate::app_share::ContributionShareSource>>>,
    /// Tab id -> live share id for Terminal, Files, Browser and future contributions.
    tab_shares: Mutex<HashMap<String, String>>,
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
        let tabs: Vec<String> = glue
            .tab_shares
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, current)| *current == &share_id)
            .map(|(tab, _)| tab.clone())
            .collect();
        for tab_id in tabs {
            glue.tab_shares.lock().unwrap().remove(&tab_id);
            if let Some(source) = glue.contribution_sources.lock().unwrap().remove(&tab_id) {
                source.unbind();
            }
        }
        hub.share_stop(&share_id);
    }
}

fn stop_tab_share(hub: &RemoteHub, glue: &ShareGlue, tab_id: &str) {
    let Some(share_id) = glue.tab_shares.lock().unwrap().remove(tab_id) else {
        return;
    };
    if let Some(source) = glue.contribution_sources.lock().unwrap().remove(tab_id) {
        source.unbind();
    }
    glue.share_sessions.lock().unwrap().remove(&share_id);
    hub.share_stop(&share_id);
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
    stop_tab_share(hub, glue, tab_id);
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

/// Transitional host-side allow-list until TCX1101 moves share capability
/// registration into the native PluginKernel catalog. The webview already
/// gates from each contribution's declaration; this second gate ensures a
/// direct command cannot turn Settings or Remote into an accidental file/
/// proxy share by merely supplying their tab id.
fn validate_share_kind(kind: &str) -> Result<(), String> {
    match kind {
        "terminal" | "files" | "browser" => Ok(()),
        other => Err(format!("tab kind {other:?} cannot be shared")),
    }
}

fn semantic_legacy_source(state: &State<'_, AppState>) -> Arc<crate::app_share::AppShareSource> {
    let source = crate::app_share::AppShareSource::new(
        Arc::new(|_, _| {}),
        Arc::new(|| serde_json::json!({"tabs": []})),
        Arc::new(crate::clipboard_watch::put_string),
        Arc::new(crate::remote_proxy::run),
    );
    let fs = state.fs.clone();
    source.register_rpc(
        "fs_list",
        Arc::new(move |args| {
            let dir = args
                .get("dir")
                .and_then(|value| value.as_str())
                .ok_or("fs_list needs a string 'dir'")?;
            serde_json::to_value(fs.list_dir(dir).map_err(|error| format!("{error:#}"))?)
                .map_err(|error| error.to_string())
        }),
    );
    let fs = state.fs.clone();
    source.register_rpc(
        "fs_read",
        Arc::new(move |args| {
            let path = args
                .get("path")
                .and_then(|value| value.as_str())
                .ok_or("fs_read needs a string 'path'")?;
            serde_json::to_value(fs.read_file(path).map_err(|error| format!("{error:#}"))?)
                .map_err(|error| error.to_string())
        }),
    );
    let fs = state.fs.clone();
    source.register_steer_rpc(
        "fs_write",
        Arc::new(move |args| {
            let path = args
                .get("path")
                .and_then(|value| value.as_str())
                .ok_or("fs_write needs a string 'path'")?;
            let content = args
                .get("content")
                .and_then(|value| value.as_str())
                .ok_or("fs_write needs a string 'content'")?;
            fs.write_text(path, content)
                .map_err(|error| format!("{error:#}"))?;
            Ok(serde_json::Value::Null)
        }),
    );
    source
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
#[allow(clippy::too_many_arguments)]
pub async fn share_start(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    kind: String,
    title: String,
    browser_url: Option<String>,
    ttl_secs: Option<u64>,
    // "view" | "steer" | "approve" — the default level for new viewers,
    // chosen in the dialog from the capability's declared levels.
    access: String,
) -> Result<ShareStarted, String> {
    validate_share_kind(&kind)?;
    let access = parse_access(&access)?;
    let _reservation = reserve_start(&state.share_glue, &tab_id)?;
    if state
        .share_glue
        .tab_shares
        .lock()
        .unwrap()
        .contains_key(&tab_id)
    {
        return Err("tab is already shared".into());
    }
    let registered_base = state.sources.get(&tab_id);
    let base: Arc<dyn ShareSource> = if let Some(base) = registered_base.clone() {
        base
    } else {
        let source = semantic_legacy_source(&state);
        if kind == "browser" {
            let url = browser_url.ok_or("a Browser share needs its host URL grant root")?;
            source.authorize_browser_tab(tab_id.clone(), url)?;
            let resident_app = app.clone();
            source.set_resident_browser_exchange(Arc::new(move |tab_id, request| {
                resident_app.state::<AppState>().resident.browser_exchange(
                    &resident_app,
                    tab_id,
                    request,
                )
            }));
        }
        source
    };
    let session_id = session_for_tab(&state.share_glue, &tab_id);
    let contribution_source =
        crate::app_share::ContributionShareSource::new(tab_id.clone(), app.clone(), Some(base));
    let source: Arc<dyn ShareSource> = contribution_source.clone();

    let presence_tab = tab_id.clone();
    let (share, ticket) = state
        .hub
        .share_start(ShareOpts {
            title,
            source,
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

    let still_current = match (&registered_base, &session_id) {
        (Some(expected), Some(session_id)) => {
            state
                .sources
                .get(&tab_id)
                .is_some_and(|current| Arc::ptr_eq(&current, expected))
                && session_for_tab(&state.share_glue, &tab_id).as_deref() == Some(session_id)
        }
        (None, None) => true,
        _ => false,
    };
    if !still_current {
        contribution_source.unbind();
        state.hub.share_stop(&share.id);
        return Err("tab runtime changed while sharing was starting".into());
    }
    state
        .share_glue
        .contribution_sources
        .lock()
        .unwrap()
        .insert(tab_id.clone(), contribution_source);
    state
        .share_glue
        .tab_shares
        .lock()
        .unwrap()
        .insert(tab_id.clone(), share.id.clone());
    if let Some(session_id) = session_id {
        state
            .share_glue
            .share_sessions
            .lock()
            .unwrap()
            .insert(share.id.clone(), session_id);
    }
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
    stop_tab_share(&state.hub, &state.share_glue, &tab_id);
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
    let resident_app = app.clone();
    source.set_resident_browser_exchange(Arc::new(move |tab_id, request| {
        resident_app
            .state::<AppState>()
            .resident
            .browser_exchange(&resident_app, tab_id, request)
    }));
    register_app_rpc_read_commands(&state);
    register_app_rpc_steer_commands(&state);
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
}

fn app_snapshot_for_wire(snapshot: serde_json::Value) -> serde_json::Value {
    use serde_json::{Map, Value};

    const TAB_FIELDS: &[&str] = &[
        "id",
        "kind",
        "title",
        "groupId",
        "cwd",
        "url",
        "renamed",
        "pinnedUrl",
        "lastActiveAt",
        "dormant",
    ];
    const GROUP_FIELDS: &[&str] = &["id", "name", "colorIndex", "color", "collapsed", "parentId"];
    let root = snapshot.as_object();
    let mut tab_ids = HashSet::new();
    let mut group_ids = HashSet::new();
    let mut tabs = Vec::new();
    for raw in root
        .and_then(|object| object.get("tabs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(tab) = raw.as_object() else { continue };
        let kind = tab
            .get("kind")
            .or_else(|| tab.get("type"))
            .and_then(Value::as_str);
        if !matches!(kind, Some("terminal" | "files" | "browser")) {
            continue;
        }
        let Some(id) = tab.get("id").and_then(Value::as_str) else {
            continue;
        };
        tab_ids.insert(id.to_string());
        if let Some(group_id) = tab.get("groupId").and_then(Value::as_str) {
            group_ids.insert(group_id.to_string());
        }
        let mut clean = Map::new();
        for field in TAB_FIELDS {
            if let Some(value) = tab.get(*field) {
                clean.insert((*field).into(), value.clone());
            }
        }
        clean.insert("kind".into(), Value::String(kind.unwrap().into()));
        tabs.push(Value::Object(clean));
    }

    let raw_groups: Vec<&Map<String, Value>> = root
        .and_then(|object| object.get("groups"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .collect();
    loop {
        let before = group_ids.len();
        for group in &raw_groups {
            let Some(id) = group.get("id").and_then(Value::as_str) else {
                continue;
            };
            if group_ids.contains(id) {
                if let Some(parent) = group.get("parentId").and_then(Value::as_str) {
                    group_ids.insert(parent.to_string());
                }
            }
        }
        if group_ids.len() == before {
            break;
        }
    }
    let groups = raw_groups
        .into_iter()
        .filter(|group| {
            group
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| group_ids.contains(id))
        })
        .map(|group| {
            Value::Object(
                GROUP_FIELDS
                    .iter()
                    .filter_map(|field| {
                        group
                            .get(*field)
                            .cloned()
                            .map(|value| ((*field).to_string(), value))
                    })
                    .collect(),
            )
        })
        .collect::<Vec<_>>();
    let active_tab_id = root
        .and_then(|object| object.get("activeTabId"))
        .and_then(Value::as_str)
        .filter(|id| tab_ids.contains(*id))
        .map(str::to_string)
        .or_else(|| tabs.first()?.get("id")?.as_str().map(str::to_string));
    let split = root
        .and_then(|object| object.get("split"))
        .and_then(Value::as_object)
        .and_then(|split| {
            let ids = split.get("ids")?.as_array()?;
            let ratios = split.get("ratios").and_then(Value::as_array);
            let kept = ids
                .iter()
                .enumerate()
                .filter_map(|(index, id)| {
                    let id = id.as_str()?;
                    tab_ids.contains(id).then(|| {
                        let ratio = ratios
                            .and_then(|values| values.get(index))
                            .and_then(Value::as_f64)
                            .filter(|ratio| ratio.is_finite() && *ratio > 0.0)
                            .unwrap_or(1.0);
                        (id.to_string(), ratio)
                    })
                })
                .collect::<Vec<_>>();
            if kept.len() < 2 {
                return None;
            }
            let total = kept.iter().map(|(_, ratio)| ratio).sum::<f64>();
            Some(serde_json::json!({
                "ids": kept.iter().map(|(id, _)| id).collect::<Vec<_>>(),
                "ratios": kept.iter().map(|(_, ratio)| ratio / total).collect::<Vec<_>>(),
                "vertical": split.get("vertical").and_then(Value::as_bool).unwrap_or(false),
            }))
        });
    let string_map = |name: &str| -> Value {
        let mut clean = Map::new();
        if let Some(values) = root
            .and_then(|object| object.get(name))
            .and_then(Value::as_object)
        {
            for (tab_id, value) in values {
                if tab_ids.contains(tab_id) && value.is_string() {
                    clean.insert(tab_id.clone(), value.clone());
                }
            }
        }
        Value::Object(clean)
    };
    serde_json::json!({
        "version": 2,
        "zones": 3,
        "tabs": tabs,
        "groups": groups,
        "activeTabId": active_tab_id,
        "split": split,
        "filesOpenPath": string_map("filesOpenPath"),
        "filesOpenDir": string_map("filesOpenDir"),
    })
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
    let snapshot = app_snapshot_for_wire(snapshot);
    state.app_source.sync_browser_grants(&snapshot);
    if let Some(share) = state.app_source.bound_share() {
        share.broadcast_app_snapshot(snapshot);
    }
    Ok(())
}

fn remote_counter(value: &str, field: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{field} must be an unsigned decimal counter"))
}

fn sync_browser_contribution_grant(
    state: &State<'_, AppState>,
    tab_id: &str,
    kind: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    if kind != "browser" {
        return Ok(());
    }
    let url = value
        .get("url")
        .or_else(|| value.get("state").and_then(|state| state.get("url")))
        .and_then(serde_json::Value::as_str);
    let Some(url) = url else { return Ok(()) };
    if state.app_source.bound_share().is_some() {
        state
            .app_source
            .update_browser_grant(tab_id, url)
            .map_err(|error| error.to_string())?;
    }
    let source = state
        .share_glue
        .contribution_sources
        .lock()
        .unwrap()
        .get(tab_id)
        .cloned();
    if let Some(source) = source {
        source
            .update_browser_grant(tab_id, url)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn app_share_contribution_snapshot(
    state: State<'_, AppState>,
    viewer: Option<u64>,
    tab_id: String,
    kind: String,
    epoch: String,
    snapshot_revision: String,
    last_frame_seq: String,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    let revision = remote_counter(&snapshot_revision, "snapshotRevision")?;
    let frame_seq = remote_counter(&last_frame_seq, "lastFrameSeq")?;
    sync_browser_contribution_grant(&state, &tab_id, &kind, &snapshot)?;
    if let Some(share) = state.app_source.bound_share() {
        if let Some(viewer) = viewer {
            share.send_contribution_snapshot(
                viewer,
                tab_id.clone(),
                kind.clone(),
                epoch.clone(),
                revision,
                frame_seq,
                snapshot.clone(),
            );
        } else {
            share.broadcast_contribution_snapshot(
                tab_id.clone(),
                kind.clone(),
                epoch.clone(),
                revision,
                frame_seq,
                snapshot.clone(),
            );
        }
    }
    let source = state
        .share_glue
        .contribution_sources
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned();
    if let Some(share) = source.and_then(|source| source.bound_share()) {
        if let Some(viewer) = viewer {
            share.send_contribution_snapshot(
                viewer, tab_id, kind, epoch, revision, frame_seq, snapshot,
            );
        } else {
            share.broadcast_contribution_snapshot(
                tab_id, kind, epoch, revision, frame_seq, snapshot,
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub fn app_share_contribution_frame(
    state: State<'_, AppState>,
    viewer: Option<u64>,
    tab_id: String,
    kind: String,
    epoch: String,
    frame_seq: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let frame_seq = remote_counter(&frame_seq, "frameSeq")?;
    sync_browser_contribution_grant(&state, &tab_id, &kind, &payload)?;
    if let Some(share) = state.app_source.bound_share() {
        if let Some(viewer) = viewer {
            share.send_contribution_frame(
                viewer,
                tab_id.clone(),
                kind.clone(),
                epoch.clone(),
                frame_seq,
                payload.clone(),
            );
        } else {
            share.broadcast_contribution_frame(
                tab_id.clone(),
                kind.clone(),
                epoch.clone(),
                frame_seq,
                payload.clone(),
            );
        }
    }
    let source = state
        .share_glue
        .contribution_sources
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned();
    if let Some(share) = source.and_then(|source| source.bound_share()) {
        if let Some(viewer) = viewer {
            share.send_contribution_frame(viewer, tab_id, kind, epoch, frame_seq, payload);
        } else {
            share.broadcast_contribution_frame(tab_id, kind, epoch, frame_seq, payload);
        }
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn app_share_intent_result(
    state: State<'_, AppState>,
    viewer: u64,
    tab_id: String,
    attachment_id: String,
    attachment_generation: String,
    intent_id: String,
    ok: Option<serde_json::Value>,
    err: Option<String>,
) -> Result<(), String> {
    let generation = remote_counter(&attachment_generation, "attachmentGeneration")?;
    if let Some(share) = state.app_source.bound_share() {
        share.send_intent_result(
            viewer,
            attachment_id.clone(),
            generation,
            intent_id.clone(),
            ok.clone(),
            err.clone(),
        );
    }
    let source = state
        .share_glue
        .contribution_sources
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned();
    if let Some(share) = source.and_then(|source| source.bound_share()) {
        share.send_intent_result(viewer, attachment_id, generation, intent_id, ok, err);
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn app_share_private_stream(
    state: State<'_, AppState>,
    viewer: u64,
    tab_id: String,
    attachment_id: String,
    attachment_generation: String,
    stream_id: String,
    seq: String,
    fin: bool,
    payload_b64: String,
) -> Result<(), String> {
    let generation = remote_counter(&attachment_generation, "attachmentGeneration")?;
    let sequence = remote_counter(&seq, "seq")?;
    if let Some(share) = state.app_source.bound_share() {
        share.send_private_stream(
            viewer,
            attachment_id.clone(),
            generation,
            stream_id.clone(),
            sequence,
            fin,
            payload_b64.clone(),
        );
    }
    let source = state
        .share_glue
        .contribution_sources
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned();
    if let Some(share) = source.and_then(|source| source.bound_share()) {
        share.send_private_stream(
            viewer,
            attachment_id,
            generation,
            stream_id,
            sequence,
            fin,
            payload_b64,
        );
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
    let shares: Vec<String> = state
        .share_glue
        .share_sessions
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, owner)| owner.as_str() == APP_SHARE_TAB_ID)
        .map(|(share, _)| share.clone())
        .collect();
    for share_id in shares {
        state
            .share_glue
            .share_sessions
            .lock()
            .unwrap()
            .remove(&share_id);
        state.hub.share_stop(&share_id);
    }
    Ok(())
}
#[tauri::command]
pub fn app_share_broadcast_action(
    state: State<'_, AppState>,
    name: String,
    args: serde_json::Value,
    snapshot: Option<serde_json::Value>,
) {
    eprintln!("[core] app_share_broadcast_action {name}");
    if let Some(snapshot) = snapshot {
        state
            .app_source
            .sync_browser_grants(&app_snapshot_for_wire(snapshot));
    }
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
    let share_id = state
        .share_glue
        .tab_shares
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
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
    fn native_share_gate_keeps_settings_and_remote_off_wire() {
        assert!(validate_share_kind("terminal").is_ok());
        assert!(validate_share_kind("files").is_ok());
        assert!(validate_share_kind("browser").is_ok());
        assert_eq!(
            validate_share_kind("settings").unwrap_err(),
            "tab kind \"settings\" cannot be shared"
        );
        assert!(validate_share_kind("remote").is_err());
        assert!(validate_share_kind("future-unregistered-tab").is_err());
    }

    #[test]
    fn whole_app_rpc_registry_contains_no_settings_commands() {
        let source = include_str!("share_commands.rs");
        let read_start = source.find("fn register_app_rpc_read_commands").unwrap();
        let stop = source[read_start..]
            .find("/// The webview's answer")
            .map(|offset| read_start + offset)
            .unwrap();
        let registry = &source[read_start..stop];
        for command in ["config_get", "config_schema", "config_set", "config_reset"] {
            assert!(
                !registry.contains(command),
                "{command} must not be remote RPC"
            );
        }
    }

    #[test]
    fn native_serializer_removes_private_tabs_and_unknown_fields() {
        let wire = app_snapshot_for_wire(serde_json::json!({
            "version": 2,
            "tabs": [
                {"id":"terminal-1","kind":"terminal","title":"Shell","groupId":"work","settingsSecret":"PRIVATE_NESTED"},
                {"id":"files-1","kind":"files","title":"Files","groupId":null},
                {"id":"settings-1","kind":"settings","title":"PRIVATE_SETTINGS","groupId":"settings-group"},
                {"id":"agent-1","kind":"agent","title":"PRIVATE_AGENT","groupId":"agent-group"}
            ],
            "groups": [
                {"id":"work","name":"Work","collapsed":false},
                {"id":"settings-group","name":"PRIVATE_SETTINGS_GROUP","collapsed":false},
                {"id":"agent-group","name":"PRIVATE_AGENT_GROUP","collapsed":false}
            ],
            "activeTabId":"settings-1",
            "split":{"ids":["terminal-1","settings-1","files-1"],"ratios":[0.2,0.3,0.5],"vertical":false},
            "filesOpenPath":{"settings-1":"PRIVATE_SETTINGS_PATH"},
            "unexpectedSettings":"PRIVATE_TOP_LEVEL"
        }));
        assert_eq!(wire["tabs"].as_array().unwrap().len(), 2);
        assert_eq!(wire["activeTabId"], "terminal-1");
        assert_eq!(
            wire["split"]["ids"],
            serde_json::json!(["terminal-1", "files-1"])
        );
        let text = wire.to_string();
        for marker in ["settings", "agent", "PRIVATE_"] {
            assert!(
                !text.to_lowercase().contains(&marker.to_lowercase()),
                "{text}"
            );
        }
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
