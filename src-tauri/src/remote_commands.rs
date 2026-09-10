//! Tauri adapter for joining and controlling Remote sessions.

use std::sync::Arc;

use base64::Engine as _;
use tabverse_proto::RemoteHostMsg;
use tabverse_remote::join;
use tauri::{ipc::Channel, State};

use crate::{uuid_like, AppState};

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[tauri::command]
pub(crate) async fn remote_join(
    state: State<'_, AppState>,
    ticket: String,
    on_event: Channel<RemoteHostMsg>,
) -> Result<String, String> {
    let name = format!("tabverse@{}", hostname_lossy());
    let handle = join(
        &ticket,
        &name,
        Arc::new(move |msg| {
            let _ = on_event.send(msg);
        }),
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    let id = uuid_like();
    state
        .joins
        .lock()
        .unwrap()
        .insert(id.clone(), Arc::new(handle));
    eprintln!("[core] remote_join ok");
    Ok(id)
}

#[tauri::command]
pub(crate) fn remote_input(
    state: State<'_, AppState>,
    id: String,
    data_b64: String,
) -> Result<(), String> {
    let bytes = b64().decode(data_b64).map_err(|e| e.to_string())?;
    let joins = state.joins.lock().unwrap();
    let h = joins.get(&id).ok_or_else(|| "unknown join".to_string())?;
    h.send_input(&bytes);
    Ok(())
}

/// Say something to a shared agent. Needs Steer, which the host enforces.
///
/// The three below are separate commands rather than one with a verb, because
/// they need different permissions and a single entry point would make that
/// distinction a runtime argument instead of a call site.
#[tauri::command]
pub(crate) fn remote_agent_prompt(
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> Result<(), String> {
    let joins = state.joins.lock().unwrap();
    let h = joins.get(&id).ok_or_else(|| "unknown join".to_string())?;
    h.send(tabverse_proto::RemoteClientMsg::AgentPrompt { text });
    Ok(())
}

/// Decide a pending permission request. Needs Approve.
#[tauri::command]
pub(crate) fn remote_agent_answer(
    state: State<'_, AppState>,
    id: String,
    call_id: String,
    allow: bool,
    reason: Option<String>,
) -> Result<(), String> {
    let joins = state.joins.lock().unwrap();
    let h = joins.get(&id).ok_or_else(|| "unknown join".to_string())?;
    h.send(tabverse_proto::RemoteClientMsg::AgentAnswer {
        call_id,
        allow,
        reason,
    });
    Ok(())
}

/// Stop the turn in progress. Needs Steer.
#[tauri::command]
pub(crate) fn remote_agent_cancel(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let joins = state.joins.lock().unwrap();
    let h = joins.get(&id).ok_or_else(|| "unknown join".to_string())?;
    h.send(tabverse_proto::RemoteClientMsg::AgentCancel);
    Ok(())
}

/// Report how many cells this viewer can display; the host shrinks to fit.
#[tauri::command]
pub(crate) fn remote_viewport(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let h = state
        .joins
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("unknown join {id}"))?;
    h.send_resize(cols, rows);
    Ok(())
}

#[tauri::command]
pub(crate) fn remote_ping(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let joins = state.joins.lock().unwrap();
    let h = joins.get(&id).ok_or_else(|| "unknown join".to_string())?;
    h.ping();
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_leave(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let handle = state.joins.lock().unwrap().remove(&id);
    if let Some(h) = handle {
        h.leave().await;
    }
    Ok(())
}

fn hostname_lossy() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown-host".to_string())
}
