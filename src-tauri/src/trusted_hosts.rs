use std::collections::HashSet;
use std::sync::Mutex;

use crate::AppHandle;

const FILE_NAME: &str = "trusted-certificate-hosts.json";

/// Cached copy, because the certificate challenge is answered on a hot
/// path (every request to the host) and must not read the disk each time.
static CACHE: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::state_dir(app).ok().map(|d| d.join(FILE_NAME))
}

fn load(app: &AppHandle) -> HashSet<String> {
    if let Some(c) = CACHE.lock().unwrap().clone() {
        return c;
    }
    let set: HashSet<String> = path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|d| serde_json::from_slice::<Vec<String>>(&d).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default();
    *CACHE.lock().unwrap() = Some(set.clone());
    set
}

fn store(app: &AppHandle, set: &HashSet<String>) {
    *CACHE.lock().unwrap() = Some(set.clone());
    let Some(p) = path(app) else { return };
    let mut list: Vec<&String> = set.iter().collect();
    list.sort();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec(&list) {
        let _ = std::fs::write(p, json);
    }
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
#[cfg_attr(feature = "runtime-cef", allow(dead_code))]
pub fn is_trusted(app: &AppHandle, host: &str) -> bool {
    !host.is_empty() && load(app).contains(host)
}

/// Record the user's decision to proceed. Called only from the command a
/// click on "continue" raises.
#[tauri::command]
pub fn trust_certificate_host(app: AppHandle, host: String) -> Result<(), String> {
    if host.is_empty() {
        return Err("no host".into());
    }
    let mut set = load(&app);
    set.insert(host.clone());
    store(&app, &set);
    eprintln!("[trust] user accepted the certificate for {host}");
    Ok(())
}

#[tauri::command]
pub fn list_trusted_hosts(app: AppHandle) -> Result<Vec<String>, String> {
    let mut list: Vec<String> = load(&app).into_iter().collect();
    list.sort();
    Ok(list)
}

#[tauri::command]
pub fn revoke_trusted_host(app: AppHandle, host: String) -> Result<(), String> {
    let mut set = load(&app);
    set.remove(&host);
    store(&app, &set);
    eprintln!("[trust] user revoked the certificate exception for {host}");
    Ok(())
}
