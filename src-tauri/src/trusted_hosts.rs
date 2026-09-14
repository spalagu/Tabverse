use std::collections::HashSet;
use std::sync::Mutex;

use tauri::AppHandle;

const SCOPE: &str = "trusted-certificate-hosts";

/// Cached copy, because the certificate challenge is answered on a hot
/// path (every request to the host) and must not read the disk each time.
static CACHE: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static WRITE: Mutex<()> = Mutex::new(());

fn load(app: &AppHandle) -> Result<HashSet<String>, String> {
    if let Some(c) = CACHE.lock().unwrap().clone() {
        return Ok(c);
    }
    let store = crate::app_state_store(app)?;
    let set = match store
        .load_scope(SCOPE)
        .map_err(|e| format!("read trusted hosts from app.db: {e:#}"))?
    {
        Some(json) => serde_json::from_str::<Vec<String>>(&json)
            .map_err(|e| format!("trusted hosts in app.db are invalid: {e}"))?
            .into_iter()
            .collect(),
        None => HashSet::new(),
    };
    *CACHE.lock().unwrap() = Some(set.clone());
    Ok(set)
}

fn store(app: &AppHandle, set: &HashSet<String>) -> Result<(), String> {
    let mut list: Vec<&String> = set.iter().collect();
    list.sort();
    let json = serde_json::to_string(&list).map_err(|e| format!("serialize trusted hosts: {e}"))?;
    crate::app_state_store(app)?
        .save_scope(SCOPE, &json)
        .map_err(|e| format!("write trusted hosts to app.db: {e:#}"))?;
    *CACHE.lock().unwrap() = Some(set.clone());
    Ok(())
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn is_trusted(app: &AppHandle, host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    match load(app) {
        Ok(set) => set.contains(host),
        Err(error) => {
            eprintln!("[trust] {error}");
            false
        }
    }
}

/// Record the user's decision to proceed. Called only from the command a
/// click on "continue" raises.
#[tauri::command]
pub fn trust_certificate_host(app: AppHandle, host: String) -> Result<(), String> {
    if host.is_empty() {
        return Err("no host".into());
    }
    let _write = WRITE.lock().unwrap_or_else(|error| error.into_inner());
    let mut set = load(&app)?;
    set.insert(host.clone());
    store(&app, &set)?;
    eprintln!("[trust] user accepted the certificate for {host}");
    Ok(())
}

#[tauri::command]
pub fn list_trusted_hosts(app: AppHandle) -> Result<Vec<String>, String> {
    let mut list: Vec<String> = load(&app)?.into_iter().collect();
    list.sort();
    Ok(list)
}

#[tauri::command]
pub fn revoke_trusted_host(app: AppHandle, host: String) -> Result<(), String> {
    let _write = WRITE.lock().unwrap_or_else(|error| error.into_inner());
    let mut set = load(&app)?;
    set.remove(&host);
    store(&app, &set)?;
    eprintln!("[trust] user revoked the certificate exception for {host}");
    Ok(())
}
