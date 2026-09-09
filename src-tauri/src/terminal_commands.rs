//! Tauri adapter for helper-owned Terminal runtimes.
//!
//! This module owns GUI attachment, helper event buffering and the Terminal
//! command surface. Process/runtime semantics remain in tabverse-term and
//! sharing semantics remain in tabverse-remote.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use tabverse_proto::TermEvent;
use tabverse_remote::source::terminal::TerminalSource;
use tabverse_remote::{LocalSink, SessionBridge, Viewport};
use tabverse_term::{
    client::HelperEventCallback,
    protocol::{Frame as HelperFrame, Kind as HelperKind, SessionId as HelperSessionId},
};
use tauri::{ipc::Channel, AppHandle, Emitter, State};

use crate::{profiles, share_commands, AppState};

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// The webview end of a session. Ordered dispatch and snapshot sequencing live
/// in `tabverse_remote::SessionBridge` so they stay testable without a GUI.
struct WebviewSink {
    channel: Channel<TermEvent>,
}

impl LocalSink for WebviewSink {
    fn data(&self, bytes: &[u8]) {
        let _ = self.channel.send(TermEvent::Data {
            b64: b64().encode(bytes),
        });
    }
    fn exit(&self, code: Option<i32>) {
        let _ = self.channel.send(TermEvent::Exit { code });
    }
    fn snapshot_request(&self, viewer: u64) {
        let _ = self.channel.send(TermEvent::SnapshotRequest { viewer });
    }
}

const HELPER_BACKLOG_MAX_BYTES: usize = 256 * 1024;
const HELPER_BACKLOG_MAX_FRAMES: usize = 1024;

fn push_helper_backlog(
    backlog: &Arc<Mutex<HashMap<String, Vec<HelperFrame>>>>,
    id: String,
    frame: HelperFrame,
) {
    let mut all = backlog.lock().unwrap();
    let frames = all.entry(id).or_default();
    frames.push(frame);
    let mut bytes: usize = frames.iter().map(|item| item.payload.len()).sum();
    while frames.len() > HELPER_BACKLOG_MAX_FRAMES || bytes > HELPER_BACKLOG_MAX_BYTES {
        let remove_at = frames
            .iter()
            .position(|item| item.kind != HelperKind::Exit)
            .unwrap_or(0);
        bytes = bytes.saturating_sub(frames[remove_at].payload.len());
        frames.remove(remove_at);
    }
}

fn deliver_helper_frame(
    bridges: &Arc<Mutex<HashMap<String, Arc<SessionBridge>>>>,
    backlog: &Arc<Mutex<HashMap<String, Vec<HelperFrame>>>>,
    frame: HelperFrame,
) {
    let id = frame.session_id.to_hex();
    let Some(bridge) = bridges.lock().unwrap().get(&id).cloned() else {
        if matches!(
            frame.kind,
            HelperKind::Output | HelperKind::Snapshot | HelperKind::Exit
        ) {
            push_helper_backlog(backlog, id, frame);
        }
        return;
    };
    match frame.kind {
        HelperKind::Output | HelperKind::Snapshot => bridge.dispatch_data(&frame.payload),
        HelperKind::Exit => {
            let code = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                .ok()
                .and_then(|v| v.get("code").and_then(|c| c.as_u64()))
                .map(|c| c as i32);
            bridge.dispatch_exit(code);
        }
        _ => {}
    }
}
pub(crate) fn helper_callback(state: &AppState, app: &AppHandle) -> HelperEventCallback {
    let event_app = app.clone();
    let bridges = Arc::clone(&state.bridges);
    let backlog = Arc::clone(&state.helper_backlog);
    let generations = Arc::clone(&state.helper_generations);
    let hub = Arc::clone(&state.hub);
    let sources = Arc::clone(&state.sources);
    let share_glue = Arc::clone(&state.share_glue);
    let app_source = Arc::clone(&state.app_source);
    Arc::new(move |frame| {
        if frame.kind == HelperKind::Output {
            let active_session = app_source
                .active_tab()
                .and_then(|tab| share_commands::session_for_tab(&share_glue, &tab));
            if active_session.as_deref() == Some(frame.session_id.to_hex().as_str()) {
                app_source.broadcast_term(&frame.payload);
            }
        }
        let is_exit = frame.kind == HelperKind::Exit;
        let session_id = frame.session_id.to_hex();
        deliver_helper_frame(&bridges, &backlog, frame);
        if is_exit {
            let tab_id = share_glue
                .session_tabs
                .lock()
                .unwrap()
                .get(&session_id)
                .cloned();
            if let Some(tab_id) = tab_id {
                share_commands::tab_runtime_died(&hub, &sources, &share_glue, &tab_id);
            }
            bridges.lock().unwrap().remove(&session_id);
            backlog.lock().unwrap().remove(&session_id);
            generations.lock().unwrap().remove(&session_id);
            let _ = event_app.emit("background-tasks-changed", ());
        }
    })
}
fn flush_helper_backlog(
    bridges: &Arc<Mutex<HashMap<String, Arc<SessionBridge>>>>,
    backlog: &Arc<Mutex<HashMap<String, Vec<HelperFrame>>>>,
    id: &str,
) {
    let pending = backlog.lock().unwrap().remove(id).unwrap_or_default();
    for frame in pending {
        deliver_helper_frame(bridges, backlog, frame);
    }
}
fn install_helper_bridge(state: &AppState, id: &str, bridge: Arc<SessionBridge>) {
    state.bridges.lock().unwrap().insert(id.to_string(), bridge);
    flush_helper_backlog(&state.bridges, &state.helper_backlog, id);
}
fn helper_session(
    state: &AppState,
    id: &str,
) -> Result<
    (
        Arc<tabverse_term::client::HelperClient>,
        HelperSessionId,
        u64,
    ),
    String,
