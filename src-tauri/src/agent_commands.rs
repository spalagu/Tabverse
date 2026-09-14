//! Tauri adapter for Agent authentication and tab runtimes.

use std::sync::Arc;

use tabverse_remote::source::agent::AgentSource;
use tabverse_remote::{RemoteHub, SourceRegistry};
use tauri::{AppHandle, State};

use crate::{
    agent_bridge, agent_client, agent_http, agent_login, credentials, share_commands,
    terminal_commands, AppState,
};

// ---- agent sign-in ---------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginStarted {
    /// Where to send the browser.
    url: String,
    interval_secs: u64,
}

/// Begin signing in to a ChatGPT subscription.
///
/// Returns what the user has to do. The waiting is the caller's, one poll at a
/// time, so the interface can show a countdown and offer to cancel rather than
/// blocking on a fifteen-minute call.
#[tauri::command]
pub(crate) fn agent_login_start() -> Result<LoginStarted, String> {
    // Browser, not device code. OpenAI answers 404 to the device endpoints for
    // ordinary accounts — upstream's own message for that status says as much
    // and sends the caller to browser login.
    let pending = agent_login::start("tabverse").map_err(|e| format!("{e:#}"))?;
    let url = pending.url.clone();
    *login_in_flight().lock().unwrap() = Some(pending);
    Ok(LoginStarted {
        url,
        // Nothing on this side rate-limits us, but the interface polls on this
        // and a tight loop against our own mutex is still waste.
        interval_secs: 1,
    })
}

/// The one sign-in that may be in flight, held here rather than handed to the
/// interface because it carries the PKCE verifier.
fn login_in_flight() -> &'static std::sync::Mutex<Option<agent_login::Pending>> {
    static PENDING: std::sync::OnceLock<std::sync::Mutex<Option<agent_login::Pending>>> =
        std::sync::OnceLock::new();
    PENDING.get_or_init(|| std::sync::Mutex::new(None))
}

/// One poll. "pending" is the ordinary answer, not an error.
#[tauri::command]
pub(crate) fn agent_login_poll() -> Result<String, String> {
    use agent_login::Progress;
    let held = login_in_flight().lock().unwrap();
    let Some(pending) = held.as_ref() else {
        return Err("no sign-in is in progress".to_string());
    };
    match pending.progress() {
        Progress::Waiting => Ok("pending".to_string()),
        Progress::Done => Ok("ready".to_string()),
        Progress::Failed(why) => Err(why),
    }
}

/// Whether there is a usable sign-in on this machine.
#[tauri::command]
pub(crate) fn agent_login_status() -> Result<bool, String> {
    agent_http::stored_token()
        .map(|token| token.is_some())
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) fn agent_logout() -> Result<(), String> {
    agent_http::forget_token().map_err(|e| format!("{e:#}"))
}

// ---- agent tab -------------------------------------------------------------
// One session per tab. The registry owns the threads; these are thin.

#[tauri::command]
pub(crate) fn agent_start(
    app: AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, Arc<agent_client::AgentClientRegistry>>,
    session_id: String,
    cwd: String,
    on_event: tauri::ipc::Channel<tabverse_agent::event::SessionEvent>,
) -> Result<String, String> {
    let log_dir = Some(crate::state_commands::content_dir(&app)?);
    state
        .helper
        .ensure(&app, terminal_commands::helper_callback(&state, &app))?;
    let endpoint = state.helper.agent_endpoint(&app)?;
    let token = tabverse_runtime::agent_ipc::AuthToken::new(credentials::helper_token()?);
    registry
        .connect(&endpoint, token)
        .map_err(|e| format!("{e:#}"))?;
    let events: agent_bridge::AgentEventCallback = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    let id = registry
        .start(session_id.clone(), cwd, log_dir, events)
        .map_err(|e| format!("{e:#}"))?;
    if let Some(hooks) = registry.agent_hooks(&id) {
        state
            .sources
            .register(&session_id, Arc::new(AgentSource::new(hooks)));
        state
            .share_glue
            .session_tabs
            .lock()
            .unwrap()
            .insert(id.clone(), session_id);
    }
    Ok(id)
}

#[tauri::command]
pub(crate) fn agent_prompt(
    registry: State<'_, Arc<agent_client::AgentClientRegistry>>,
    id: String,
    text: String,
) -> Result<(), String> {
    registry.prompt(&id, text).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) fn agent_cancel(
    registry: State<'_, Arc<agent_client::AgentClientRegistry>>,
    id: String,
) -> Result<(), String> {
    registry.cancel(&id).map_err(|e| format!("{e:#}"))
}

/// Answer a pending approval. Returns false when nothing was waiting on that
/// call — a stale click, or a request that already timed out.
#[tauri::command]
pub(crate) fn agent_answer(
    registry: State<'_, Arc<agent_client::AgentClientRegistry>>,
    id: String,
    call_id: String,
    allow: bool,
    reason: Option<String>,
) -> Result<bool, String> {
    registry
        .answer(&id, &call_id, allow, reason)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) fn agent_close(
    state: State<'_, AppState>,
    registry: State<'_, Arc<agent_client::AgentClientRegistry>>,
    id: String,
) {
    close_agent_tab(
        &state.hub,
        &state.sources,
        &state.share_glue,
        registry.inner().as_ref(),
        &id,
    );
}

#[tauri::command]
pub(crate) fn agent_detach(
    registry: State<'_, Arc<agent_client::AgentClientRegistry>>,
    id: String,
) {
    registry.detach(&id);
}

pub(crate) trait AgentCloser {
    fn close_agent(&self, id: &str);
}

impl AgentCloser for agent_client::AgentClientRegistry {
    fn close_agent(&self, id: &str) {
        self.close(id);
    }
}

#[cfg(test)]
impl AgentCloser for agent_bridge::AgentRegistry {
    fn close_agent(&self, id: &str) {
        self.close(id);
    }
}

pub(crate) fn close_agent_tab(
    hub: &Arc<RemoteHub>,
    sources: &SourceRegistry,
    glue: &share_commands::ShareGlue,
    registry: &impl AgentCloser,
    id: &str,
) {
    // The lookup is its own statement so its lock is released before
    // tab_runtime_died takes the same one (the term_kill discipline).
    let tab_id = glue.session_tabs.lock().unwrap().get(id).cloned();
    if let Some(tab_id) = tab_id {
        share_commands::tab_runtime_died(hub, sources, glue, &tab_id);
    }
    registry.close_agent(id);
}
