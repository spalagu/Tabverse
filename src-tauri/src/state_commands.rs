//! Desktop application-state adapter.
//!
//! Workbench sees scoped JSON and registered setting commands. SQLite paths,
//! blocking work and the concrete `AppStateStore` stay on this side.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

pub(crate) struct AppDatabase(pub(crate) Arc<tabverse_state::AppStateStore>);

pub(crate) fn state_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("state"))
        .map_err(|e| format!("cannot resolve app data dir: {e}"))
}

pub(crate) fn app_state_store(app: &AppHandle) -> Result<tabverse_state::AppStateStore, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    tabverse_state::AppStateStore::open(&app_data_dir).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn config_get(
    db: State<'_, AppDatabase>,
) -> Result<crate::config::ConfigSnapshot, String> {
    let store = db.0.clone();
    tauri::async_runtime::spawn_blocking(move || crate::config::snapshot_with_store(&store))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn config_set(
    db: State<'_, AppDatabase>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let store = db.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::config::set_with_store(&store, &key, &value)?;
        crate::config::project_network_setting(&key, Some(&value))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn config_reset(db: State<'_, AppDatabase>, key: String) -> Result<(), String> {
    let store = db.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::config::reset_with_store(&store, &key)?;
        crate::config::project_network_setting(&key, None)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn state_save(app: AppHandle, scope: String, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app_state_store(&app)?
            .save_scope(&scope, &json)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn state_load(app: AppHandle, scope: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app_state_store(&app)?
            .load_scope(&scope)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn state_delete(app: AppHandle, scope: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app_state_store(&app)?
            .delete_scope(&scope)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn state_list(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app_state_store(&app)?
            .list_scopes()
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