> {
    let session = HelperSessionId::from_hex(id).map_err(|e| e.to_string())?;
    let generation = state
        .helper_generations
        .lock()
        .unwrap()
        .get(id)
        .copied()
        .ok_or_else(|| format!("unknown helper session {id}"))?;
    let client = state
        .helper
        .current()
        .ok_or_else(|| "terminal helper is not connected".to_string())?;
    Ok((client, session, generation))
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn term_create(
    app: AppHandle,
    state: State<'_, AppState>,
    on_event: Channel<TermEvent>,
    tab_id: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    profile: Option<String>,
    run_on_start: Option<String>,
) -> Result<String, String> {
    eprintln!("[core] term_create cols={cols} rows={rows} cwd={cwd:?} tab={tab_id:?} profile={profile:?} run_on_start={run_on_start:?}");
    let opts = profiles::resolve(&profiles::TermRequest {
        cols,
        rows,
        cwd,
        profile,
        run_on_start,
    })?;
    let request = serde_json::json!({"shell":opts.shell,"cwd":opts.cwd,"cols":opts.cols,"rows":opts.rows,"env":opts.env,"shell_integration":opts.shell_integration,"run_on_start":opts.run_on_start});
    let client = state.helper.ensure(&app, helper_callback(&state, &app))?;
    let spawned = client
        .request(
            &HelperFrame::new(
                HelperKind::Spawn,
                HelperSessionId::default(),
                0,
                serde_json::to_vec(&request).map_err(|e| e.to_string())?,
            ),
            HelperKind::Spawn,
            None,
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| e.to_string())?;
    let id = spawned.session_id.to_hex();
    state
        .helper_generations
        .lock()
        .unwrap()
        .insert(id.clone(), spawned.generation);
    let bridge = SessionBridge::new(Arc::new(WebviewSink { channel: on_event }));
    install_helper_bridge(&state, &id, bridge.clone());
    if let Some(tab_id) = tab_id {
        let input_client = client.clone();
        let input_session = spawned.session_id;
        let input_generation = spawned.generation;
        let viewport_app = app.clone();
        let viewport_session = id.clone();
        let source = Arc::new(TerminalSource::new(
            bridge,
            Arc::new(move |bytes| {
                let _ = input_client.send(&HelperFrame::new(
                    HelperKind::Input,
                    input_session,
                    input_generation,
                    bytes.to_vec(),
                ));
            }),
            Arc::new(move |vp: Option<Viewport>| {
                let _ = viewport_app.emit(
                    "share-viewport",
                    share_commands::ViewportEvent {
                        session_id: viewport_session.clone(),
                        cols: vp.map(|v| v.cols),
                        rows: vp.map(|v| v.rows),
                    },
                );
            }),
            Viewport { cols, rows },
        ));
        state
            .share_glue
            .session_tabs
            .lock()
            .unwrap()
            .insert(id.clone(), tab_id.clone());
        state
            .share_glue
            .terminal_sources
            .lock()
            .unwrap()
            .insert(id.clone(), source.clone());
        state.sources.register(&tab_id, source);
    }

    Ok(id)
}
#[tauri::command]
pub(crate) async fn term_write(
    state: State<'_, AppState>,
    id: String,
    data_b64: String,
) -> Result<(), String> {
    let bytes = b64().decode(data_b64).map_err(|e| e.to_string())?;
    let (client, session, generation) = helper_session(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        client
            .send(&HelperFrame::new(
                HelperKind::Input,
                session,
                generation,
                bytes,
            ))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn term_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (client, session, generation) = helper_session(&state, &id)?;
    client
        .send(&HelperFrame::new(
            HelperKind::Resize,
            session,
            generation,
            serde_json::to_vec(&serde_json::json!({"cols":cols,"rows":rows}))
                .map_err(|e| e.to_string())?,
        ))
        .map_err(|e| e.to_string())?;
    if let Some(bridge) = state.bridges.lock().unwrap().get(&id) {
        bridge.dispatch_resize(cols, rows);
    }
    if let Some(source) = state.share_glue.terminal_sources.lock().unwrap().get(&id) {
        // Keep the adapter's grid truthful, so a share started after this
        // resize reports the right size in Welcome. A share already live was
        // told through dispatch_resize above.
        source.set_grid(Viewport { cols, rows });
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn term_kill(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let session = HelperSessionId::from_hex(&id).map_err(|e| e.to_string())?;
    let generation = state
        .helper_generations
        .lock()
        .unwrap()
        .get(&id)
        .copied()
        .unwrap_or(0);
    let client = state.helper.ensure(&app, helper_callback(&state, &app))?;
    client
        .request(
            &HelperFrame::new(HelperKind::Terminate, session, generation, Vec::new()),
            HelperKind::Terminate,
            Some(session),
            std::time::Duration::from_secs(3),
        )
        .map_err(|e| e.to_string())?;
    let tab_id = state
        .share_glue
        .session_tabs
        .lock()
        .unwrap()
        .get(&id)
        .cloned();
    if let Some(tab_id) = tab_id {
        share_commands::tab_runtime_died(&state.hub, &state.sources, &state.share_glue, &tab_id);
    }
    state.bridges.lock().unwrap().remove(&id);
    state.helper_generations.lock().unwrap().remove(&id);
    let _ = app.emit("background-tasks-changed", ());
    Ok(())
}
#[tauri::command]
pub(crate) fn term_detach(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let (client, session, generation) = helper_session(&state, &id)?;
    let out = client
        .request(
            &HelperFrame::new(HelperKind::Detach, session, generation, Vec::new()),
            HelperKind::Detach,
            Some(session),
            std::time::Duration::from_secs(3),
        )
        .map_err(|e| e.to_string())?;
    state
        .helper_generations
        .lock()
        .unwrap()
        .insert(id.clone(), out.generation);
    let tab_id = state
        .share_glue
        .session_tabs
        .lock()
        .unwrap()
        .get(&id)
        .cloned();
    if let Some(tab_id) = tab_id {
        share_commands::tab_runtime_died(&state.hub, &state.sources, &state.share_glue, &tab_id);
    }
    state.bridges.lock().unwrap().remove(&id);
    let _ = app.emit("background-tasks-changed", ());
    Ok(())
}
#[tauri::command]
pub(crate) fn term_attach(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    tab_id: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> Result<String, String> {
    let session = HelperSessionId::from_hex(&id).map_err(|e| e.to_string())?;
    let client = state.helper.ensure(&app, helper_callback(&state, &app))?;
    let snapshot = client
        .request(
            &HelperFrame::new(HelperKind::Attach, session, 0, Vec::new()),
            HelperKind::Snapshot,
            Some(session),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| e.to_string())?;
    state
        .helper_generations
        .lock()
        .unwrap()
        .insert(id.clone(), snapshot.generation);
    let bridge = SessionBridge::new(Arc::new(WebviewSink { channel: on_event }));
    install_helper_bridge(&state, &id, bridge.clone());
    bridge.dispatch_data(&snapshot.payload);
    if let Some(tab_id) = tab_id {
        let input_client = client.clone();
        let input_generation = snapshot.generation;
        let viewport_app = app.clone();
        let viewport_session = id.clone();
        let source = Arc::new(TerminalSource::new(
            bridge,
            Arc::new(move |bytes| {
                let _ = input_client.send(&HelperFrame::new(
                    HelperKind::Input,
                    session,
                    input_generation,
                    bytes.to_vec(),
                ));
            }),
            Arc::new(move |vp: Option<Viewport>| {
                let _ = viewport_app.emit(
                    "share-viewport",
                    share_commands::ViewportEvent {
                        session_id: viewport_session.clone(),
                        cols: vp.map(|value| value.cols),
                        rows: vp.map(|value| value.rows),
                    },
                );
            }),
            Viewport { cols, rows },
        ));
        state
            .share_glue
            .session_tabs
            .lock()
            .unwrap()
            .insert(id.clone(), tab_id.clone());
        state
            .share_glue
            .terminal_sources
            .lock()
            .unwrap()
            .insert(id.clone(), source.clone());
        state.sources.register(&tab_id, source);
    }
    let _ = app.emit("background-tasks-changed", ());
    Ok(id)
}
#[tauri::command]
pub(crate) fn term_helper_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.helper.ensure(&app, helper_callback(&state, &app))?;
    let list = client
        .request(
            &HelperFrame::new(HelperKind::List, HelperSessionId::default(), 0, Vec::new()),
            HelperKind::List,
            None,
            std::time::Duration::from_secs(3),
        )
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&list.payload).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn term_helper_kill_all(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let client = state.helper.ensure(&app, helper_callback(&state, &app))?;
    client
        .request(
            &HelperFrame::new(
                HelperKind::KillAll,
                HelperSessionId::default(),
                0,
                Vec::new(),
            ),
            HelperKind::KillAll,
            None,
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| e.to_string())?;
    state.bridges.lock().unwrap().clear();
    state.helper_backlog.lock().unwrap().clear();
    state.helper_generations.lock().unwrap().clear();
    let _ = app.emit("background-tasks-changed", ());
    Ok(())
}

#[cfg(test)]
mod helper_route_tests {
    use super::*;
    struct CaptureSink {
        bytes: Arc<Mutex<Vec<u8>>>,
        exits: Arc<Mutex<Vec<Option<i32>>>>,
    }
    impl LocalSink for CaptureSink {
        fn data(&self, b: &[u8]) {
            self.bytes.lock().unwrap().extend_from_slice(b)
        }
        fn exit(&self, c: Option<i32>) {
            self.exits.lock().unwrap().push(c)
        }
        fn snapshot_request(&self, _: u64) {}
    }
    #[test]
    fn early_helper_events_wait_for_bridge_then_arrive_in_order() {
        let bridges = Arc::new(Mutex::new(HashMap::new()));
        let backlog = Arc::new(Mutex::new(HashMap::new()));
        let session = HelperSessionId([0x33; 16]);
        let id = session.to_hex();
        deliver_helper_frame(
            &bridges,
            &backlog,
            HelperFrame::new(HelperKind::Output, session, 1, b"early-".to_vec()),
        );
        deliver_helper_frame(
            &bridges,
            &backlog,
            HelperFrame::new(HelperKind::Output, session, 1, b"bytes".to_vec()),
        );
        assert_eq!(backlog.lock().unwrap().get(&id).unwrap().len(), 2);
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let exits = Arc::new(Mutex::new(Vec::new()));
        bridges.lock().unwrap().insert(
            id.clone(),
            SessionBridge::new(Arc::new(CaptureSink {
                bytes: Arc::clone(&bytes),
                exits: Arc::clone(&exits),
            })),
        );
        flush_helper_backlog(&bridges, &backlog, &id);
        assert_eq!(&*bytes.lock().unwrap(), b"early-bytes");
        assert!(backlog.lock().unwrap().get(&id).is_none());
        deliver_helper_frame(
            &bridges,
            &backlog,
            HelperFrame::new(HelperKind::Exit, session, 1, br#"{"code":7}"#.to_vec()),
        );
        assert_eq!(&*exits.lock().unwrap(), &[Some(7)]);
    }

    #[test]
    fn helper_backlog_is_bounded_and_keeps_exit() {
        let bridges = Arc::new(Mutex::new(HashMap::new()));
        let backlog = Arc::new(Mutex::new(HashMap::new()));
        let session = HelperSessionId([0x44; 16]);
        let id = session.to_hex();
        for _ in 0..(HELPER_BACKLOG_MAX_FRAMES + 200) {
            deliver_helper_frame(
                &bridges,
                &backlog,
                HelperFrame::new(HelperKind::Output, session, 1, vec![0; 1024]),
            );
        }
        deliver_helper_frame(
            &bridges,
            &backlog,
            HelperFrame::new(HelperKind::Exit, session, 1, br#"{"code":0}"#.to_vec()),
        );
        let held = backlog.lock().unwrap();
        let frames = held.get(&id).unwrap();
        assert!(frames.len() <= HELPER_BACKLOG_MAX_FRAMES);
        assert!(
            frames
                .iter()
                .map(|frame| frame.payload.len())
                .sum::<usize>()
                <= HELPER_BACKLOG_MAX_BYTES
        );
        assert!(frames.iter().any(|frame| frame.kind == HelperKind::Exit));
    }
}
