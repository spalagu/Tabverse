use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::AppHandle;
use base64::Engine as _;
use tauri::Emitter;

/// Disk cache bound: enough for every host anyone actually revisits,
/// small enough that the state dir never grows without limit.
const CACHE_FILES_LIMIT: usize = 300;
/// An icon bigger than this is not an icon; stop reading rather than
/// letting a hostile or misconfigured server feed us a movie.
const FETCH_BYTES_LIMIT: usize = 256 * 1024;
const DATA_URL_LIMIT: usize = 256 * 1024;

/// host -> current data URL, for hosts already resolved this run.
fn mem() -> &'static Mutex<HashMap<String, String>> {
    static MEM: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    MEM.get_or_init(|| Mutex::new(HashMap::new()))
}

fn resolved() -> &'static Mutex<HashMap<String, String>> {
    static RESOLVED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    RESOLVED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tab_live() -> &'static Mutex<HashMap<String, String>> {
    static TAB_LIVE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    TAB_LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn attempted() -> &'static Mutex<HashSet<String>> {
    static BUSY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    BUSY.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_image_data_url(url: &str) -> bool {
    url.len() >= 11
        && url.len() <= DATA_URL_LIMIT
        && url.as_bytes()[..11].eq_ignore_ascii_case(b"data:image/")
}

fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::state_dir(app).ok().map(|d| d.join("favicons"))
}

/// The host names a file; it arrives from a page script, so the name is
/// rebuilt from a whitelist rather than trusted — no separators, nothing
/// the filesystem could read as traversal.
fn cache_file(dir: &Path, host: &str) -> PathBuf {
    let safe: String = host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    dir.join(format!("{safe}.dataurl"))
}

fn disk_get(app: &AppHandle, host: &str) -> Option<String> {
    let dir = cache_dir(app)?;
    let text = std::fs::read_to_string(cache_file(&dir, host)).ok()?;
    // A file that is not a data URL is not ours; serving it to an <img>
    // would be serving an arbitrary string into the UI.
    text.starts_with("data:image/").then_some(text)
}

fn disk_put(app: &AppHandle, host: &str, data_url: &str) {
    let Some(dir) = cache_dir(app) else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(cache_file(&dir, host), data_url);
    evict_oldest(&dir);
}

