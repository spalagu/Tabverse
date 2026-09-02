use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::AppHandle;
use tauri::{Emitter, Manager};

const KIND: &str = "notifications";

/// The verdict a page's `Notification.permission` should read, from what the
/// site was allowed before. Pure so the mapping is unit-testable without an
/// app, a disk or a webview.
pub fn permission_for(remembered: Option<bool>) -> &'static str {
    match remembered {
        Some(true) => "granted",
        Some(false) => "denied",
        None => "default",
    }
}

/// A permission ask waiting on the user, and where its answer must return.
struct PendingAsk {
    tab_id: String,
    host: String,
    page_ask_id: u64,
}

fn pending() -> &'static Mutex<HashMap<u64, PendingAsk>> {
    static P: OnceLock<Mutex<HashMap<u64, PendingAsk>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_dialog_id() -> u64 {
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// Tabs that have been granted notifications during this run. A `notify-show`
/// is honored only for a tab in this set.
fn granted_tabs() -> &'static Mutex<HashSet<String>> {
    static G: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashSet::new()))
}

fn tab_webview(app: &AppHandle, tab_id: &str) -> Option<crate::Webview> {
    let label = app
        .state::<crate::AppState>()
        .browsers
        .lock()
        .unwrap()
        .get(tab_id)
        .cloned()?;
    app.get_window("main")?.get_webview(&label)
}

/// Resolve the page's `requestPermission()` promise with the verdict. Evaled
/// as a token-free window event: the polyfill listens for it and needs no
/// secret to hear its own answer back.
fn reply(app: &AppHandle, tab_id: &str, page_ask_id: u64, perm: &str) {
    let Some(wv) = tab_webview(app, tab_id) else {
        return;
    };
    // serde_json quotes the string, so nothing about `perm` can escape it.
    let perm_lit = serde_json::to_string(perm).unwrap_or_else(|_| "\"default\"".into());
    let js = format!(
        "window.dispatchEvent(new CustomEvent('__tabverse_notify_perm',\
         {{detail:{{id:{page_ask_id},perm:{perm_lit}}}}}))"
    );
    let _ = wv.eval(&js);
}

pub fn request_permission(app: &AppHandle, tab_id: &str, host: &str, page_ask_id: u64) {
    if let Some(allow) = crate::page_prompts::remembered(app, host, KIND) {
        if allow {
            granted_tabs().lock().unwrap().insert(tab_id.to_string());
        }
        reply(app, tab_id, page_ask_id, permission_for(Some(allow)));
        return;
    }
    let dialog_id = next_dialog_id();
    pending().lock().unwrap().insert(
        dialog_id,
        PendingAsk {
            tab_id: tab_id.to_string(),
            host: host.to_string(),
            page_ask_id,
        },
    );
    let event = crate::page_prompts::DialogEvent {
        dialog_id,
        kind: KIND,
        origin: host.to_string(),
        message: String::new(),
        default_text: String::new(),
    };
    eprintln!("[notify] permission ask from {host}");
    let _ = app.emit("browser-dialog", event);
}

/// The user's answer to a notification permission ask. Routed here from the
/// shared dialog-answer command when the kind is "notifications".
pub fn answer(app: &AppHandle, dialog_id: u64, ok: bool, remember: bool) -> Result<(), String> {
    let Some(p) = pending().lock().unwrap().remove(&dialog_id) else {
        eprintln!("[notify] answer for unknown ask {dialog_id}, dropped");
        return Ok(());
    };
    if remember {
        crate::page_prompts::remember(app, &p.host, KIND, ok);
    }
    if ok {
        granted_tabs().lock().unwrap().insert(p.tab_id.clone());
    }
    reply(app, &p.tab_id, p.page_ask_id, permission_for(Some(ok)));
    Ok(())
}

/// A page constructed a notification. Honored only for a tab that holds a
/// grant this run; the title and body become an OS notification and never a
/// log line.
pub fn show(app: &AppHandle, tab_id: &str, payload_json: &str) {
    if !granted_tabs().lock().unwrap().contains(tab_id) {
        eprintln!("[notify] show from a tab without a grant, dropped");
        return;
    }
    let v: serde_json::Value = serde_json::from_str(payload_json).unwrap_or_default();
    let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("");
    let body = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
    // The fact, not the content: the matrix asserts a notification reached the
    // app, and nothing here reveals what it said.
    eprintln!("[notify] showed a page notification");
    let _ = app.emit(
        "browser-notify-shown",
        serde_json::json!({ "tabId": tab_id }),
    );
}

pub fn forget_tab(tab_id: &str) {
    granted_tabs().lock().unwrap().remove(tab_id);
    pending().lock().unwrap().retain(|_, p| p.tab_id != tab_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_maps_from_memory() {
        // Never asked: the page reads "default" and its script will ask.
        assert_eq!(permission_for(None), "default");
        // Answered once, remembered: the verdict is fixed and never re-asked.
        assert_eq!(permission_for(Some(true)), "granted");
        assert_eq!(permission_for(Some(false)), "denied");
    }
}
