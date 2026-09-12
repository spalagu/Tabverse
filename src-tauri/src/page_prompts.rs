use std::collections::HashMap;
use std::sync::Mutex;

use tauri::AppHandle;
#[cfg(target_os = "windows")]
use tauri::Emitter;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogEvent {
    pub dialog_id: u64,
    /// "alert" | "confirm" | "prompt" | "camera" | "microphone" |
    /// "camera and microphone"
    pub kind: &'static str,
    pub origin: String,
    pub message: String,
    pub default_text: String,
}

#[cfg(target_os = "windows")]
pub fn ask(app: &AppHandle, event: DialogEvent) {
    let _ = app.emit("browser-page-dialog", event);
}

const MEDIA_SCOPE: &str = "media-permissions";
static MEDIA_WRITE: Mutex<()> = Mutex::new(());

fn media_map(app: &AppHandle) -> Result<HashMap<String, bool>, String> {
    let store = crate::app_state_store(app)?;
    match store
        .load_scope(MEDIA_SCOPE)
        .map_err(|e| format!("read media permissions from app.db: {e:#}"))?
    {
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| format!("media permissions in app.db are invalid: {e}")),
        None => Ok(HashMap::new()),
    }
}

fn save_media_map(app: &AppHandle, map: &HashMap<String, bool>) -> Result<(), String> {
    let json =
        serde_json::to_string(map).map_err(|e| format!("serialize media permissions: {e}"))?;
    crate::app_state_store(app)?
        .save_scope(MEDIA_SCOPE, &json)
        .map_err(|e| format!("write media permissions to app.db: {e:#}"))
}

/// What this site was allowed or refused before, if anyone has said.
pub fn remembered(app: &AppHandle, host: &str, kind: &str) -> Option<bool> {
    if host.is_empty() {
        return None;
    }
    match media_map(app) {
        Ok(map) => map.get(&format!("{host}|{kind}")).copied(),
        Err(error) => {
            eprintln!("[prompts] {error}");
            None
        }
    }
}

/// Remember it, so the same site does not ask twice.
pub fn remember(app: &AppHandle, host: &str, kind: &str, allow: bool) -> Result<(), String> {
    if host.is_empty() {
        return Ok(());
    }
    let _write = MEDIA_WRITE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut map = media_map(app)?;
    map.insert(format!("{host}|{kind}"), allow);
    save_media_map(app, &map)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaGrant {
    pub host: String,
    pub kind: String,
    pub allow: bool,
}

/// Every media permission this app remembers, host-then-kind sorted — the
/// enumeration half of the trusted-certificate pair of commands this list
/// is modelled on. An empty map is an empty list, not an error: a fresh
/// install has answered nothing yet.
#[tauri::command]
pub fn media_list(app: AppHandle) -> Result<Vec<MediaGrant>, String> {
    let mut list: Vec<MediaGrant> = media_map(&app)?
        .into_iter()
        .filter_map(|(key, allow)| {
            // Entries are written by `remember` as "host|kind"; anything
            // that does not split on that seam is a corrupt line, and
            // skipping it beats rendering a hostless row.
            let (host, kind) = key.split_once('|')?;
            Some(MediaGrant {
                host: host.to_string(),
                kind: kind.to_string(),
                allow,
            })
        })
        .collect();
    list.sort_by(|a, b| (&a.host, &a.kind).cmp(&(&b.host, &b.kind)));
    Ok(list)
}

#[tauri::command]
pub fn media_revoke(app: AppHandle, host: String, kind: String) -> Result<(), String> {
    if host.is_empty() {
        return Err("no host".into());
    }
    let _write = MEDIA_WRITE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut map = media_map(&app)?;
    map.remove(&format!("{host}|{kind}"));
    save_media_map(&app, &map)?;
    eprintln!("[prompts] revoked the remembered {kind} answer for {host}");
    Ok(())
}

/// The host a page belongs to, for a question that can name it.
#[cfg(target_os = "windows")]
pub fn origin_of(url: &str) -> String {
    url.parse::<tauri::Url>()
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default()
}