/// Oldest out first, by modification time: the bound is on how many hosts
/// are remembered, and the ones touched recently are the ones still wanted.
fn evict_oldest(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = read
        .filter_map(|e| {
            let e = e.ok()?;
            let md = e.metadata().ok()?;
            if !md.is_file() {
                return None;
            }
            Some((
                md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                e.path(),
            ))
        })
        .collect();
    if files.len() <= CACHE_FILES_LIMIT {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    for (_, path) in files.iter().take(files.len() - CACHE_FILES_LIMIT) {
        let _ = std::fs::remove_file(path);
    }
}

fn emit(app: &AppHandle, tab_id: &str, host: &str, data_url: &str) {
    let _ = app.emit(
        "browser-favicon",
        serde_json::json!({ "tabId": tab_id, "host": host, "dataUrl": data_url }),
    );
}

/// What the sidebar asks at startup: whatever the cache already holds for
/// this host, without triggering any fetch.
#[tauri::command]
pub async fn favicon_lookup(app: AppHandle, host: String) -> Result<Option<String>, String> {
    // Blocking pool for the disk read, like every other state_* command.
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(hit) = mem().lock().unwrap().get(&host).cloned() {
            return Some(hit);
        }
        let hit = disk_get(&app, &host)?;
        mem().lock().unwrap().insert(host, hit.clone());
        Some(hit)
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn report(app: &AppHandle, tab_id: &str, host: &str, icon_url: &str) {
    if host.is_empty() || icon_url.is_empty() {
        return;
    }
    // The same icon URL as last resolved for this host is the common no-change
    // case (a page re-reports on every load): re-emit the cached image and stop.
    if resolved().lock().unwrap().get(host).map(String::as_str) == Some(icon_url) {
        if let Some(hit) = mem().lock().unwrap().get(host).cloned() {
            emit(app, tab_id, host, &hit);
        }
        return;
    }
    if is_image_data_url(icon_url) {
        let changed = {
            let mut live = tab_live().lock().unwrap();
            let same = live.get(tab_id).map(String::as_str) == Some(icon_url);
            live.insert(tab_id.to_string(), icon_url.to_string());
            !same
        };
        if changed {
            emit(app, tab_id, host, icon_url);
        }
        return;
    }
    // http(s): fetch once per distinct URL this run. A URL already attempted is
    // in flight, failed, or the current one (re-emitted above), so nothing to do.
    {
        let mut busy = attempted().lock().unwrap();
        if busy.contains(icon_url) {
            return;
        }
        busy.insert(icon_url.to_string());
    }
    let app = app.clone();
    let tab_id = tab_id.to_string();
    let host = host.to_string();
    let icon_url = icon_url.to_string();
    tauri::async_runtime::spawn(async move {
        let disk_app = app.clone();
        let disk_host = host.clone();
        let cached = tauri::async_runtime::spawn_blocking(move || disk_get(&disk_app, &disk_host))
            .await
            .ok()
            .flatten();
        // The disk cache is keyed by host, so it only answers for a host's
        // first (load-time) icon — a runtime change never matches it and falls
        // through to a fetch. Serving it means this URL is now the resolved one.
        if resolved().lock().unwrap().get(&host).is_none() {
            if let Some(hit) = cached {
                resolved()
                    .lock()
                    .unwrap()
                    .insert(host.clone(), icon_url.clone());
                mem().lock().unwrap().insert(host.clone(), hit.clone());
                emit(&app, &tab_id, &host, &hit);
                return;
            }
        }
        match fetch(&icon_url).await {
            Some(data_url) => {
                eprintln!("[favicon] fetched icon for host={host}");
                resolved()
                    .lock()
                    .unwrap()
                    .insert(host.clone(), icon_url.clone());
                mem().lock().unwrap().insert(host.clone(), data_url.clone());
                let put_app = app.clone();
                let put_host = host.clone();
                let put_val = data_url.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    disk_put(&put_app, &put_host, &put_val)
                })
                .await;
                emit(&app, &tab_id, &host, &data_url);
            }
            None => {
                eprintln!("[favicon] no icon for host={host}");
            }
        }
    });
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            crate::http::build(crate::http::Spec {
                // The pages themselves browse under this UA; their icons
                // should not arrive from a different-looking visitor.
                user_agent: Some(crate::BROWSER_UA),
                // The deadline is the factory's: an icon is a small file from
                // a server that either has it or does not, which is the case
                // that default describes.
                ..crate::http::Spec::default()
            })
            .ok()
        })
        .as_ref()
}

async fn fetch(icon_url: &str) -> Option<String> {
    let url: reqwest::Url = icon_url.parse().ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let resp = client()?.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    if let Some(len) = resp.content_length() {
        if len as usize > FETCH_BYTES_LIMIT {
            return None;
        }
    }
    let header_mime = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    // Read capped, not trusted: a chunked response has no content length.
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if buf.len() > FETCH_BYTES_LIMIT {
                    return None;
                }
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    if buf.is_empty() {
        return None;
    }
    // Servers routinely mislabel icons; the bytes outrank the header, and
    // bytes that are recognizably no image are dropped rather than handed
    // to an <img> on faith.
    let mime = match sniff_mime(&buf) {
        Some(m) => m.to_string(),
        None if header_mime.starts_with("image/") => header_mime,
        None => return None,
    };
    Some(format!("data:{mime};base64,{}", crate::b64().encode(&buf)))
}

fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        Some("image/x-icon")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()) {
        Some("image/webp")
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
        let trimmed = head.trim_start();
        if trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && head.contains("<svg")) {
            Some("image/svg+xml")
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_image_urls_are_served_verbatim() {
        assert!(is_image_data_url("data:image/png;base64,iVBORw0KGgo="));
        assert!(is_image_data_url(
            "data:image/svg+xml,%3Csvg%20xmlns%3D%22...%22%3E"
        ));
        // Case in the scheme/type must not matter — pages spell it every way.
        assert!(is_image_data_url("DATA:IMAGE/x-icon;base64,AAAB"));
    }

    #[test]
    fn non_image_or_oversize_data_urls_are_rejected() {
        // Not an image data URL: an http URL, a non-image data URL, empty.
        assert!(!is_image_data_url("https://x.example/favicon.ico"));
        assert!(!is_image_data_url("data:text/html,<b>no</b>"));
        assert!(!is_image_data_url(""));
        assert!(!is_image_data_url("data:"));
        // Over the ceiling: a "favicon" the size of a movie is not one.
        let huge = format!("data:image/png;base64,{}", "A".repeat(DATA_URL_LIMIT));
        assert!(!is_image_data_url(&huge));
    }
}
