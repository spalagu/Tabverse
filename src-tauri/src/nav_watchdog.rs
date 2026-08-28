use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// How long to give a load before deciding it never began. Comfortably
/// past the delegate's own latency, well under a person's patience.
const FIRST_WAIT: Duration = Duration::from_millis(1200);
const SECOND_WAIT: Duration = Duration::from_millis(1800);

/// What each tab is waiting to see start, and which attempt this is.
static PENDING: Mutex<Option<HashMap<String, (String, u32)>>> = Mutex::new(None);

fn pending() -> std::sync::MutexGuard<'static, Option<HashMap<String, (String, u32)>>> {
    PENDING.lock().unwrap()
}

/// A load began. Whatever this tab was waiting for, it is no longer owed.
pub fn load_started(tab_id: &str) {
    if let Some(map) = pending().as_mut() {
        map.remove(tab_id);
    }
}

pub fn is_pending(tab_id: &str) -> bool {
    pending().as_ref().is_some_and(|m| m.contains_key(tab_id))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NavErrorEvent {
    tab_id: String,
    kind: &'static str,
    host: String,
    url: String,
    message: String,
}

/// Note that a load was asked for, and check later that it happened.
pub fn watch(app: &AppHandle, tab_id: &str, url: &str) {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    let _ = APP.set(app.clone());
    let attempt = {
        let mut guard = pending();
        let map = guard.get_or_insert_with(HashMap::new);
        let attempt = match map.get(tab_id) {
            // A second request for the same address is this watchdog's own
            // retry; anything else starts the count over.
            Some((u, n)) if u == url => *n,
            _ => 0,
        };
        map.insert(tab_id.to_string(), (url.to_string(), attempt));
        attempt
    };

    let app = app.clone();
    let tab_id = tab_id.to_string();
    let url = url.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(if attempt == 0 {
            FIRST_WAIT
        } else {
            SECOND_WAIT
        });
        // Started in the meantime: nothing to do, and this is the ordinary
        // case by far.
        let still_owed = pending()
            .as_ref()
            .and_then(|m| m.get(&tab_id).cloned())
            .map(|(u, n)| u == url && n == attempt)
            .unwrap_or(false);
        if !still_owed {
            return;
        }
        if attempt == 0 {
            eprintln!("[nav] no load began for {url}, asking again");
            if let Some(map) = pending().as_mut() {
                map.insert(tab_id.clone(), (url.clone(), 1));
            }
            reissue(&app, &tab_id, &url);
            return;
        }
        // Twice asked, twice ignored. Say so where the tab can show it.
        eprintln!("[nav] {url} never began loading after two attempts");
        if let Some(map) = pending().as_mut() {
            map.remove(&tab_id);
        }
        let host = url
            .parse::<tauri::Url>()
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default();
        let _ = app.emit(
            "browser-nav-error",
            NavErrorEvent {
                tab_id: tab_id.clone(),
                kind: "failure",
                host,
                url: url.clone(),
                message:
                    "The browser engine accepted this address and then never started loading it. \
                     Nothing was sent. Try again, or open it in your system browser."
                        .to_string(),
            },
        );
    });
}

/// Ask again, through the same path the first request took.
fn reissue(app: &AppHandle, tab_id: &str, url: &str) {
    crate::peek::command_stamp(tab_id);
    let Some(label) = crate::browser_label(app, tab_id) else {
        return;
    };
    let Some(window) = app.get_window("main") else {
        return;
    };
    let Some(wv) = window.get_webview(&label) else {
        return;
    };
    let Ok(parsed) = url.parse::<tauri::Url>() else {
        return;
    };
    let _ = wv.navigate(parsed);
}
