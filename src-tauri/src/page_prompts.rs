use std::collections::HashMap;

use crate::AppHandle;
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

const MEDIA_FILE: &str = "media-permissions.json";

fn media_map(app: &AppHandle) -> HashMap<String, bool> {
    let Ok(dir) = crate::state_dir(app) else {
        return HashMap::new();
    };
    std::fs::read(dir.join(MEDIA_FILE))
        .ok()
        .and_then(|d| serde_json::from_slice(&d).ok())
        .unwrap_or_default()
}

/// What this site was allowed or refused before, if anyone has said.
pub fn remembered(app: &AppHandle, host: &str, kind: &str) -> Option<bool> {
    if host.is_empty() {
        return None;
    }
    media_map(app).get(&format!("{host}|{kind}")).copied()
}

/// Remember it, so the same site does not ask twice.
pub fn remember(app: &AppHandle, host: &str, kind: &str, allow: bool) {
    if host.is_empty() {
        return;
    }
    let mut map = media_map(app);
    map.insert(format!("{host}|{kind}"), allow);
    if let Ok(dir) = crate::state_dir(app) {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_vec(&map) {
            let _ = std::fs::write(dir.join(MEDIA_FILE), json);
        }
    }
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
    let mut list: Vec<MediaGrant> = media_map(&app)
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
    let mut map = media_map(&app);
    map.remove(&format!("{host}|{kind}"));
    if let Ok(dir) = crate::state_dir(&app) {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_vec(&map) {
            let _ = std::fs::write(dir.join(MEDIA_FILE), json);
        }
    }
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
