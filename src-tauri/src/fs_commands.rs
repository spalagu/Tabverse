//! Tauri adapter for the Files feature.
//!
//! Domain operations stay in `tabverse-fs`; this module only translates IPC
//! arguments, selects the blocking pool and connects directory watches to the
//! application handle.

use tabverse_fs::{FileMeta, Inspection, Listing};
use tauri::{AppHandle, State};

use crate::AppState;

#[tauri::command]
pub(crate) async fn fs_list(state: State<'_, AppState>, dir: String) -> Result<Listing, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.list_dir(&dir).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_read(state: State<'_, AppState>, path: String) -> Result<FileMeta, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.read_file(&path).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_write(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs.write_text(&path, &content).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_transfer(
    state: State<'_, AppState>,
    from: String,
    into_dir: String,
    cut: bool,
    overwrite: Option<bool>,
) -> Result<String, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if cut {
            fs.move_into(&from, &into_dir, overwrite.unwrap_or(false))
        } else {
            fs.copy_into(&from, &into_dir, overwrite.unwrap_or(false))
        }
        .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn walk_rules() -> tabverse_fs::WalkRules {
    match crate::config::load() {
        Ok(loaded) => tabverse_fs::WalkRules {
            exclude: loaded.config.files.exclude,
            respect_gitignore: loaded.config.files.respect_gitignore,
        },
        Err(_) => tabverse_fs::WalkRules::default(),
    }
}

#[tauri::command]
pub(crate) async fn fs_grep(
    root: String,
    query: String,
    options: tabverse_fs::search::GrepOptions,
    max_hits: usize,
) -> Result<tabverse_fs::search::GrepResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rules = walk_rules();
        tabverse_fs::search::grep(&root, &query, options, max_hits, &rules)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_replace(
    root: String,
    query: String,
    replacement: String,
    options: tabverse_fs::search::GrepOptions,
    only: Option<Vec<String>>,
    plan: Option<tabverse_fs::search::ReplacePlan>,
) -> Result<tabverse_fs::search::ReplaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rules = walk_rules();
        tabverse_fs::search::replace_all(&root, &query, &replacement, options, only, plan, &rules)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_replace_preview(
    root: String,
    query: String,
    replacement: String,
    options: tabverse_fs::search::GrepOptions,
    only: Option<Vec<String>>,
) -> Result<tabverse_fs::search::ReplacePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rules = walk_rules();
        tabverse_fs::search::replace_preview(&root, &query, &replacement, options, only, &rules)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_changes(
    state: State<'_, AppState>,
    root: String,
) -> Result<tabverse_fs::ChangeList, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.changes(&root))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn fs_walk(
    dir: String,
    include_hidden: bool,
    name: Option<String>,
) -> Result<tabverse_fs::WalkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rules = walk_rules();
        tabverse_fs::walk(&dir, 5000, include_hidden, name.as_deref(), &rules)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_create(
    state: State<'_, AppState>,
    path: String,
    dir: bool,
) -> Result<(), String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if dir {
            fs.create_dir(&path).map_err(|e| format!("{e:#}"))
        } else {
            fs.create_file(&path).map_err(|e| format!("{e:#}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_rename(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs.rename(&from, &to).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Moves to the system trash — recoverable, never a hard delete.
#[tauri::command]
pub(crate) async fn fs_trash(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.trash(&path).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_inspect(
    state: State<'_, AppState>,
    path: String,
) -> Result<Inspection, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.inspect(&path).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_archive_create(
    state: State<'_, AppState>,
    entries: Vec<String>,
    dest: String,
    format: String,
) -> Result<String, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs.archive_create(&entries, &dest, &format)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_archive_extract(
    state: State<'_, AppState>,
    archive: String,
    dest_dir: String,
) -> Result<tabverse_fs::ExtractOutcome, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs.archive_extract(&archive, &dest_dir)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn fs_reveal(path: String) -> Result<(), String> {
    let path = tabverse_fs::expand_path(&path);
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(&path))
        .spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn fs_read_range(
    state: State<'_, AppState>,
    path: String,
    offset: u64,
    len: u32,
) -> Result<tabverse_fs::ReadRange, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs.read_range(&path, offset, len)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn fs_sqlite_rows(
    state: State<'_, AppState>,
    path: String,
    table: String,
    limit: u32,
    offset: u32,
) -> Result<tabverse_fs::SqliteRows, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs.sqlite_rows(&path, &table, limit, offset)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn fs_watch_start(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    root: String,
) -> Result<(), String> {
    if root.is_empty() {
        state.watches.stop(&tab_id);
        return Ok(());
    }
    let rules = walk_rules();
    state.watches.start(&app, &tab_id, &root, &rules)
}

#[tauri::command]
pub(crate) fn fs_watch_stop(state: State<'_, AppState>, tab_id: String) {
    state.watches.stop(&tab_id);
}
