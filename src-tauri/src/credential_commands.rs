//! Tauri adapter for credential authorization and password portability.

use tauri::AppHandle;
#[cfg(target_os = "windows")]
use tauri::Manager;

#[cfg(target_os = "macos")]
use crate::user_presence;
#[cfg(target_os = "windows")]
use crate::user_presence_win;
use crate::{credentials, pw_portable};

#[tauri::command]
pub(crate) async fn pw_authorize_view(app: AppHandle) -> Result<(), String> {
    authorize(&app, "show your saved passwords").await
}

/// Ask the owner to confirm, on whatever this system uses to ask.
///
/// On a worker thread on purpose: the system draws its prompt on the one
/// that draws the window, and waiting for the answer from there would be
/// waiting for something that cannot appear.
#[allow(unused_variables, clippy::needless_return)]
async fn authorize(app: &AppHandle, reason: &'static str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || user_presence::ask(reason))
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let handle = app
            .get_window("main")
            .and_then(|w| w.hwnd().ok())
            .ok_or_else(|| "no window to ask over".to_string())?;
        let as_number = handle.0 as isize;
        return tauri::async_runtime::spawn_blocking(move || {
            user_presence_win::ask(as_number, reason)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Ok(())
}

/// One saved password, in the clear, for a window that has been authorized.
#[tauri::command]
pub(crate) fn pw_reveal(host: String, username: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    if !user_presence_win::authorized_recently() {
        return Err("not authorized".into());
    }
    #[cfg(target_os = "macos")]
    if !user_presence::authorized_recently() {
        return Err("not authorized".into());
    }
    let found = credentials::find_web(&host)?;
    found
        .into_iter()
        .find(|c| c.username == username)
        .map(|c| c.password)
        .ok_or_else(|| format!("no saved login for {host}"))
}

#[tauri::command]
pub(crate) async fn pw_authorize_export() -> Result<(), String> {
    // On a worker thread on purpose: the system draws its sheet on the
    // main one, and waiting for the answer from there would wait forever.
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            user_presence::ask("export your saved passwords to a file")
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[tauri::command]
pub(crate) fn pw_forget_all() -> Result<usize, String> {
    credentials::forget_all_web()
}

#[tauri::command]
pub(crate) fn pw_export(path: String) -> Result<usize, String> {
    // The ask and the write are two steps with a file panel between them,
    // so the write checks for itself rather than trusting that the first
    // step happened.
    #[cfg(target_os = "windows")]
    if !user_presence_win::authorized_recently() {
        return Err("not authorized".into());
    }
    #[cfg(target_os = "macos")]
    if !user_presence::authorized_recently() {
        return Err("that export was not authorized, or the authorization expired".into());
    }
    pw_portable::export_csv(std::path::Path::new(&path))
}

#[tauri::command]
pub(crate) fn pw_import(path: String) -> Result<pw_portable::ImportReport, String> {
    pw_portable::import_csv(std::path::Path::new(&path))
}
