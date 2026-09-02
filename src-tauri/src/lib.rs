mod basic_auth;
#[cfg(target_os = "windows")]
mod basic_auth_win;
mod cookies;
mod default_apps;
#[cfg(target_os = "macos")]
mod dialogs;
#[cfg(target_os = "windows")]
mod dialogs_win;
#[cfg(target_os = "macos")]
mod nav_failures;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod nav_report;
mod nav_watchdog;
#[cfg(target_os = "windows")]
mod nav_windows;
#[cfg(target_os = "macos")]
mod page_channel;
#[cfg(target_os = "windows")]
mod page_channel_win;
mod page_notify;
mod page_prompts;
mod peek;
mod pw_portable;
mod share_commands;
#[cfg(target_os = "macos")]
mod snapshot;
#[cfg(target_os = "windows")]
mod snapshot_win;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod system_open;
mod trusted_hosts;
#[cfg(target_os = "macos")]
mod ui_plane;
#[cfg(target_os = "macos")]
mod user_presence;
#[cfg(target_os = "windows")]
mod user_presence_win;

/// What a page posts to when it has something to tell the app:
/// `window.webkit.messageHandlers.<this>`.
///
/// Defined here rather than in the module that installs the handler,
/// because installing it is platform work while *naming* it is not — the
/// script that posts to it is built into every page on every platform, so
/// a name that only exists on one of them does not compile on the others.
pub const PAGE_CHANNEL: &str = "tabverse";

#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_X: f64 = 16.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_Y: f64 = 22.0;
pub mod app_share;
mod clipboard_watch;
mod completions;
mod config;
mod credentials;
mod favicon;
mod file_clipboard;
mod fs_watch;
mod http;
mod keys;
mod migrate;
pub mod page_proxy;
mod passwords;
mod profiles;
mod remote_proxy;
mod resident;
mod templates;
mod terminal_helper;
mod transfer;
mod userscripts;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod theme_gen {
    include!(concat!(env!("OUT_DIR"), "/theme_generated.rs"));
}

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use tabverse_fs::{FileMeta, FsBackend, Inspection, Listing};
use tabverse_proto::{RemoteHostMsg, TermEvent};
use tabverse_remote::source::terminal::TerminalSource;
use tabverse_remote::{
    join, JoinHandle, LocalSink, RemoteHub, SessionBridge, SourceRegistry, Viewport,
};
use tabverse_term::{
    client::HelperEventCallback,
    protocol::{Frame as HelperFrame, Kind as HelperKind, SessionId as HelperSessionId},
};
#[cfg(target_os = "macos")]
use tauri::menu::SubmenuBuilder;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State, Window};

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[cfg(target_os = "macos")]
fn reapply_traffic_light_position(window: Window, x: f64, y: f64) {
    let for_main = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        use objc2_foundation::NSRect;

        let Ok(window_ptr) = for_main.ns_window() else {
            return;
        };
        let ns_window = window_ptr as *mut AnyObject;
        let close: *mut AnyObject = msg_send![&*ns_window, standardWindowButton: 0isize];
        let miniaturize: *mut AnyObject = msg_send![&*ns_window, standardWindowButton: 1isize];
        let zoom: *mut AnyObject = msg_send![&*ns_window, standardWindowButton: 2isize];
        if close.is_null() || miniaturize.is_null() || zoom.is_null() {
            eprintln!("[window] traffic lights unavailable for delayed reapply");
            return;
        }

        let close_superview: *mut AnyObject = msg_send![&*close, superview];
        let title_bar_container: *mut AnyObject = msg_send![&*close_superview, superview];
        let close_rect: NSRect = msg_send![&*close, frame];
        let mut title_bar_rect: NSRect = msg_send![&*title_bar_container, frame];
        title_bar_rect.size.height = close_rect.size.height + y;
        let window_rect: NSRect = msg_send![&*ns_window, frame];
        title_bar_rect.origin.y = window_rect.size.height - title_bar_rect.size.height;
        let _: () = msg_send![&*title_bar_container, setFrame: title_bar_rect];

        let miniaturize_rect: NSRect = msg_send![&*miniaturize, frame];
        let space_between = miniaturize_rect.origin.x - close_rect.origin.x;
        for (index, button) in [close, miniaturize, zoom].into_iter().enumerate() {
            let mut rect: NSRect = msg_send![&*button, frame];
            rect.origin.x = x + index as f64 * space_between;
            let _: () = msg_send![&*button, setFrameOrigin: rect.origin];
        }
    });
}

#[tauri::command]
fn traffic_light_reapply(window: Window) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    reapply_traffic_light_position(window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

#[tauri::command]
fn toggle_simple_fullscreen(window: Window) -> Result<(), String> {
    let fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
    if fullscreen {
        // `set_simple_fullscreen(false)` is the normal exit path. The fallback
        // also lets the command recover if the user entered native fullscreen
        // through the system green button before using the app menu.
        window
            .set_simple_fullscreen(false)
            .or_else(|_| window.set_fullscreen(false))
            .map_err(|e| e.to_string())
    } else {
        window
            .set_simple_fullscreen(true)
            .map_err(|e| e.to_string())
    }
}

/// The webview end of a session. Ordered dispatch and snapshot sequencing live
/// in `tabverse_remote::SessionBridge` so they stay testable without a GUI.
struct WebviewSink {
    channel: Channel<TermEvent>,
}

impl LocalSink for WebviewSink {
    fn data(&self, bytes: &[u8]) {
        let _ = self.channel.send(TermEvent::Data {
            b64: b64().encode(bytes),
        });
    }
    fn exit(&self, code: Option<i32>) {
        let _ = self.channel.send(TermEvent::Exit { code });
    }
    fn snapshot_request(&self, viewer: u64) {
        let _ = self.channel.send(TermEvent::SnapshotRequest { viewer });
    }
}

struct AppState {
    helper: terminal_helper::TerminalHelper,
    resident: resident::ResidentBridge,
    hub: Arc<RemoteHub>,
    bridges: Arc<Mutex<HashMap<String, Arc<SessionBridge>>>>,
    helper_backlog: Arc<Mutex<HashMap<String, Vec<HelperFrame>>>>,
    helper_generations: Arc<Mutex<HashMap<String, u64>>>,
    /// Shareable tab runtimes by tab id.
    sources: Arc<SourceRegistry>,
    /// Session/source/share indexes owned by the generic share command layer.
    share_glue: Arc<share_commands::ShareGlue>,
    joins: Mutex<HashMap<String, Arc<JoinHandle>>>,
    fs: Arc<FsBackend>,
    /// tab id -> child webview label for browser tabs.
    browsers: Mutex<HashMap<String, String>>,
    downloads: Mutex<HashSet<std::path::PathBuf>>,
    watches: fs_watch::WatchState,
    page_proxy: Mutex<PageProxySlot>,
    /// The whole-app share (v3): one per process, lazily built on the first
    /// `app_share_start`. The source's glue seams (snapshot from the
    /// webview, clipboard, proxy) are wired there, once.
    app_source: Arc<app_share::AppShareSource>,
}

// Filesystem commands run on the blocking pool: a `git status` over a large
// repo, or a slow disk, must never freeze the UI thread that every terminal
// tab paints on. (Sync Tauri commands execute on the main thread.)
#[tauri::command]
async fn fs_list(state: State<'_, AppState>, dir: String) -> Result<Listing, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.list_dir(&dir).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_read(state: State<'_, AppState>, path: String) -> Result<FileMeta, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.read_file(&path).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_write(state: State<'_, AppState>, path: String, content: String) -> Result<(), String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs.write_text(&path, &content).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_transfer(
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
async fn fs_grep(
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
async fn fs_replace(
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
async fn fs_replace_preview(
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
async fn fs_changes(
    state: State<'_, AppState>,
    root: String,
) -> Result<tabverse_fs::ChangeList, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.changes(&root))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_walk(
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
async fn fs_create(state: State<'_, AppState>, path: String, dir: bool) -> Result<(), String> {
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
async fn fs_rename(state: State<'_, AppState>, from: String, to: String) -> Result<(), String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs.rename(&from, &to).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Moves to the system trash — recoverable, never a hard delete.
#[tauri::command]
async fn fs_trash(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.trash(&path).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

/// Metadata inspection (certificates / archives / plists) — read-only, never
/// executes anything, and never returns private key material (tabverse_fs rules).
#[tauri::command]
async fn fs_inspect(state: State<'_, AppState>, path: String) -> Result<Inspection, String> {
    let fs = state.fs.clone();
    tauri::async_runtime::spawn_blocking(move || fs.inspect(&path).map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_archive_create(
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
async fn fs_archive_extract(
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
fn fs_reveal(path: String) -> Result<(), String> {
    let p = tabverse_fs::expand_path(&path);
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(target_os = "windows")]
    let res = std::process::Command::new("explorer")
        .arg(format!("/select,{}", p.display()))
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let res = std::process::Command::new("xdg-open")
        .arg(p.parent().unwrap_or(&p))
        .spawn();
    res.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_open(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let asked = std::path::PathBuf::from(&path);
    let known_now = state.downloads.lock().unwrap().contains(&asked);
    let allowed = known_now || {
        // Not seen this run: consult the persisted ledger, which is how a
        // file downloaded before a restart stays openable. Exact string
        // match against recorded paths — no normalization, no prefixes.
        let dir = state_dir(&app)?;
        let recorded = tauri::async_runtime::spawn_blocking(move || {
            tabverse_fs::state::load(&dir, "downloads").ok().flatten()
        })
        .await
        .map_err(|e| e.to_string())?;
        recorded
            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
            .and_then(|v| v.get("entries").cloned())
            .and_then(|e| e.as_array().cloned())
            .map(|entries| {
                entries
                    .iter()
                    .any(|e| e.get("path").and_then(|p| p.as_str()) == Some(path.as_str()))
            })
            .unwrap_or(false)
    };
    if !allowed {
        return Err("not a recorded download".into());
    }
    if !asked.is_file() {
        return Err("the file is no longer there".into());
    }
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(&asked).spawn();
    #[cfg(target_os = "windows")]
    let res = std::process::Command::new("explorer").arg(&asked).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let res = std::process::Command::new("xdg-open").arg(&asked).spawn();
    res.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_read_range(
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
async fn fs_sqlite_rows(
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
fn fs_watch_start(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    root: String,
) -> Result<(), String> {
    if root.is_empty() {
        // An empty root is the pre-restore state, not a directory to watch.
        state.watches.stop(&tab_id);
        return Ok(());
    }
    let rules = walk_rules();
    state.watches.start(&app, &tab_id, &root, &rules)
}

#[tauri::command]
fn fs_watch_stop(state: State<'_, AppState>, tab_id: String) {
    state.watches.stop(&tab_id);
}

fn state_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("state"))
        .map_err(|e| format!("cannot resolve app data dir: {e}"))
}

// The state_* commands follow the fs_* rule above: disk I/O goes through the
// blocking pool so a slow disk never freezes the UI thread. The storage
// logic itself (atomic write, scope-name encoding, size guard) lives in
// tabverse_fs::state where it is unit-tested against a temp dir.
#[tauri::command]
async fn state_save(app: AppHandle, scope: String, json: String) -> Result<(), String> {
    let dir = state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        tabverse_fs::state::save(&dir, &scope, &json).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn state_load(app: AppHandle, scope: String) -> Result<Option<String>, String> {
    let dir = state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        tabverse_fs::state::load(&dir, &scope).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn state_delete(app: AppHandle, scope: String) -> Result<(), String> {
    let dir = state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        tabverse_fs::state::delete(&dir, &scope).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn state_list(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        tabverse_fs::state::list(&dir).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn state_migrate_session_v2(
    app: AppHandle,
) -> Result<tabverse_fs::session_migration::MigrationReport, String> {
    let dir = state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        tabverse_fs::session_migration::migrate_session_v1_to_v2(&dir).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn state_restore_session_backup(app: AppHandle, sha256: String) -> Result<(), String> {
    let dir = state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        tabverse_fs::session_migration::restore_session_backup(&dir, &sha256)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

const THEME_SCOPE: &str = "theme";

/// The saved theme preference. Anything unreadable — no file, bad JSON, an
/// unknown value — is "system": a first launch and a corrupt file both get
/// the follow-the-OS default rather than an error.
fn theme_preference(app: &AppHandle) -> String {
    match state_dir(app) {
        Ok(dir) => theme_preference_in(&dir),
        Err(_) => "system".to_string(),
    }
}

/// The disk half of [`theme_preference`], split on the state directory so a
/// test can drive it against a sandbox dir without an [`AppHandle`].
fn theme_preference_in(dir: &std::path::Path) -> String {
    let fallback = || "system".to_string();
    let Ok(Some(json)) = tabverse_fs::state::load(dir, THEME_SCOPE) else {
        return fallback();
    };
    serde_json::from_str::<serde_json::Value>(&json)
        .ok()
        .and_then(|v| {
            v.get("preference")
                .and_then(|p| p.as_str())
                .map(String::from)
        })
        .filter(|p| is_theme_preference(p))
        .unwrap_or_else(fallback)
}

fn is_theme_preference(p: &str) -> bool {
    config::ThemePref::from_token(p).is_some()
}

/// Paint the window backdrop: the one funnel to
/// ui_plane::set_window_backdrop, so the color can only come from the
/// generated table (theme token tests pin the call shape).
#[cfg(target_os = "macos")]
fn apply_backdrop(window: &tauri::Window, backdrop: &theme_gen::Backdrop) -> Result<(), String> {
    ui_plane::set_window_backdrop(window, backdrop.r, backdrop.g, backdrop.b)
}

#[tauri::command]
fn set_theme(window: tauri::Window, theme: String) -> Result<(), String> {
    let Some(entry) = theme_gen::theme(&theme) else {
        return Err(format!("unknown theme {theme:?}"));
    };
    #[cfg(target_os = "macos")]
    {
        apply_backdrop(&window, &entry.backdrop)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // No backdrop channel on this platform yet; the CSS side of the
        // switch still applies, so the command succeeds as a no-op.
        let _ = (window, entry);
        Ok(())
    }
}

// The two theme_pref_* commands follow the state_* rule above: disk I/O in
// the blocking pool, atomic write via tabverse_fs::state (temp + rename).
#[tauri::command]
async fn theme_pref_save(app: AppHandle, pref: String) -> Result<(), String> {
    if !is_theme_preference(&pref) {
        return Err(format!("unknown theme preference {pref:?}"));
    }
    let dir = state_dir(&app)?;
    let json = serde_json::json!({ "preference": pref }).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        tabverse_fs::state::save(&dir, THEME_SCOPE, &json).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn theme_pref_load(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(theme_preference(&app)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn js_log(level: String, msg: String) {
    eprintln!("[webview:{level}] {msg}");
}

const HELPER_BACKLOG_MAX_BYTES: usize = 256 * 1024;
const HELPER_BACKLOG_MAX_FRAMES: usize = 1024;

fn push_helper_backlog(
    backlog: &Arc<Mutex<HashMap<String, Vec<HelperFrame>>>>,
    id: String,
    frame: HelperFrame,
) {
    let mut all = backlog.lock().unwrap();
    let frames = all.entry(id).or_default();
    frames.push(frame);
    let mut bytes: usize = frames.iter().map(|item| item.payload.len()).sum();
    while frames.len() > HELPER_BACKLOG_MAX_FRAMES || bytes > HELPER_BACKLOG_MAX_BYTES {
        let remove_at = frames
            .iter()
            .position(|item| item.kind != HelperKind::Exit)
            .unwrap_or(0);
        bytes = bytes.saturating_sub(frames[remove_at].payload.len());
        frames.remove(remove_at);
    }
}

fn deliver_helper_frame(
    bridges: &Arc<Mutex<HashMap<String, Arc<SessionBridge>>>>,
    backlog: &Arc<Mutex<HashMap<String, Vec<HelperFrame>>>>,
    frame: HelperFrame,
) {
    let id = frame.session_id.to_hex();
    let Some(bridge) = bridges.lock().unwrap().get(&id).cloned() else {
        if matches!(
            frame.kind,
            HelperKind::Output | HelperKind::Snapshot | HelperKind::Exit
        ) {
            push_helper_backlog(backlog, id, frame);
        }
        return;
    };
    match frame.kind {
        HelperKind::Output | HelperKind::Snapshot => bridge.dispatch_data(&frame.payload),
        HelperKind::Exit => {
            let code = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                .ok()
                .and_then(|v| v.get("code").and_then(|c| c.as_u64()))
                .map(|c| c as i32);
            bridge.dispatch_exit(code);
        }
        _ => {}
    }
}
fn helper_callback(state: &AppState, app: &AppHandle) -> HelperEventCallback {
    let event_app = app.clone();
    let bridges = Arc::clone(&state.bridges);
    let backlog = Arc::clone(&state.helper_backlog);
    let generations = Arc::clone(&state.helper_generations);
    let hub = Arc::clone(&state.hub);
    let sources = Arc::clone(&state.sources);
    let share_glue = Arc::clone(&state.share_glue);
    let app_source = Arc::clone(&state.app_source);
    Arc::new(move |frame| {
        if frame.kind == HelperKind::Output {
            let active_session = app_source
                .active_tab()
                .and_then(|tab| share_commands::session_for_tab(&share_glue, &tab));
            if active_session.as_deref() == Some(frame.session_id.to_hex().as_str()) {
                app_source.broadcast_term(&frame.payload);
            }
        }
        let is_exit = frame.kind == HelperKind::Exit;
        let session_id = frame.session_id.to_hex();
        deliver_helper_frame(&bridges, &backlog, frame);
        if is_exit {
            let tab_id = share_glue
                .session_tabs
                .lock()
                .unwrap()
                .get(&session_id)
                .cloned();
            if let Some(tab_id) = tab_id {
                share_commands::tab_runtime_died(&hub, &sources, &share_glue, &tab_id);
            }
            bridges.lock().unwrap().remove(&session_id);
            backlog.lock().unwrap().remove(&session_id);
            generations.lock().unwrap().remove(&session_id);
            let _ = event_app.emit("background-tasks-changed", ());
        }
    })
}
fn flush_helper_backlog(
    bridges: &Arc<Mutex<HashMap<String, Arc<SessionBridge>>>>,
    backlog: &Arc<Mutex<HashMap<String, Vec<HelperFrame>>>>,
    id: &str,
) {
    let pending = backlog.lock().unwrap().remove(id).unwrap_or_default();
    for frame in pending {
        deliver_helper_frame(bridges, backlog, frame);
    }
}
fn install_helper_bridge(state: &AppState, id: &str, bridge: Arc<SessionBridge>) {
    state.bridges.lock().unwrap().insert(id.to_string(), bridge);
    flush_helper_backlog(&state.bridges, &state.helper_backlog, id);
}
fn helper_session(
    state: &AppState,
    id: &str,
) -> Result<
    (
        Arc<tabverse_term::client::HelperClient>,
        HelperSessionId,
        u64,
    ),
    String,
> {
    let session = HelperSessionId::from_hex(id).map_err(|e| e.to_string())?;
    let generation = state
        .helper_generations
        .lock()
        .unwrap()
        .get(id)
        .copied()
        .ok_or_else(|| format!("unknown helper session {id}"))?;
    let client = state
        .helper
        .session(id)
        .ok_or_else(|| "terminal helper is not connected".to_string())?;
    Ok((client, session, generation))
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn term_create(
    app: AppHandle,
    state: State<'_, AppState>,
    on_event: Channel<TermEvent>,
    tab_id: Option<String>,
    owner_key: Option<String>,
    resident_runtime_id: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    profile: Option<String>,
    run_on_start: Option<String>,
) -> Result<String, String> {
    eprintln!("[core] term_create cols={cols} rows={rows} cwd={cwd:?} tab={tab_id:?} profile={profile:?} run_on_start={run_on_start:?}");
    let opts = profiles::resolve(&profiles::TermRequest {
        cols,
        rows,
        cwd,
        profile,
        run_on_start,
    })?;
    let request = serde_json::json!({"shell":opts.shell,"cwd":opts.cwd,"cols":opts.cols,"rows":opts.rows,"env":opts.env,"shell_integration":opts.shell_integration,"run_on_start":opts.run_on_start,"owner_key":owner_key});
    let client = match resident_runtime_id.as_deref() {
        Some(runtime_id) => {
            state
                .helper
                .ensure_resident(&app, runtime_id, helper_callback(&state, &app))?
        }
        None => state.helper.ensure(&app, helper_callback(&state, &app))?,
    };
    let spawned = client
        .request(
            &HelperFrame::new(
                HelperKind::Spawn,
                HelperSessionId::default(),
                0,
                serde_json::to_vec(&request).map_err(|e| e.to_string())?,
            ),
            HelperKind::Spawn,
            None,
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| e.to_string())?;
    let id = spawned.session_id.to_hex();
    state.helper.register_session(&id, client.clone());
    state
        .helper_generations
        .lock()
        .unwrap()
        .insert(id.clone(), spawned.generation);
    let bridge = SessionBridge::new(Arc::new(WebviewSink { channel: on_event }));
    install_helper_bridge(&state, &id, bridge.clone());
    if let Some(tab_id) = tab_id {
        let input_client = client.clone();
        let input_session = spawned.session_id;
        let input_generation = spawned.generation;
        let viewport_app = app.clone();
        let viewport_session = id.clone();
        let source = Arc::new(TerminalSource::new(
            bridge,
            Arc::new(move |bytes| {
                let _ = input_client.send(&HelperFrame::new(
                    HelperKind::Input,
                    input_session,
                    input_generation,
                    bytes.to_vec(),
                ));
            }),
            Arc::new(move |vp: Option<Viewport>| {
                let _ = viewport_app.emit(
                    "share-viewport",
                    share_commands::ViewportEvent {
                        session_id: viewport_session.clone(),
                        cols: vp.map(|v| v.cols),
                        rows: vp.map(|v| v.rows),
                    },
                );
            }),
            Viewport { cols, rows },
        ));
        state
            .share_glue
            .session_tabs
            .lock()
            .unwrap()
            .insert(id.clone(), tab_id.clone());
        state
            .share_glue
            .terminal_sources
            .lock()
            .unwrap()
            .insert(id.clone(), source.clone());
        state.sources.register(&tab_id, source);
    }

    Ok(id)
}
#[tauri::command]
async fn term_write(
    state: State<'_, AppState>,
    id: String,
    data_b64: String,
) -> Result<(), String> {
    let bytes = b64().decode(data_b64).map_err(|e| e.to_string())?;
    let (client, session, generation) = helper_session(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        client
            .send(&HelperFrame::new(
                HelperKind::Input,
                session,
                generation,
                bytes,
            ))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn term_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let (client, session, generation) = helper_session(&state, &id)?;
    client
        .send(&HelperFrame::new(
            HelperKind::Resize,
            session,
            generation,
            serde_json::to_vec(&serde_json::json!({"cols":cols,"rows":rows}))
                .map_err(|e| e.to_string())?,
        ))
        .map_err(|e| e.to_string())?;
    if let Some(bridge) = state.bridges.lock().unwrap().get(&id) {
        bridge.dispatch_resize(cols, rows);
    }
    if let Some(source) = state.share_glue.terminal_sources.lock().unwrap().get(&id) {
        // Keep the adapter's grid truthful, so a share started after this
        // resize reports the right size in Welcome. A share already live was
        // told through dispatch_resize above.
        source.set_grid(Viewport { cols, rows });
    }
    Ok(())
}
#[tauri::command]
fn term_kill(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = HelperSessionId::from_hex(&id).map_err(|e| e.to_string())?;
    let generation = state
        .helper_generations
        .lock()
        .unwrap()
        .get(&id)
        .copied()
        .unwrap_or(0);
    let client = state
        .helper
        .session(&id)
        .ok_or_else(|| "terminal helper is not connected".to_string())?;
    client
        .request(
            &HelperFrame::new(HelperKind::Terminate, session, generation, Vec::new()),
            HelperKind::Terminate,
            Some(session),
            std::time::Duration::from_secs(3),
        )
        .map_err(|e| e.to_string())?;
    let tab_id = state
        .share_glue
        .session_tabs
        .lock()
        .unwrap()
        .get(&id)
        .cloned();
    if let Some(tab_id) = tab_id {
        share_commands::tab_runtime_died(&state.hub, &state.sources, &state.share_glue, &tab_id);
    }
    state.bridges.lock().unwrap().remove(&id);
    state.helper_generations.lock().unwrap().remove(&id);
    state.helper.forget_session(&id);
    let _ = app.emit("background-tasks-changed", ());
    Ok(())
}
#[tauri::command]
fn term_detach(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let (client, session, generation) = helper_session(&state, &id)?;
    let out = client
        .request(
            &HelperFrame::new(HelperKind::Detach, session, generation, Vec::new()),
            HelperKind::Detach,
            Some(session),
            std::time::Duration::from_secs(3),
        )
        .map_err(|e| e.to_string())?;
    state
        .helper_generations
        .lock()
        .unwrap()
        .insert(id.clone(), out.generation);
    let tab_id = state
        .share_glue
        .session_tabs
        .lock()
        .unwrap()
        .get(&id)
        .cloned();
    if let Some(tab_id) = tab_id {
        share_commands::tab_runtime_died(&state.hub, &state.sources, &state.share_glue, &tab_id);
    }
    state.bridges.lock().unwrap().remove(&id);
    state.helper.forget_session(&id);
    let _ = app.emit("background-tasks-changed", ());
    Ok(())
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn term_attach(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    tab_id: Option<String>,
    resident_runtime_id: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> Result<String, String> {
    let session = HelperSessionId::from_hex(&id).map_err(|e| e.to_string())?;
    let client = match resident_runtime_id.as_deref() {
        Some(runtime_id) => {
            state
                .helper
                .ensure_resident(&app, runtime_id, helper_callback(&state, &app))?
        }
        None => state.helper.ensure(&app, helper_callback(&state, &app))?,
    };
    let snapshot = client
        .request(
            &HelperFrame::new(HelperKind::Attach, session, 0, Vec::new()),
            HelperKind::Snapshot,
            Some(session),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| e.to_string())?;
    state
        .helper_generations
        .lock()
        .unwrap()
        .insert(id.clone(), snapshot.generation);
    state.helper.register_session(&id, client.clone());
    let bridge = SessionBridge::new(Arc::new(WebviewSink { channel: on_event }));
    install_helper_bridge(&state, &id, bridge.clone());
    bridge.dispatch_data(&snapshot.payload);
    if let Some(tab_id) = tab_id {
        let input_client = client.clone();
        let input_generation = snapshot.generation;
        let viewport_app = app.clone();
        let viewport_session = id.clone();
        let source = Arc::new(TerminalSource::new(
            bridge,
            Arc::new(move |bytes| {
                let _ = input_client.send(&HelperFrame::new(
                    HelperKind::Input,
                    session,
                    input_generation,
                    bytes.to_vec(),
                ));
            }),
            Arc::new(move |vp: Option<Viewport>| {
                let _ = viewport_app.emit(
                    "share-viewport",
                    share_commands::ViewportEvent {
                        session_id: viewport_session.clone(),
                        cols: vp.map(|value| value.cols),
                        rows: vp.map(|value| value.rows),
                    },
                );
            }),
            Viewport { cols, rows },
        ));
        state
            .share_glue
            .session_tabs
            .lock()
            .unwrap()
            .insert(id.clone(), tab_id.clone());
        state
            .share_glue
            .terminal_sources
            .lock()
            .unwrap()
            .insert(id.clone(), source.clone());
        state.sources.register(&tab_id, source);
    }
    let _ = app.emit("background-tasks-changed", ());
    Ok(id)
}
#[tauri::command]
fn term_helper_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.helper.ensure(&app, helper_callback(&state, &app))?;
    let list = client
        .request(
            &HelperFrame::new(HelperKind::List, HelperSessionId::default(), 0, Vec::new()),
            HelperKind::List,
            None,
            std::time::Duration::from_secs(3),
        )
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&list.payload).map_err(|e| e.to_string())
}

#[tauri::command]
fn term_resident_list(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime_id: String,
) -> Result<serde_json::Value, String> {
    let client = state
        .helper
        .ensure_resident(&app, &runtime_id, helper_callback(&state, &app))?;
    let list = client
        .request(
            &HelperFrame::new(HelperKind::List, HelperSessionId::default(), 0, Vec::new()),
            HelperKind::List,
            None,
            std::time::Duration::from_secs(3),
        )
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&list.payload).map_err(|e| e.to_string())
}

#[tauri::command]
fn term_helper_kill_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let client = state.helper.ensure(&app, helper_callback(&state, &app))?;
    client
        .request(
            &HelperFrame::new(
                HelperKind::KillAll,
                HelperSessionId::default(),
                0,
                Vec::new(),
            ),
            HelperKind::KillAll,
            None,
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| e.to_string())?;
    state.bridges.lock().unwrap().clear();
    state.helper_backlog.lock().unwrap().clear();
    state.helper_generations.lock().unwrap().clear();
    let _ = app.emit("background-tasks-changed", ());
    Ok(())
}

/// Where a child webview goes, in *device* pixels.
///
/// Physical rather than logical because the UI measures in CSS pixels, and a
/// CSS pixel matches a logical one only when nothing scales the page. It does
/// not on Windows with a text-scale factor set. The UI multiplies by its own
/// `devicePixelRatio` before sending, which folds in display scale and page
/// zoom together, and these numbers then need no conversion here at all.
#[derive(serde::Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn position(self) -> tauri::PhysicalPosition<i32> {
        tauri::PhysicalPosition::new(self.x.round() as i32, self.y.round() as i32)
    }
    fn size(self) -> tauri::PhysicalSize<u32> {
        tauri::PhysicalSize::new(
            self.width.max(0.0).round() as u32,
            self.height.max(0.0).round() as u32,
        )
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserEvent {
    tab_id: String,
    url: String,
    title: String,
}

/// Standard Safari UA for the platform WebKit. The engine IS Safari's, but
/// WKWebView's default UA omits the Safari token — and sites like Google
/// treat an unrecognized UA as a legacy browser and serve their fallback
/// pages from a decade ago.
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

fn dirs_next_download() -> std::path::PathBuf {
    #[cfg(test)]
    {
        // Unit tests redirect downloads into a sandbox. This branch is not
        // compiled into the application.
        if let Ok(dir) = std::env::var("TABVERSE_DOWNLOAD_DIR") {
            return std::path::PathBuf::from(dir);
        }
    }
    // Via home_path, not HOME directly: on Windows HOME is unset, and reading
    // only it put every download in the temp directory — somewhere the user's
    // file manager never looks and the OS eventually clears.
    home_path()
        .map(|h| h.join("Downloads"))
        .unwrap_or_else(std::env::temp_dir)
}

fn webview_label(tab_id: &str) -> String {
    // Labels must be unique and may not contain the characters uuid uses.
    format!("browser-{}", tab_id.replace('-', ""))
}

/// Secret this run's pages must quote to raise a shortcut.
///
/// It lives in a closure inside the injected script, where a page's own scripts
/// cannot read it, so a page cannot open or close the user's tabs by guessing
/// the scheme.
static CMD_TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn cmd_token() -> &'static str {
    CMD_TOKEN.get_or_init(uuid_like)
}

const CMD_SCHEME: &str = "tabverse-cmd:";

/// Give a web page's own keyboard handling first refusal, then take the app's
/// shortcuts back from it.
///
/// A menu key equivalent is supposed to be offered to the application before
/// any view, but a WKWebView claims command-key combinations for the web
/// content it hosts, and the menu never hears about them — so on a browser tab
/// ⌘T opened nothing. The page is the only place left that definitely sees the
/// key, so it reports the shortcut back by attempting a navigation the app
/// cancels; nothing about the page changes.
fn shortcut_script() -> String {
    shortcut_script_for(&keys::current())
}

/// The script for a given composition — the whole of the function above, with
/// "which composition" as an argument.
///
/// Split so that "does the injected script follow a rebinding" is a question
/// a test can ask of an overlay it constructs, rather than one that could
/// only be asked of whatever this process happens to have loaded from disk.
fn shortcut_script_for(bindings: &keys::Bindings) -> String {
    let (plain, shifted) = bindings.page_tables();
    // The tab cycle, which `page_tables` cannot carry: it is a `local` row —
    // a view answers it — and every ⌃ chord is filtered out of those tables
    // anyway. It was therefore the ONE key in this script still written by
    // hand, and the hand-written copy was the seventh of its kind: the shape
    // that bound shift+D to a deleted command lived in this same string.
    let cycle = bindings.cycle_chord();
    let jump = match bindings.jump_range() {
        Some((lo, hi)) => format!(
            "{{lo:{},hi:{}}}",
            serde_json::to_string(&lo.to_string()).unwrap_or_default(),
            serde_json::to_string(&hi.to_string()).unwrap_or_default()
        ),
        None => "null".to_string(),
    };
    format!(
        r#"(function(){{
  var TOKEN = "{token}", SCHEME = "{scheme}";
  var loc = window.location;
  var PLAIN = {plain};
  var SHIFTED = {shifted};
  // The one way out of the page, tried in order of what it costs the page.
  // Both engines have a message channel that touches nothing; they simply
  // have different names for it. Returns whether anything took it.
  function post(msg) {{
    try {{
      window.webkit.messageHandlers.{handler}.postMessage(msg);
      return true;
    }} catch (_) {{}}
    try {{
      window.chrome.webview.postMessage(msg);
      return true;
    }} catch (_) {{}}
    return false;
  }}
  function raise(cmd) {{
    var msg = cmd.indexOf("?") < 0 ? cmd + "?t=" + TOKEN : cmd;
    if (post(msg)) return;
    // Last resort, reached only where neither channel exists: a top-level
    // navigation the app cancels costs an interrupted load, which is why it
    // is not tried first; doing nothing at all costs the shortcut.
    try {{
      loc.href = SCHEME + msg;
    }} catch (_) {{}}
  }}
  // Nine keys from one table row, whose ends come from that row rather than
  // from a digit test written down here. JUMP is null when the row is unbound.
  var JUMP = {jump};
  // The one chord this page answers outside the two tables above: the tab
  // cycle, whose row is handled by a view and whose modifier is not ⌘.
  // Serialized from the same composition; null when nothing is bound to it.
  var CYCLE = {cycle};
  function lookup(k, shifted) {{
    var cmd = shifted ? SHIFTED[k] : PLAIN[k];
    if (!cmd && !shifted && JUMP && k.length === 1 && k >= JUMP.lo && k <= JUMP.hi) {{
      cmd = "jump-" + k;
    }}
    return cmd;
  }}
  // cmd+click on a link opens it in a new tab — the muscle memory every
  // browser honors. Trusted events only: a synthetic cmd+click must not
  // let a page open tabs without a real user gesture (the native
  // new-window route is rate-limited for the same reason).
  window.addEventListener("click", function(e) {{
    if (!e.isTrusted || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    raise("open-tab?t=" + TOKEN + "&u=" + encodeURIComponent(a.href));
  }}, true);
  window.addEventListener("click", function(e) {{
    if (!e.isTrusted || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    raise("peek-link?t=" + TOKEN + "&u=" + encodeURIComponent(a.href));
  }}, true);
  // The page owns its pixels: a press or a pointer at its left edge is
  // invisible to the app, because a native view sits above the whole DOM.
  // Reported through a hidden frame rather than a top-level navigation,
  // which at this frequency would fight the page's own navigation.
  if (window.top === window) {{
    var edge = false;
    function tell(cmd, x) {{
      var msg = cmd + (cmd.indexOf("?") < 0 ? "?t=" + TOKEN : "");
      if (typeof x === "number") {{
        msg += "&x=" + Math.round(x);
      }}
      post(msg);
    }}
    document.addEventListener("mousedown", function(e) {{
      if (e.isTrusted) tell("page-press", e.clientX);
    }}, true);
    var corner = false;
    document.addEventListener("mousemove", function(e) {{
      if (!e.isTrusted) return;
      var now = e.clientX <= 10;
      // Only the crossing, never every pixel of travel.
      // Both crossings: entering summons the sidebar, leaving releases it.
      if (now !== edge) {{
        edge = now;
        // The exit carries WHERE the pointer went. Ten pixels is where the
        // sidebar is summoned from, but it is not where the sidebar ENDS —
        // reporting a bare exit made the sidebar vanish the moment the
        // pointer moved onto it (2026-08-12 feedback 1). The app knows its
        // own width and decides; this only supplies the fact.
        tell(now ? "page-left-edge" : "page-left-edge-exit", e.clientX);
      }}
      var w = document.documentElement.clientWidth || window.innerWidth || 0;
      var inCorner = (w - e.clientX) <= 170 && e.clientY <= 56;
      if (inCorner !== corner) {{
        corner = inCorner;
        if (inCorner) tell("page-corner", e.clientX);
      }}
    }}, true);

    // Where the tab actually is. A full page load reaches the app on its
    // own, but a page that changes its address without one — every modern
    // site's in-place navigation — leaves the app holding the address the
    // tab was opened with, which is what ⌘L, "copy link" and the saved
    // session all then show. Reading it off the webview is forbidden (an
    // uncommitted view has none, and the layer below unwraps that and takes
    // the process with it), so the page reports its own.
    var lastX = 0, lastY = 0;
    document.addEventListener("mousemove", function(e) {{
      lastX = e.clientX; lastY = e.clientY;
      // Published, because the app has to be able to say "the pointer left
      // THAT" after it takes the pointer away — and once the interface layer
      // is up the engine's own :hover is already empty, so it cannot answer.
      window.__tabversePointer = {{ x: lastX, y: lastY }};
    }}, true);
    // Why does this site look different here than in another browser? The
    // answer is always in computed style, and only the page can read it.
    // Bound to a key so the element in question can simply be pointed at.
    window.addEventListener("__tabverse_layout", function() {{
      try {{
        var el = document.elementFromPoint(lastX, lastY);
        var out = [];
        for (var i = 0; el && i < 5; i++, el = el.parentElement) {{
          var c = getComputedStyle(el);
          var r = el.getBoundingClientRect();
          out.push({{
            tag: el.tagName.toLowerCase(),
            cls: (el.className || "").toString().slice(0, 120),
            display: c.display,
            dir: c.flexDirection,
            wrap: c.flexWrap,
            align: c.alignItems,
            justify: c.justifyContent,
            w: Math.round(r.width),
            h: Math.round(r.height)
          }});
        }}
        tell("layout?t=" + TOKEN + "&d=" + encodeURIComponent(JSON.stringify(out)));
      }} catch (e) {{
        tell("layout?t=" + TOKEN + "&d=" + encodeURIComponent(String(e)));
      }}
    }});

    var lastIcon = "";
    function reportFavicon() {{
      try {{
        var l = document.querySelector(
          'link[rel~="icon" i], link[rel="apple-touch-icon" i]');
        var href = l && l.href ? l.href : (location.origin + "/favicon.ico");
        // http(s) is fetched by the app; a data: URI (a site drawing its icon,
        // e.g. a pipeline progress ring) is passed through and decoded there.
        if (!/^(https?|data):/i.test(href) || href === lastIcon) return;
        lastIcon = href;
        tell("favicon?t=" + TOKEN
          + "&h=" + encodeURIComponent(location.hostname)
          + "&u=" + encodeURIComponent(href));
      }} catch (_) {{}}
    }}
    var faviconTimer = 0;
    function scheduleFavicon() {{
      if (faviconTimer) return;
      faviconTimer = setTimeout(function () {{
        faviconTimer = 0;
        reportFavicon();
      }}, 250);
    }}
    function watchFavicon() {{
      try {{
        if (!document.head || typeof MutationObserver !== "function") return;
        new MutationObserver(scheduleFavicon).observe(document.head, {{
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["href", "rel"]
        }});
      }} catch (_) {{}}
    }}
    // After load, when the head is final; and immediately when this script
    // runs on an already-loaded document (a webview restored mid-life).
    if (document.readyState === "complete") {{
      setTimeout(reportFavicon, 0);
      watchFavicon();
    }}
    window.addEventListener("load", function () {{
      setTimeout(reportFavicon, 0);
      watchFavicon();
    }});

    var lastUrl = location.href;
    function reportUrl() {{
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      tell("url?t=" + TOKEN + "&u=" + encodeURIComponent(location.href));
      setTimeout(reportFavicon, 250);
    }}
    ["pushState", "replaceState"].forEach(function(name) {{
      var orig = history[name];
      if (typeof orig !== "function") return;
      history[name] = function() {{
        var r = orig.apply(this, arguments);
        setTimeout(reportUrl, 0);
        return r;
      }};
    }});
    window.addEventListener("popstate", function() {{ setTimeout(reportUrl, 0); }});
    window.addEventListener("hashchange", reportUrl);

    var muteOn = false, lastAudible = null, muteObserver = null;
    function elAudible(m) {{
      return !m.paused && !m.ended && !m.muted && m.volume > 0;
    }}
    function anyAudible() {{
      var list = document.querySelectorAll("audio,video");
      for (var i = 0; i < list.length; i++) if (elAudible(list[i])) return true;
      return false;
    }}
    function reportAudible() {{
      var a = anyAudible();
      if (a === lastAudible) return;
      lastAudible = a;
      tell("media-audible?t=" + TOKEN + "&a=" + (a ? "1" : "0"));
    }}
    function muteAll() {{
      var list = document.querySelectorAll("audio,video");
      for (var i = 0; i < list.length; i++) {{
        try {{ list[i].muted = true; }} catch (_) {{}}
      }}
    }}
    // Non-bubbling media events still travel the capture phase from window
    // down, so one capturing listener on the document catches every element,
    // present or added later — no per-element wiring, and dynamic media is
    // covered for free.
    ["play", "playing", "pause", "ended", "volumechange", "loadeddata", "emptied"]
      .forEach(function(ev) {{
        document.addEventListener(ev, function() {{
          if (muteOn) muteAll();
          reportAudible();
        }}, true);
      }});
    window.addEventListener("__tabverse_setmute", function(e) {{
      muteOn = !!(e && e.detail && e.detail.on);
      var list = document.querySelectorAll("audio,video");
      for (var i = 0; i < list.length; i++) {{
        try {{ list[i].muted = muteOn; }} catch (_) {{}}
      }}
      if (muteOn) {{
        if (!muteObserver) {{
          muteObserver = new MutationObserver(function() {{ if (muteOn) muteAll(); }});
          try {{
            muteObserver.observe(document.documentElement, {{ childList: true, subtree: true }});
          }} catch (_) {{}}
        }}
      }} else if (muteObserver) {{
        try {{ muteObserver.disconnect(); }} catch (_) {{}}
        muteObserver = null;
      }}
      reportAudible();
    }});

    (function() {{
      var perm = "default", askSeq = 0, waiting = {{}};
      window.addEventListener("__tabverse_notify_perm", function(e) {{
        var d = (e && e.detail) || {{}};
        if (d.perm) perm = d.perm;
        var w = waiting[d.id];
        if (w) {{ delete waiting[d.id]; w(d.perm); }}
      }});
      function request(cb) {{
        var p = new Promise(function(resolve) {{
          if (perm !== "default") {{ resolve(perm); return; }}
          var id = ++askSeq;
          waiting[id] = resolve;
          tell("notify-ask?t=" + TOKEN
            + "&h=" + encodeURIComponent(location.hostname) + "&id=" + id);
        }});
        if (typeof cb === "function") p.then(cb);
        return p;
      }}
      function N(title, opts) {{
        if (!(this instanceof N)) return new N(title, opts);
        opts = opts || {{}};
        this.title = String(title == null ? "" : title);
        this.body = String(opts.body == null ? "" : opts.body);
        this.icon = String(opts.icon == null ? "" : opts.icon);
        this.onclick = this.onclose = this.onerror = this.onshow = null;
        if (perm === "granted") {{
          var payload = {{ title: this.title, body: this.body, icon: this.icon }};
          tell("notify-show?t=" + TOKEN + "&d="
            + encodeURIComponent(JSON.stringify(payload)));
        }}
      }}
      N.requestPermission = request;
      N.prototype.close = function() {{}};
      N.prototype.addEventListener = function() {{}};
      N.prototype.removeEventListener = function() {{}};
      try {{
        Object.defineProperty(N, "permission", {{ get: function() {{ return perm; }} }});
      }} catch (_) {{}}
      try {{
        Object.defineProperty(window, "Notification",
          {{ value: N, writable: true, configurable: true }});
      }} catch (_) {{ try {{ window.Notification = N; }} catch (_) {{}} }}
    }})();
  }}
  window.addEventListener("keydown", function(e) {{
    // Only the OS makes trusted events. A page can dispatchEvent a synthetic
    // ⌘W all day; acting on it would let any site close the user's tabs.
    if (!e.isTrusted) return;
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {{
      post("peek-escape?t=" + TOKEN);
      return;
    }}
    // The tab cycle, from the composition like everything else on this page
    // (keys.rs `cycle_chord`). Shift is not compared: it picks the direction,
    // which is why the object carries the other three modifiers and not it.
    // The three ARE compared, where the hand-written line this replaced tested
    // only ctrl — so a chord that merely contained ctrl no longer cycles tabs
    // by accident.
    if (CYCLE
        && e.ctrlKey === CYCLE.ctrl
        && e.metaKey === CYCLE.cmd
        && e.altKey === CYCLE.alt
        && (e.key || "").toLowerCase() === CYCLE.key) {{
      e.preventDefault(); e.stopImmediatePropagation();
      raise(e.shiftKey ? "prev-tab" : "next-tab");
      return;
    }}
    if (!e.metaKey || e.ctrlKey || e.altKey) return;
    var cmd = lookup((e.key || "").toLowerCase(), e.shiftKey);
    if (!cmd) return;
    e.preventDefault(); e.stopImmediatePropagation();
    raise(cmd);
  }}, true);
  // A plain <a target=_blank> never calls window.open — it asks the engine
  // for a new window, and with no handler wry silently drops it. Modified
  // clicks are left alone so ⌘-click keeps its meaning.
  document.addEventListener("click", function(e) {{
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[target=_blank],a[target=_new]") : null;
    if (a && a.href) {{ e.preventDefault(); top.location.href = a.href; }}
  }}, true);
}})();"#,
        token = cmd_token(),
        scheme = CMD_SCHEME,
        handler = PAGE_CHANNEL,
        plain = plain,
        shifted = shifted,
        jump = jump,
        cycle = cycle,
    )
}

/// Turn a cancelled `tabverse-cmd:` navigation back into a shortcut.
///
/// Returns true when the url was one of ours, meaning the navigation must not
/// proceed.
/// A report from a page, however it travelled: `cmd?t=TOKEN&…`.
///
/// The transport is deliberately not this function's business — it used to
/// be a cancelled navigation, it is now a script message, and the parsing
/// and the token check are the same either way.
pub fn handle_page_report(app: &AppHandle, tab_id: &str, payload: &str) -> bool {
    handle_command(app, tab_id, payload)
}

fn handle_shortcut_url(app: &AppHandle, tab_id: &str, url: &tauri::Url) -> bool {
    let raw = url.as_str();
    let Some(rest) = raw.strip_prefix(CMD_SCHEME) else {
        return false;
    };
    handle_command(app, tab_id, rest)
}

fn handle_command(app: &AppHandle, tab_id: &str, rest: &str) -> bool {
    let (cmd, query) = rest.split_once("?t=").unwrap_or((rest, ""));
    // The token may be followed by command arguments: `t=TOKEN&u=<url>`.
    let (token, extra) = query.split_once('&').unwrap_or((query, ""));
    if token != cmd_token() {
        eprintln!("[core] shortcut url with a bad token, ignored");
        return true;
    }
    let cmd = cmd.trim_matches('/').to_string();
    // Password-manager reports carry secrets or page state; they are
    // dispatched BEFORE the generic log line below on purpose — nothing
    // from their parameters may ever be printed.
    if cmd == "save-password" {
        if let Some(d) = extra.strip_prefix("d=") {
            let decoded = percent_encoding::percent_decode_str(d).decode_utf8_lossy();
            passwords::handle_capture(app, tab_id, &decoded);
        }
        return true;
    }
    if cmd == "pw-form" {
        if let Some(h) = extra.strip_prefix("h=") {
            let host = percent_encoding::percent_decode_str(h).decode_utf8_lossy();
            passwords::handle_form_present(app, tab_id, &host);
        }
        return true;
    }
    if cmd == "us-query" {
        if let Some(u) = extra.strip_prefix("u=") {
            let url = percent_encoding::percent_decode_str(u)
                .decode_utf8_lossy()
                .to_string();
            userscripts::handle_query(app, tab_id, &url);
        }
        return true;
    }
    if cmd == "us-set" || cmd == "us-menu" || cmd == "us-xhr" {
        if let Some(d) = extra.strip_prefix("d=") {
            let decoded = percent_encoding::percent_decode_str(d)
                .decode_utf8_lossy()
                .to_string();
            userscripts::handle_report(app, tab_id, &cmd, &decoded);
        }
        return true;
    }
    if cmd == "notify-ask" {
        let mut host = String::new();
        let mut ask_id: u64 = 0;
        for part in extra.split('&') {
            match part.split_once('=') {
                Some(("h", v)) => {
                    host = percent_encoding::percent_decode_str(v)
                        .decode_utf8_lossy()
                        .to_string();
                }
                Some(("id", v)) => ask_id = v.parse().unwrap_or(0),
                _ => {}
            }
        }
        page_notify::request_permission(app, tab_id, &host, ask_id);
        return true;
    }
    if cmd == "notify-show" {
        if let Some(d) = extra.strip_prefix("d=") {
            let decoded = percent_encoding::percent_decode_str(d)
                .decode_utf8_lossy()
                .to_string();
            page_notify::show(app, tab_id, &decoded);
        }
        return true;
    }
    if cmd == "media-audible" {
        let audible = extra.strip_prefix("a=").is_some_and(|v| v == "1");
        let _ = app.emit(
            "browser-media",
            serde_json::json!({ "tabId": tab_id, "audible": audible }),
        );
        return true;
    }
    if cmd == "page-press"
        || cmd == "page-left-edge"
        || cmd == "page-left-edge-exit"
        || cmd == "page-corner"
    {
        // The pointer's x, when the report carries one (the left-edge exit):
        // the interface compares it with its own sidebar width.
        let x = extra
            .split('&')
            .find_map(|part| part.strip_prefix("x="))
            .and_then(|v| v.parse::<f64>().ok());
        let _ = app.emit(
            "browser-pointer",
            serde_json::json!({ "kind": cmd, "tabId": tab_id, "x": x }),
        );
        return true;
    }
    if cmd == "peek-escape" {
        let _ = app.emit(
            "browser-peek-escape",
            serde_json::json!({ "tabId": tab_id }),
        );
        return true;
    }
    if cmd == "url" {
        if let Some(enc) = extra.strip_prefix("u=") {
            let url = percent_encoding::percent_decode_str(enc)
                .decode_utf8_lossy()
                .to_string();
            eprintln!("[core] in-page address change tab={tab_id} url={url}");
            let _ = app.emit(
                "browser-url",
                BrowserEvent {
                    tab_id: tab_id.to_string(),
                    url,
                    title: String::new(),
                },
            );
        }
        return true;
    }
    if cmd == "favicon" {
        let mut host = String::new();
        let mut icon = String::new();
        for part in extra.split('&') {
            match part.split_once('=') {
                Some(("h", v)) => {
                    host = percent_encoding::percent_decode_str(v)
                        .decode_utf8_lossy()
                        .to_string();
                }
                Some(("u", v)) => {
                    icon = percent_encoding::percent_decode_str(v)
                        .decode_utf8_lossy()
                        .to_string();
                }
                _ => {}
            }
        }
        favicon::report(app, tab_id, &host, &icon);
        return true;
    }
    if cmd == "unload-check" {
        let dirty = extra.strip_prefix("d=").is_some_and(|v| v == "1");
        let _ = app.emit(
            "browser-unload-answer",
            serde_json::json!({ "tabId": tab_id, "dirty": dirty }),
        );
        return true;
    }
    if cmd == "open-tab" {
        // cmd+click on a link, reported by the injected listener. The href
        // rides percent-encoded in `u=`; scheme and rate checks live in
        // open_tab_in_app, shared with the engine's new-window route.
        if let Some(enc) = extra.strip_prefix("u=") {
            let url = percent_encoding::percent_decode_str(enc)
                .decode_utf8_lossy()
                .to_string();
            open_tab_in_app(app, &url);
        }
        return true;
    }
    if cmd == "peek-link" {
        if let Some(enc) = extra.strip_prefix("u=") {
            let url = percent_encoding::percent_decode_str(enc)
                .decode_utf8_lossy()
                .to_string();
            let _ = app.emit(
                "browser-open-peek",
                serde_json::json!({ "tabId": tab_id, "url": url }),
            );
        }
        return true;
    }
    eprintln!("[core] shortcut from page: {cmd}");
    let _ = app.emit("app-command", AppCommandEvent { cmd, from: "page" });
    true
}

fn open_tab_in_app(app: &AppHandle, url: &str) {
    match url.parse::<tauri::Url>() {
        Ok(u) if matches!(u.scheme(), "http" | "https") => {}
        _ => {
            eprintln!("[core] open-tab refused non-http(s) url");
            return;
        }
    }
    static WINDOW: Mutex<Option<(std::time::Instant, u32)>> = Mutex::new(None);
    {
        let mut w = WINDOW.lock().unwrap();
        let now = std::time::Instant::now();
        let (start, count) = w.get_or_insert((now, 0));
        if now.duration_since(*start) > std::time::Duration::from_secs(1) {
            *start = now;
            *count = 0;
        }
        *count += 1;
        if *count > 5 {
            eprintln!("[core] open-tab rate limit hit, dropped");
            return;
        }
    }
    eprintln!("[core] open-tab -> new browser tab");
    let _ = app.emit("browser-open-tab", serde_json::json!({ "url": url }));
}

#[tauri::command]
fn browser_open_external(url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) pages can be opened externally".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(parsed.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open failed: {e}"))
}

#[derive(Clone, serde::Serialize)]
struct AppCommandEvent {
    cmd: String,
    /// Which route delivered it. Both can fire for one press, and only the
    /// route tells them apart from the user pressing the key twice.
    from: &'static str,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FindResultEvent {
    tab_id: String,
    total: u32,
    current: u32,
    /// How many frames the report covered. The find bar shows the
    /// "main page and same-origin embeds" note off this, so a page with
    /// one frame stays unannotated and a multi-frame search says its
    /// scope instead of implying the whole web was counted.
    frames: u32,
}

fn parse_find_counts(query: &str) -> Option<(u32, u32, u32)> {
    let mut counts: Vec<u32> = Vec::new();
    let mut current: Option<u32> = None;
    let mut declared: Option<u32> = None;
    for part in query.split('&') {
        match part.split_once('=') {
            Some(("n", v)) => counts.push(v.parse().ok()?),
            Some(("i", v)) => current = v.parse().ok(),
            Some(("f", v)) => declared = v.parse().ok(),
            _ => {}
        }
    }
    let current = current?;
    if counts.is_empty() {
        // A report with no frame counts is no report: the finder always
        // sends one n per frame searched, top frame included.
        return None;
    }
    let frames = counts.len() as u32;
    if declared.is_some_and(|f| f != frames) {
        eprintln!("[core] find-result frame count {declared:?} disagrees with {frames} counts");
    }
    let total = counts.iter().sum::<u32>();
    Some((total, current, frames))
}

/// Turn a cancelled `tabverse-cmd:find-result?n=<count>&…&f=<frames>&i=<current>`
/// navigation into a find-result event for the UI's match counter.
///
/// Deliberately exempt from the token check that gates every other
/// `tabverse-cmd:` navigation: the finder runs as page-world code (see
/// `browser_find`), so handing it the token would hand it to the page too.
/// Forging this report gains a page nothing — it can only lie about its own
/// match count, which is display-only — while command forgery (close-tab and
/// friends) stays token-gated in `handle_shortcut_url`.
///
/// Returns true when the url was a find-result, meaning the navigation must
/// not proceed. Anything but parseable u32 counts is dropped (still
/// cancelled).
fn handle_find_result_url(app: &AppHandle, tab_id: &str, url: &tauri::Url) -> bool {
    let raw = url.as_str();
    let Some(rest) = raw.strip_prefix(CMD_SCHEME) else {
        return false;
    };
    let Some(query) = rest.strip_prefix("find-result?") else {
        return false;
    };
    if let Some((total, current, frames)) = parse_find_counts(query) {
        let _ = app.emit(
            "browser-find-result",
            FindResultEvent {
                tab_id: tab_id.to_string(),
                total,
                current,
                frames,
            },
        );
    } else {
        eprintln!("[core] find-result with malformed counts, dropped");
    }
    true
}

/// The loopback proxy's slot in [`AppState`], and what trying to start it
/// found.
#[derive(Default)]
enum PageProxySlot {
    /// Nobody has asked for coverage yet — the default, because the switch
    /// defaults to off and an app that never covers a page never runs the
    /// proxy's threads.
    #[default]
    Idle,
    /// Running, holding the port every covered webview is pointed at.
    Running(page_proxy::PageProxy),
    Failed,
}

fn page_proxy_url(
    cover_on: bool,
    policy: &http::DnsPolicy,
    coverable: bool,
    port: u16,
) -> Option<String> {
    (cover_on && matches!(policy, http::DnsPolicy::Doh(_)) && coverable)
        .then(|| format!("http://127.0.0.1:{port}"))
}

fn is_coverable_platform() -> bool {
    #[cfg(target_os = "macos")]
    {
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        macos_version_coverable(version.majorVersion as u64, version.minorVersion as u64)
    }
    #[cfg(target_os = "windows")]
    {
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// The macOS half of the gate, on the (major, minor) the probe reports, so
/// the boundary is testable without owning a machine on each side of it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn macos_version_coverable(major: u64, minor: u64) -> bool {
    (major, minor) >= (14, 0)
}

fn ensure_page_proxy(
    app: &AppHandle,
    state: &AppState,
    cover_on: bool,
    coverable: bool,
) -> Option<String> {
    let policy = http::policy();
    // Asked with port 0 because only the three conditions' answer matters
    // here — a tab the conditions do not cover is never the tab that starts
    // the proxy. The real port is named below.
    page_proxy_url(cover_on, &policy, coverable, 0)?;
    let mut slot = state.page_proxy.lock().unwrap_or_else(|e| e.into_inner());
    // The first ask starts the proxy; a start that already failed is not
    // retried. The proxy is handed a death notice to deliver — the event
    // the settings page's banner and the tab wiring both answer to.
    if matches!(&*slot, PageProxySlot::Idle) {
        let tell_app = app.clone();
        match page_proxy::PageProxy::start(move || {
            if let Some(window) = tell_app.get_window("main") {
                clear_shared_page_proxy(&window);
            }
            let _ = tell_app.emit("page-proxy-down", serde_json::json!({ "status": "down" }));
        }) {
            Ok(proxy) => {
                let port = proxy.port;
                *slot = PageProxySlot::Running(proxy);
                eprintln!("[core] page proxy covering page traffic on 127.0.0.1:{port}");
            }
            Err(e) => {
                *slot = PageProxySlot::Failed;
                eprintln!(
                    "[core] page traffic coverage is on but the loopback proxy could not \
                     start ({e}); page traffic resolves through the system for the rest \
                     of this run"
                );
            }
        }
    }
    slot_page_proxy_url(&slot, cover_on, &policy, coverable)
}

fn slot_page_proxy_url(
    slot: &PageProxySlot,
    cover_on: bool,
    policy: &http::DnsPolicy,
    coverable: bool,
) -> Option<String> {
    let PageProxySlot::Running(proxy) = slot else {
        return None; // never asked for, or a start that failed
    };
    if !proxy.is_alive() {
        eprintln!(
            "[core] the page proxy's listener is not alive; the new tab resolves \
             through the system, and already-open tabs fall back on reopen"
        );
        return None;
    }
    page_proxy_url(cover_on, policy, coverable, proxy.port)
}

/// Clear wry's proxy from the shared default WKWebsiteDataStore before a
/// direct page is born.
///
/// `proxy_url` looks per-builder, but wry implements it by setting the
/// private `proxyConfigurations` key on the website data store. Tabverse's
/// page webviews share the default store so their cookies remain one jar;
/// a later builder with no proxy does NOT clear the earlier value. Clearing
/// here makes the setting global — as the shared store actually is — while
/// preserving the cookie jar. Existing pages use the new route for their
/// next request; the Settings copy names that reality rather than promising
/// a per-tab configuration WebKit cannot provide.
#[cfg(target_os = "macos")]
fn clear_shared_page_proxy(window: &Window) {
    let Some(main) = window.get_webview("main") else {
        return;
    };
    let _ = main.with_webview(|pw| unsafe {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        let wk = pw.inner() as *mut AnyObject;
        let config: *mut AnyObject = msg_send![&*wk, configuration];
        let store: *mut AnyObject = msg_send![&*config, websiteDataStore];
        let array_class = AnyClass::get(&std::ffi::CString::new("NSArray").unwrap())
            .expect("Foundation always has NSArray");
        let empty: *mut AnyObject = msg_send![array_class, array];
        let key = objc2_foundation::NSString::from_str("proxyConfigurations");
        let _: () = msg_send![&*store, setValue: empty, forKey: &*key];
    });
}

#[cfg(not(target_os = "macos"))]
fn clear_shared_page_proxy(_window: &Window) {}

/// Embed a real web page as a child webview positioned over the tab area.
///
/// A child webview (rather than an iframe) is what makes this a browser tab
/// and not a framed page: no X-Frame-Options refusals, its own history, and
/// the platform's own rendering. The cost is that it floats above the DOM, so
/// the UI must keep telling us where to put it.
#[tauri::command]
async fn browser_create(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    use tauri::WebviewUrl;

    eprintln!("[core] browser_create enter tab={tab_id} url={url}");
    // A restored tab must not fire its first request before the saved
    // session cookies are back in the store — that request would go out
    // logged-out and could overwrite the very cookie about to be restored.
    let restore_app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        cookies::ensure_restored(&restore_app);
    })
    .await;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let label = webview_label(&tab_id);
    if window.get_webview(&label).is_some() {
        eprintln!("[core] browser_create already exists");
        return Ok(());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    #[cfg(target_os = "macos")]
    nav_failures::remember_request(&tab_id, &url);
    peek::command_stamp(&tab_id);

    // Page-load events come from the engine itself, so they report what the
    // page actually did rather than what we asked for. External pages get no
    // Tauri IPC injected, so this is also the only honest load signal we have.
    let load_app = app.clone();
    let load_tab = tab_id.clone();
    let title_app = app.clone();
    let title_tab = tab_id.clone();
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .auto_resize()
        .user_agent(BROWSER_UA)
        // Real page titles for the sidebar; external pages have no IPC, so
        // this engine callback is the only honest source.
        .on_document_title_changed(move |_wv, title| {
            eprintln!("[core] browser_title tab={title_tab} title={title:?}");
            let _ = title_app.emit(
                "browser-title",
                BrowserEvent {
                    tab_id: title_tab.clone(),
                    url: String::new(),
                    title,
                },
            );
        })
        .initialization_script_for_all_frames(shortcut_script())
        .initialization_script(passwords::capture_script())
        .on_navigation({
            let nav_app = app.clone();
            let nav_tab = tab_id.clone();
            move |url| {
                // Token-less find reports must be tried first: the token
                // check below would otherwise reject and swallow them.
                if handle_find_result_url(&nav_app, &nav_tab, url) {
                    return false;
                }
                if handle_shortcut_url(&nav_app, &nav_tab, url) {
                    return false;
                }
                if peek::intercept(&nav_app, &nav_tab, url) {
                    return false;
                }
                true
            }
        })
        .on_download({
            let dl_app = app.clone();
            let dl_tab = tab_id.clone();
            let last_destination: Arc<Mutex<Option<std::path::PathBuf>>> =
                Arc::new(Mutex::new(None));
            move |_wv, ev| {
                match ev {
                    tauri::webview::DownloadEvent::Requested { url, destination } => {
                        nav_watchdog::load_started(&dl_tab);
                        // The engine's suggested name (Content-Disposition
                        // aware) beats the URL's last path segment: a
                        // /get?file=report.pdf URL would otherwise be saved
                        // as an extensionless file called "get".
                        let name = destination
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| {
                                url.path_segments()
                                    .and_then(|mut s| s.next_back())
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or("download")
                                    .to_string()
                            });
                        let dir = dirs_next_download();
                        // Never overwrite: pick name, 1-name, 2-name, ...
                        let mut candidate = dir.join(&name);
                        let mut n = 1;
                        while candidate.exists() {
                            candidate = dir.join(format!("{n}-{name}"));
                            n += 1;
                        }
                        *destination = candidate.clone();
                        *last_destination.lock().unwrap() = Some(candidate.clone());
                        dl_app
                            .state::<AppState>()
                            .downloads
                            .lock()
                            .unwrap()
                            .insert(candidate.clone());
                        // The ledger's first half. Counts, not paths, in
                        // logs — a download is user data.
                        let file_name = candidate
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or(name);
                        let _ = dl_app.emit(
                            "download-started",
                            serde_json::json!({
                                "path": candidate.to_string_lossy(),
                                "name": file_name,
                            }),
                        );
                        eprintln!("[core] download started");
                    }
                    tauri::webview::DownloadEvent::Finished {
                        url: _,
                        path,
                        success,
                    } => {
                        use tauri_plugin_notification::NotificationExt;
                        let settled = path
                            .clone()
                            .or_else(|| last_destination.lock().unwrap().clone());
                        let body = settled
                            .as_ref()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default();
                        // The ledger's second half, matched by path.
                        if let Some(p) = &settled {
                            let _ = dl_app.emit(
                                "download-finished",
                                serde_json::json!({
                                    "path": p.to_string_lossy(),
                                    "success": success,
                                }),
                            );
                        }
                        eprintln!("[core] download finished success={success}");
                        let _ = dl_app
                            .notification()
                            .builder()
                            .title(if success {
                                "Download finished"
                            } else {
                                "Download failed"
                            })
                            .body(body)
                            .show();
                    }
                    _ => {}
                }
                true
            }
        })
        .on_page_load(move |wv, payload| {
            let url = payload.url().to_string();
            let phase = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
            };
            eprintln!("[core] browser_page_load tab={load_tab} {phase} url={url}");
            // A load began, so nothing is owed on this tab any more.
            nav_watchdog::load_started(&load_tab);
            #[cfg(target_os = "macos")]
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                nav_failures::report_blank_load(&load_app, &load_tab, &url);
            }
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                // A login lands right before a page load finishes (form POST,
                // redirect chain) — snapshot session cookies now rather than
                // betting the user keeps the app open until the next tick.
                cookies::request_snapshot();
                peek::load_finished(&load_tab);
                userscripts::on_page_finished(&load_app, &load_tab, &wv);
            }
            let _ = wv.window();
            let _ = load_app.emit(
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    "browser-loading"
                } else {
                    "browser-url"
                },
                BrowserEvent {
                    tab_id: load_tab.clone(),
                    url,
                    title: String::new(),
                },
            );
        });
    // A page asking for a new window gets a new browser TAB: Deny tells the
    // engine no native webview came to exist, and the app opens the URL
    // itself. This is the one route that sees both window.open and a plain
    // target=_blank click.
    let builder = builder.on_new_window({
        let nw_app = app.clone();
        move |url, _features| {
            open_tab_in_app(&nw_app, url.as_str());
            tauri::webview::NewWindowResponse::Deny
        }
    });
    let builder = if userscripts::any_enabled(&app) {
        userscripts::mark_bootstrapped(&label);
        builder.initialization_script(userscripts::bootstrap_script())
    } else {
        builder
    };
    let cover_on = config::load()
        .map(|loaded| loaded.config.network.cover_page_traffic)
        .unwrap_or(false);
    let proxy = ensure_page_proxy(&app, &state, cover_on, is_coverable_platform());
    if proxy.is_none() {
        clear_shared_page_proxy(&window);
    }
    let builder = match proxy {
        Some(proxy) => builder.proxy_url(
            proxy
                .parse()
                .expect("a loopback address this side just formatted"),
        ),
        None => builder,
    };
    window
        .add_child(builder, bounds.position(), bounds.size())
        .map_err(|e| format!("add_child failed: {e}"))?;

    eprintln!("[core] browser_create added child webview {label}");
    #[cfg(target_os = "macos")]
    if let Some(wv) = window.get_webview(&label) {
        let auth_app = app.clone();
        let nav_tab_id = tab_id.clone();
        let _ = wv.with_webview(move |pw| unsafe {
            let wk = pw.inner() as *mut objc2::runtime::AnyObject;
            let nav_delegate: *mut objc2::runtime::AnyObject =
                objc2::msg_send![&*wk, navigationDelegate];
            // Failure handlers go on before the auth module re-assigns the
            // delegate, so one re-assignment refreshes WebKit's cache of
            // which methods exist for both of them.
            nav_failures::register_tab(wk, &nav_tab_id);
            peek::install_frame_probe(nav_delegate);
            // The page's own way of talking back — installed before the
            // first script runs, since scripts post to it immediately.
            page_channel::install(&auth_app, wk);
            nav_failures::install(&auth_app, nav_delegate);
            basic_auth::install(&auth_app, wk, nav_delegate);
            let ui_delegate: *mut objc2::runtime::AnyObject = objc2::msg_send![&*wk, UIDelegate];
            dialogs::install(&auth_app, wk, ui_delegate);
        });
    }
    #[cfg(target_os = "windows")]
    if let Some(wv) = window.get_webview(&label) {
        let channel_app = app.clone();
        let channel_tab = tab_id.clone();
        let _ = wv.with_webview(move |pw| {
            let controller = pw.controller();
            page_channel_win::install(&channel_app, &controller, channel_tab.clone());
            // Why a page did not open, and the way past a certificate.
            nav_windows::install(&channel_app, &controller, channel_tab.clone());
            // A site behind Basic auth could not be opened here at all
            // before this: the engine ships no dialog of its own.
            basic_auth_win::install(&channel_app, &controller, channel_tab.clone());
            // The page's own questions, in the app's appearance, and with
            // the answer remembered per site.
            dialogs_win::install(&channel_app, &controller, channel_tab);
        });
    }
    state.browsers.lock().unwrap().insert(tab_id.clone(), label);
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_return)]
fn window_buttons(app: AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window is gone".to_string())?;
        // The pointer is fetched inside the closure: a raw pointer cannot
        // cross threads, and this is the thread that may touch it anyway.
        let for_main = window.clone();
        window
            .run_on_main_thread(move || unsafe {
                let Ok(ptr) = for_main.ns_window() else {
                    return;
                };
                let ns_window = ptr as *mut objc2::runtime::AnyObject;
                // NSWindowButton: 0 close, 1 miniaturize, 2 zoom.
                for which in 0..3isize {
                    let button: *mut objc2::runtime::AnyObject =
                        objc2::msg_send![&*ns_window, standardWindowButton: which];
                    if !button.is_null() {
                        let () = objc2::msg_send![&*button, setHidden: !visible];
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
        Ok(())
    }
}

#[tauri::command]
#[allow(clippy::needless_return)]
fn browser_plane_raise(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let label = state
            .browsers
            .lock()
            .unwrap()
            .get(&tab_id)
            .cloned()
            .ok_or_else(|| format!("no browser for {tab_id}"))?;
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window is gone".to_string())?;
        let wv = window
            .get_webview(&label)
            .ok_or_else(|| "webview is gone".to_string())?;
        ui_plane::set_plane_on_top(&wv, true)?;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, tab_id);
        Ok(false)
    }
}

#[tauri::command]
#[allow(clippy::needless_return)]
fn ui_plane_set(app: AppHandle, on_top: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window is gone".to_string())?;
        let wv = window
            .get_webview("main")
            .ok_or_else(|| "the app webview is gone".to_string())?;
        ui_plane::set_plane_on_top(&wv, on_top)?;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, on_top);
        Ok(false)
    }
}

#[tauri::command]
fn browser_release_hover(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let labels: Vec<String> = state.browsers.lock().unwrap().values().cloned().collect();
    for label in labels {
        if let Some(wv) = window.get_webview(&label) {
            let _ = wv.eval(
                r#"(function(){
                  try {
                    // Two sources, because neither alone is enough. The engine's
                    // :hover chain is the truth while the page still has the
                    // pointer; the moment the interface layer takes it, that
                    // chain is empty and the only record of where the pointer
                    // was is the one the injected script keeps.
                    var seen = [];
                    var add = function(el){
                      while (el && seen.indexOf(el) < 0) { seen.push(el); el = el.parentElement; }
                    };
                    var hov = document.querySelectorAll(':hover');
                    for (var i = 0; i < hov.length; i++) add(hov[i]);
                    var p = window.__tabversePointer;
                    if (p) add(document.elementFromPoint(p.x, p.y));
                    for (var j = 0; j < seen.length; j++) {
                      seen[j].dispatchEvent(new MouseEvent('mouseleave',
                        {bubbles:false, cancelable:true, clientX:-1, clientY:-1}));
                      seen[j].dispatchEvent(new MouseEvent('mouseout',
                        {bubbles:true, cancelable:true, clientX:-1, clientY:-1}));
                    }
                  } catch (e) {}
                })()"#,
            );
        }
    }
    Ok(())
}

#[tauri::command]
async fn browser_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<String, String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = wv;
        Err("page snapshots are not supported on this platform".into())
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        #[cfg(target_os = "macos")]
        snapshot::take(&wv, tx);
        #[cfg(target_os = "windows")]
        snapshot_win::take(&wv, tx);
        let _ = wv;
        // Off the async thread, so waiting never blocks the main thread the
        // completion handler needs. The interface gives up at ~300ms; this
        // longer stop only exists so an engine that never answers cannot
        // leak a blocked task.
        let got = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_millis(1500))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "the engine did not answer".to_string())?;
        // Outcome log carries the tab id only — never the page's address.
        match &got {
            Ok(data) => eprintln!("[snapshot] tab={tab_id} ok bytes={}", data.len()),
            Err(e) => eprintln!("[snapshot] tab={tab_id} failed: {e}"),
        }
        got
    }
}

#[tauri::command]
async fn pw_authorize_view(app: AppHandle) -> Result<(), String> {
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
fn pw_reveal(host: String, username: String) -> Result<String, String> {
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
async fn pw_authorize_export() -> Result<(), String> {
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
fn pw_forget_all() -> Result<usize, String> {
    credentials::forget_all_web()
}

#[tauri::command]
fn pw_export(path: String) -> Result<usize, String> {
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
fn pw_import(path: String) -> Result<pw_portable::ImportReport, String> {
    pw_portable::import_csv(std::path::Path::new(&path))
}

#[tauri::command]
async fn migrate_authorize_export() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            user_presence::ask("export everything to move Tabverse to another computer")
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[tauri::command]
async fn migrate_export(
    app: AppHandle,
    path: String,
    passphrase: String,
) -> Result<migrate::Summary, String> {
    #[cfg(target_os = "windows")]
    if !user_presence_win::authorized_recently() {
        return Err("that export was not authorized, or the authorization expired".into());
    }
    #[cfg(target_os = "macos")]
    if !user_presence::authorized_recently() {
        return Err("that export was not authorized, or the authorization expired".into());
    }
    let dir = state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        migrate::export_to_path(&dir, std::path::Path::new(&path), &passphrase)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn migrate_import_check(
    app: AppHandle,
    path: String,
    passphrase: String,
    stamp: String,
) -> Result<serde_json::Value, String> {
    let dir = state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let summary = migrate::check_bundle(std::path::Path::new(&path), &passphrase)?;
        let backup = migrate::backup_dir(&dir, &stamp)?;
        Ok(serde_json::json!({
            "summary": summary,
            "backupPath": backup.display().to_string(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn migrate_import_apply(
    app: AppHandle,
    path: String,
    passphrase: String,
    stamp: String,
) -> Result<migrate::ImportResult, String> {
    let dir = state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        migrate::import_bundle(&dir, std::path::Path::new(&path), &passphrase, &stamp)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn browser_dialog_answer(
    app: AppHandle,
    dialog_id: u64,
    ok: bool,
    text: Option<String>,
    remember: bool,
    kind: Option<String>,
) -> Result<(), String> {
    if kind.as_deref() == Some("notifications") {
        return page_notify::answer(&app, dialog_id, ok, remember);
    }
    #[cfg(target_os = "macos")]
    return dialogs::answer(app, dialog_id, ok, text, remember, kind);
    #[cfg(target_os = "windows")]
    return dialogs_win::answer(app, dialog_id, ok, text, remember, kind);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, dialog_id, ok, text, remember, kind);
        Err("not implemented on this platform".into())
    }
}

#[tauri::command]
fn browser_ask_unload(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    let script = format!(
        r#"(function() {{
  var dirty = false;
  try {{
    var e = new Event("beforeunload", {{ cancelable: true }});
    // Three idioms in the wild, and a page may use any of them:
    // preventDefault, assigning returnValue, or returning a string from
    // the onbeforeunload property. The last one is not delivered by a
    // synthetic dispatch, so it is called directly.
    window.dispatchEvent(e);
    if (e.defaultPrevented) dirty = true;
    if (typeof e.returnValue === "string" && e.returnValue !== "") dirty = true;
    if (e.returnValue === false) dirty = true;
    if (typeof window.onbeforeunload === "function") {{
      var r = window.onbeforeunload(e);
      if (r !== undefined && r !== null) dirty = true;
    }}
  }} catch (_) {{}}
  var msg = "unload-check?t={token}&d=" + (dirty ? "1" : "0");
  try {{
    window.webkit.messageHandlers.{handler}.postMessage(msg);
    return;
  }} catch (_) {{}}
  try {{ window.chrome.webview.postMessage(msg); }} catch (_) {{}}
}})();"#,
        handler = PAGE_CHANNEL,
        token = cmd_token(),
    );
    wv.eval(&script).map_err(|e| e.to_string())
}

/// Platform-independent command over the macOS-only implementation, so the
/// command table itself never varies by platform.
#[tauri::command]
fn browser_auth_answer(
    app: AppHandle,
    challenge_id: u64,
    username: Option<String>,
    password: Option<String>,
    save: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return basic_auth::answer(app, challenge_id, username, password, save);
    #[cfg(target_os = "windows")]
    return basic_auth_win::answer(app, challenge_id, username, password, save);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, challenge_id, username, password, save);
        Err("not implemented on this platform".into())
    }
}

#[tauri::command]
fn browser_set_bounds(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    bounds: Bounds,
    visible: bool,
) -> Result<(), String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    // Hiding by moving off-screen: child webviews have no visibility toggle,
    // and destroying one on every tab switch would lose page state.
    if visible {
        wv.set_position(bounds.position())
            .map_err(|e| e.to_string())?;
        wv.set_size(bounds.size()).map_err(|e| e.to_string())?;
    } else {
        wv.set_position(tauri::PhysicalPosition::new(-100_000, -100_000))
            .map_err(|e| e.to_string())?;
        // Moving a webview off-screen does not make it stop being the view the
        // keyboard talks to. Without this, leaving a browser tab would leave
        // the keystrokes behind with the parked page and the terminal you
        // switched to would silently receive nothing.
        //
        // Only reclaim focus when the hidden page owns it. During an unsplit,
        // another pane can remain visible; taking focus unconditionally would
        // remove it from that surviving pane and reset page focus on return.
        #[cfg(target_os = "macos")]
        let take_it = ui_plane::holds_keyboard(&wv).unwrap_or(true);
        #[cfg(not(target_os = "macos"))]
        let take_it = true;
        if take_it {
            if let Some(main) = window.get_webview("main") {
                let _ = main.set_focus();
            }
        }
    }
    Ok(())
}

/// Which child webview belongs to a tab. Shared with the navigation
/// watchdog, which has to ask the same question to try again.
pub fn browser_label(app: &AppHandle, tab_id: &str) -> Option<String> {
    app.try_state::<AppState>()?
        .browsers
        .lock()
        .ok()?
        .get(tab_id)
        .cloned()
}

#[tauri::command]
fn browser_navigate(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    action: String,
    url: Option<String>,
) -> Result<(), String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    peek::command_stamp(&tab_id);
    match action.as_str() {
        "go" => {
            let u = url.ok_or_else(|| "no url".to_string())?;
            let parsed: tauri::Url = u.parse().map_err(|e| format!("bad url: {e}"))?;
            #[cfg(target_os = "macos")]
            nav_failures::remember_request(&tab_id, &u);
            eprintln!("[core] browser_navigate go tab={tab_id} label={label} url={u}");
            let outcome = wv.navigate(parsed);
            eprintln!(
                "[core] browser_navigate returned ok={} tab={tab_id}",
                outcome.is_ok()
            );
            if outcome.is_ok() {
                nav_watchdog::watch(&app, &tab_id, &u);
            }
            outcome.map_err(|e| e.to_string())
        }
        "back" => wv.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => wv.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => wv.eval("location.reload()").map_err(|e| e.to_string()),
        other => Err(format!("unknown action {other}")),
    }
}

/// Read the child webview's current title and url back into the app.
#[tauri::command]
fn browser_probe(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    // Deliberately does NOT read the webview's URL: WKWebView reports none
    // until a navigation commits (unreachable host, page still loading, blank
    // webview), and wry unwraps that internally — which ABORTS the whole
    // process, not just this call. That is a crash-on-launch for anyone whose
    // restored browser tab points somewhere unreachable. Page-load events
    // already carry the url, so this only needs to prove the webview is there.
    let _ = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    Ok(())
}

#[tauri::command]
fn browser_zoom(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    scale: f64,
) -> Result<(), String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    wv.set_zoom(scale).map_err(|e| e.to_string())
}

#[tauri::command]
fn browser_set_muted(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    muted: bool,
) -> Result<(), String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    let js = format!(
        "window.dispatchEvent(new CustomEvent('__tabverse_setmute',{{detail:{{on:{}}}}}))",
        if muted { "true" } else { "false" }
    );
    wv.eval(&js).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_return)]
fn browser_print(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;

    #[cfg(target_os = "macos")]
    {
        wv.with_webview(|pw| unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            let wk = pw.inner() as *mut AnyObject;
            if wk.is_null() {
                eprintln!("[print] no webview object");
                return;
            }
            // The shared NSPrintInfo is the panel's default paper and
            // orientation; the user changes them in the panel itself.
            let info_cls =
                objc2::runtime::AnyClass::get(&std::ffi::CString::new("NSPrintInfo").unwrap());
            let Some(info_cls) = info_cls else {
                eprintln!("[print] NSPrintInfo is missing from this system");
                return;
            };
            let print_info: *mut AnyObject = msg_send![info_cls, sharedPrintInfo];
            let op: *mut AnyObject = msg_send![&*wk, printOperationWithPrintInfo: print_info];
            if op.is_null() {
                eprintln!("[print] the engine returned no print operation");
                return;
            }
            let () = msg_send![&*op, setShowsPrintPanel: true];
            let window: *mut AnyObject = msg_send![&*wk, window];
            if !window.is_null() {
                // delegate nil + a NULL callback: with no delegate the
                // did-run selector is never sent, so the selector value only
                // has to type-check, and the sheet drives itself to done.
                let delegate: *mut AnyObject = std::ptr::null_mut();
                let context: *mut std::ffi::c_void = std::ptr::null_mut();
                let sel = objc2::sel!(printOperationDidRun:success:contextInfo:);
                let () = msg_send![
                    &*op,
                    runOperationModalForWindow: window,
                    delegate: delegate,
                    didRunSelector: sel,
                    contextInfo: context,
                ];
                eprintln!("[print] print sheet presented on the window");
            } else {
                // No host window (should not happen for a live tab): fall back
                // to the app-modal run rather than silently printing nothing.
                let _ran: bool = msg_send![&*op, runOperation];
                eprintln!("[print] no host window; ran app-modal print operation");
            }
        })
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        wv.with_webview(|pw| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER,
            };
            use windows_core::Interface;
            let controller = pw.controller();
            unsafe {
                let core = match controller.CoreWebView2() {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[print] no CoreWebView2: {e}");
                        return;
                    }
                };
                match core.cast::<ICoreWebView2_16>() {
                    Ok(v16) => {
                        if let Err(e) = v16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER) {
                            eprintln!("[print] ShowPrintUI failed: {e}");
                        } else {
                            eprintln!("[print] print UI shown");
                        }
                    }
                    Err(e) => eprintln!("[print] this WebView2 runtime has no ShowPrintUI: {e}"),
                }
            }
        })
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = wv;
        Err("printing is not available on this platform".into())
    }
}

const FIND_SCRIPT: &str = r#"(function () {
  var q = __TABVERSE_QUERY__, back = __TABVERSE_BACK__;
  // State carried across evals of this script: the query the matches belong
  // to, one array of match Ranges per frame searched (frames[0] is the top
  // document, then depth-first document order), the documents those frames
  // live in (for clearing per-document highlights), and the current
  // position in the flattened order of all frames' matches.
  var st = window.__tabverseFind;
  if (!st || !st.frames) { st = window.__tabverseFind = { query: "", frames: [], docs: [], index: -1 }; }
  // Reports ride a token-LESS tabverse-cmd: navigation on purpose: this code
  // is readable by the page, so a token here would be a token leaked. A page
  // forging the report can only lie about its own match count. The counts
  // arrive per frame (one n= each), so the sum the core displays is the
  // main page plus same-origin embeds — never a cross-origin frame, which
  // this script cannot read and so cannot count.
  function report(counts, i) {
    var url = "tabverse-cmd:find-result?";
    for (var k = 0; k < counts.length; k++) url += "n=" + counts[k] + "&";
    url += "f=" + counts.length + "&i=" + i;
    try { window.location.href = url; } catch (e) {}
  }
  function docWindow(doc) {
    try { return doc.defaultView; } catch (e) { return null; }
  }
  function ensureStyle(doc) {
    if (doc.getElementById("__tabverse-find-style")) return;
    var s = doc.createElement("style");
    s.id = "__tabverse-find-style";
    s.textContent =
      "::highlight(tabverse-find){background-color:__TABVERSE_FIND_BG__;color:__TABVERSE_FIND_FG__;}" +
      "::highlight(tabverse-find-current){background-color:__TABVERSE_FIND_CUR_BG__;color:__TABVERSE_FIND_CUR_FG__;}";
    (doc.head || doc.documentElement).appendChild(s);
  }
  // Highlights are registered per document (CSS.highlights belongs to each
  // document's own window), so a frame whose count dropped to zero on a new
  // query must have its old registration deleted, not just skipped.
  function clearHighlights() {
    for (var d = 0; d < st.docs.length; d++) {
      var w = docWindow(st.docs[d]);
      if (w && w.CSS && w.CSS.highlights) {
        w.CSS.highlights.delete("tabverse-find");
        w.CSS.highlights.delete("tabverse-find-current");
      }
    }
  }
  // Matches within one document, unchanged from the top-frame-only days:
  // text nodes walked, the script/style family rejected, every hit a Range
  // so it can be highlighted, and only kept when it renders boxes.
  function collectDoc(doc) {
    var out = [];
    var root = doc.body;
    if (!root) return out;
    var needle = q.toLowerCase();
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentElement;
        return !p || SKIP[p.tagName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var hay = (node.nodeValue || "").toLowerCase();
      var at = hay.indexOf(needle);
      while (at !== -1) {
        var r = doc.createRange();
        r.setStart(node, at);
        r.setEnd(node, at + needle.length);
        // Text inside a hidden container renders no boxes. Checking matches
        // only is far cheaper than computing style for every node walked.
        if (r.getClientRects().length) out.push(r);
        at = hay.indexOf(needle, at + needle.length);
      }
    }
    return out;
  }
  function rebuild() {
    clearHighlights();
    st.query = q; st.frames = []; st.docs = []; st.index = -1;
    if (!q) return;
    // Depth-first from the top document. A same-origin iframe hands over its
    // contentDocument and is searched like any other part of the page; a
    // cross-origin one answers null (or throws), and the honest move is to
    // leave it out of both the count and the walk — the UI note on the
    // counter says exactly that scope.
    (function walk(doc) {
      st.docs.push(doc);
      st.frames.push(collectDoc(doc));
      var kids = doc.querySelectorAll("iframe");
      for (var i = 0; i < kids.length; i++) {
        var cd = null;
        try { cd = kids[i].contentDocument; } catch (e) { cd = null; }
        if (cd) walk(cd);
      }
    })(document);
  }
  if (q !== st.query) rebuild();
  var counts = [], flat = [];
  for (var k = 0; k < st.frames.length; k++) {
    counts.push(st.frames[k].length);
    for (var m = 0; m < st.frames[k].length; m++) flat.push(st.frames[k][m]);
  }
  var n = flat.length;
  var hl = window.CSS && CSS.highlights && typeof Highlight === "function";
  if (!n) {
    if (hl) {
      CSS.highlights.delete("tabverse-find");
      CSS.highlights.delete("tabverse-find-current");
    }
    report(counts.length ? counts : [0], 0);
    return;
  }
  // Fresh query lands on the first match; a repeat advances and wraps. The
  // index runs over the flattened order — top document first — so stepping
  // crosses frame boundaries as if the page were one document.
  st.index = st.index < 0 ? 0 : (back ? st.index + n - 1 : st.index + 1) % n;
  var cur = flat[st.index];
  if (hl) {
    // Highlight objects are set-likes; add() avoids spreading thousands of
    // ranges through one call's argument list. Each frame registers in its
    // own document, and only the frame owning the current match carries the
    // current-highlight; the others have any stale one deleted.
    var base = 0;
    for (var d = 0; d < st.frames.length; d++) {
      var w = docWindow(st.docs[d]);
      var fr = st.frames[d];
      if (!w || !w.CSS || !w.CSS.highlights || typeof w.Highlight !== "function") { base += fr.length; continue; }
      if (!fr.length) {
        // This frame has nothing to show: whatever an earlier query left
        // registered here is deleted, not replaced with an empty highlight.
        w.CSS.highlights.delete("tabverse-find");
        w.CSS.highlights.delete("tabverse-find-current");
        continue;
      }
      var all = new w.Highlight();
      for (var a = 0; a < fr.length; a++) all.add(fr[a]);
      w.CSS.highlights.set("tabverse-find", all);
      if (st.index >= base && st.index < base + st.frames[d].length) {
        var one = new w.Highlight();
        one.add(cur);
        w.CSS.highlights.set("tabverse-find-current", one);
      } else {
        w.CSS.highlights.delete("tabverse-find-current");
      }
      ensureStyle(st.docs[d]);
      base += fr.length;
    }
  } else {
    // No Custom Highlight API: select the current match so it is at least
    // visible — through the selection of the document that owns the range,
    // since a selection will not take a range from another document. The
    // count above works either way.
    var ow = docWindow(cur.startContainer.ownerDocument);
    var sel = ow && ow.getSelection ? ow.getSelection() : window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(cur); }
  }
  var el = cur.startContainer.parentElement;
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
  report(counts, st.index + 1);
})();"#;

fn find_script_for(query: &str, backwards: bool) -> String {
    // JSON-encode so arbitrary text cannot escape the JS string literal.
    let q = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".to_string());
    FIND_SCRIPT
        .replace(
            "__TABVERSE_BACK__",
            if backwards { "true" } else { "false" },
        )
        .replace("__TABVERSE_FIND_BG__", theme_gen::FIND_HL_BG)
        .replace("__TABVERSE_FIND_FG__", theme_gen::FIND_HL_FG)
        .replace("__TABVERSE_FIND_CUR_BG__", theme_gen::FIND_HL_CUR_BG)
        .replace("__TABVERSE_FIND_CUR_FG__", theme_gen::FIND_HL_CUR_FG)
        .replace("__TABVERSE_QUERY__", &q)
}

#[tauri::command]
fn browser_find(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    query: String,
    backwards: bool,
) -> Result<(), String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    let js = find_script_for(&query, backwards);
    wv.eval(js).map_err(|e| e.to_string())
}

/// Closing the find bar leaves no stale highlight or selection behind on the
/// page. The injected <style> stays — inert without registered highlights —
/// and the finder state resets so the next query starts fresh.
#[tauri::command]
fn browser_clear_find(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    wv.eval(
        r#"(function () {
  var st = window.__tabverseFind;
  if (st) { st.query = ""; st.ranges = []; st.index = -1; }
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete("tabverse-find");
    CSS.highlights.delete("tabverse-find-current");
  }
  var sel = window.getSelection();
  if (sel) sel.removeAllRanges();
})();"#,
    )
    .map_err(|e| e.to_string())
}

/// Hand the keyboard to the UI webview.
///
/// Needed whenever the UI opens an input while a page holds the keyboard —
/// the find bar summoned by ⌘F pressed *inside* the page, for instance.
#[tauri::command]
fn ui_focus(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview("main")
        .ok_or_else(|| "ui webview is gone".to_string())?;
    wv.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn browser_close(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let label = state.browsers.lock().unwrap().remove(&tab_id);
    #[cfg(target_os = "macos")]
    nav_failures::forget_tab(&tab_id);
    peek::forget_tab(&tab_id);
    // Injection nonces and the bootstrap mark die with the webview.
    userscripts::forget_tab(&tab_id);
    page_notify::forget_tab(&tab_id);
    if let (Some(label), Some(window)) = (label, app.get_window("main")) {
        if let Some(wv) = window.get_webview(&label) {
            let _ = wv.close();
        }
    }
    Ok(())
}

#[tauri::command]
fn browser_set_peek_anchor(tab_id: String, host: Option<String>) -> Result<(), String> {
    peek::set_anchor(&tab_id, host);
    Ok(())
}

/// Post an OS notification (long-running command finished while you were away).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    shell_integration: bool,
    home_dir: String,
    version: String,
}

/// What the settings tab needs to answer "why isn't this working".
#[tauri::command]
fn app_health() -> Health {
    let shell = std::env::var("SHELL").unwrap_or_default();
    let name = std::path::Path::new(&shell)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    Health {
        shell_integration: matches!(name.as_str(), "zsh" | "bash" | "fish" | "pwsh" | "pwsh.exe"),
        home_dir: home_dir(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
fn page_coverable() -> bool {
    is_coverable_platform()
}

/// The user's home directory, or `None` if the environment names none.
///
/// `HOME` is a Unix variable and Windows leaves it unset, putting the profile
/// path in `USERPROFILE` instead. Everything here that needs a home goes
/// through this one function, so a location that is right in the UI cannot be
/// wrong in a download path.
fn home_path() -> Option<std::path::PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(std::path::PathBuf::from)
}

#[tauri::command]
fn home_dir() -> String {
    // Through the same normalization as every other path the UI receives: the
    // frontend tests `cwd.startsWith(home)`, and a home with `\` against a
    // listing with `/` is a comparison that can never be true.
    home_path()
        .map(|p| tabverse_fs::ui_path(&p))
        .unwrap_or_else(|| "/".to_string())
}

#[tauri::command]
async fn remote_join(
    state: State<'_, AppState>,
    ticket: String,
    on_event: Channel<RemoteHostMsg>,
) -> Result<String, String> {
    let name = format!("tabverse@{}", hostname_lossy());
    let handle = join(
        &ticket,
        &name,
        Arc::new(move |msg| {
            let _ = on_event.send(msg);
        }),
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    let id = uuid_like();
    state
        .joins
        .lock()
        .unwrap()
        .insert(id.clone(), Arc::new(handle));
    eprintln!("[core] remote_join ok");
    Ok(id)
}

#[tauri::command]
fn remote_input(state: State<'_, AppState>, id: String, data_b64: String) -> Result<(), String> {
    let bytes = b64().decode(data_b64).map_err(|e| e.to_string())?;
    let joins = state.joins.lock().unwrap();
    let h = joins.get(&id).ok_or_else(|| "unknown join".to_string())?;
    h.send_input(&bytes);
    Ok(())
}

/// Report how many cells this viewer can display; the host shrinks to fit.
#[tauri::command]
fn remote_viewport(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let h = state
        .joins
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("unknown join {id}"))?;
    h.send_resize(cols, rows);
    Ok(())
}

#[tauri::command]
fn remote_ping(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let joins = state.joins.lock().unwrap();
    let h = joins.get(&id).ok_or_else(|| "unknown join".to_string())?;
    h.ping();
    Ok(())
}

#[tauri::command]
async fn remote_leave(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let handle = state.joins.lock().unwrap().remove(&id);
    if let Some(h) = handle {
        h.leave().await;
    }
    Ok(())
}

fn hostname_lossy() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown-host".to_string())
}

fn uuid_like() -> String {
    // System entropy, not a homegrown PRNG: one of these ids is the secret
    // that authenticates page→app shortcut reports, so it must not be
    // guessable from the process start time.
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A menu entry that forwards to the UI instead of doing anything native.
///
/// These exist for their key equivalents. A browser tab is a separate native
/// web view stacked over the window, and while a page has focus the UI's own
/// webview never receives a keydown — every window-level shortcut is dead
/// there, which is why ⌘L, ⌘T and ⌘W did nothing on a page. macOS offers the
/// main menu a key equivalent *before* it reaches any view, so routing these
/// through menu items is what makes them work everywhere, exactly as a real
/// browser does it.
///
/// THE KEY IS NOT WRITTEN HERE. It is asked of the composition (keys.rs),
/// which is the shipped table with the user's `[keys]` overlay on it. This
/// used to take an accelerator string per call site — twenty-nine of them,
/// hand-kept, and two of the three recorded drifts were an entry in that list
/// outliving the command it belonged to and holding its key hostage.
#[cfg(target_os = "macos")]
fn cmd_item(
    handle: &AppHandle,
    bindings: &keys::Bindings,
    id: &str,
    label: &str,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    let accel = bindings.accelerator(id);
    if accel.is_empty() {
        return tauri::menu::MenuItemBuilder::with_id(id, label).build(handle);
    }
    match tauri::menu::MenuItemBuilder::with_id(id, label)
        .accelerator(&accel)
        .build(handle)
    {
        Ok(item) => Ok(item),
        Err(e) => {
            // A shortcut that will not parse costs its shortcut, never the
            // launch: this runs inside setup(), where an Err aborts startup.
            eprintln!("menu: {id} keeps no accelerator ({accel}): {e}");
            tauri::menu::MenuItemBuilder::with_id(id, label).build(handle)
        }
    }
}

/// Custom menu: keep Edit (clipboard must work) but drop the default
/// File > Close Window so Cmd+W closes a *tab*.
///
/// Structure and labels are written here; every KEY comes from `bindings`.
/// Rebuilt in full when the user's keys change (`keys_apply`) rather than
/// re-accelerated item by item: the menu library's macOS backend takes a new
/// key equivalent but silently declines to CLEAR one, so an item that had a
/// key would keep it after being unbound. A whole new menu has no such hole,
/// and it is the same code path the first one came out of.
#[cfg(target_os = "macos")]
fn build_menu(handle: &AppHandle, bindings: &keys::Bindings) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(handle, "Tabverse")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(handle, "File")
        .item(&cmd_item(
            handle,
            bindings,
            "new-terminal",
            "New Terminal Tab",
        )?)
        .item(&cmd_item(
            handle,
            bindings,
            "new-files",
            "New File Explorer",
        )?)
        .item(&cmd_item(
            handle,
            bindings,
            "new-browser",
            "New Browser Tab",
        )?)
        .item(&cmd_item(handle, bindings, "new-tab-menu", "New Tab…")?)
        .separator()
        .item(&cmd_item(
            handle,
            bindings,
            "duplicate-tab",
            "Duplicate Tab",
        )?)
        .item(&cmd_item(
            handle,
            bindings,
            "reopen-closed",
            "Reopen Closed Tab",
        )?)
        .separator()
        .item(&cmd_item(handle, bindings, "join", "Join a Shared Tab…")?)
        .separator()
        .item(&cmd_item(
            handle,
            bindings,
            "open-external",
            "Open Page in Default Browser",
        )?)
        .item(&cmd_item(handle, bindings, "copy-url", "Copy Page Link")?)
        .separator()
        .item(&cmd_item(handle, bindings, "print", "Print…")?)
        .separator()
        .item(&cmd_item(handle, bindings, "close-tab", "Close Tab")?)
        .build()?;
    let edit = SubmenuBuilder::new(handle, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(handle, "View")
        .item(&cmd_item(
            handle,
            bindings,
            "toggle-sidebar",
            "Hide Sidebar",
        )?)
        .separator()
        .item(&cmd_item(
            handle,
            bindings,
            "location-bar",
            "Address / Location…",
        )?)
        .item(&cmd_item(handle, bindings, "find", "Find…")?)
        .item(&cmd_item(handle, bindings, "reload", "Reload Page")?)
        .separator()
        .item(&cmd_item(handle, bindings, "history-panel", "History…")?)
        .item(&cmd_item(
            handle,
            bindings,
            "downloads-panel",
            "Downloads…",
        )?)
        .separator()
        .item(&cmd_item(handle, bindings, "zoom-in", "Zoom In")?)
        .item(&cmd_item(handle, bindings, "zoom-out", "Zoom Out")?)
        .item(&cmd_item(handle, bindings, "zoom-reset", "Actual Size")?)
        .separator()
        // Native macOS fullscreen removes the titlebar and therefore the
        // traffic lights. Use the simple mode command so fullscreen keeps the
        // window chrome visible.
        .item(
            &tauri::menu::MenuItemBuilder::with_id("toggle-fullscreen", "Toggle Full Screen")
                .accelerator("CmdOrCtrl+Ctrl+F")
                .build(handle)?,
        )
        .build()?;
    let history = SubmenuBuilder::new(handle, "History")
        .item(&cmd_item(handle, bindings, "back", "Back")?)
        .item(&cmd_item(handle, bindings, "forward", "Forward")?)
        .build()?;
    let window = SubmenuBuilder::new(handle, "Window")
        .item(&cmd_item(handle, bindings, "command-bar", "Command Bar…")?)
        .item(&cmd_item(handle, bindings, "switcher", "Switch Tab…")?)
        .item(&cmd_item(
            handle,
            bindings,
            "clear-terminal",
            "Clear Terminal",
        )?)
        .item(&cmd_item(handle, bindings, "next-tab", "Next Tab")?)
        .item(&cmd_item(handle, bindings, "prev-tab", "Previous Tab")?)
        .separator()
        .item(&cmd_item(
            handle,
            bindings,
            "toggle-pin",
            "Pin / Unpin Tab",
        )?)
        .separator()
        .minimize()
        .maximize()
        .build()?;
    let help = SubmenuBuilder::new(handle, "Help")
        .item(&cmd_item(
            handle,
            bindings,
            "shortcuts-help",
            "Keyboard Shortcuts",
        )?)
        .build()?;
    let menu = tauri::menu::MenuBuilder::new(handle)
        .items(&[&app_menu, &file, &edit, &view, &history, &window, &help])
        .build()?;
    handle.set_menu(menu)?;
    Ok(())
}

/// Take a new key overlay from the interface and put the menu on it.
///
/// The other two consumers on this side need no call: a page created from now
/// on is injected with a script serialized from the same composition, and a
/// page already open keeps the one it was created with — the delay the
/// settings screen states.
///
/// Menu work is main-thread-only on macOS while commands run on a worker, so
/// the rebuild is handed over rather than attempted here.
#[tauri::command]
async fn keys_apply(
    app: AppHandle,
    overrides: std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    if !keys::set_overrides(&overrides) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let bindings = keys::current();
            if let Err(e) = build_menu(&handle, &bindings) {
                eprintln!("menu: rebuild after a key change failed: {e}");
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

/// Serve local files to the webview so images, PDFs, audio and video render
/// with the platform's own viewers — no JS decoders bundled, and relative
/// references inside a served document still resolve.
fn serve_file(req: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::http::{Response, StatusCode};

    let uri = req.uri().to_string();
    // tabverse-file://localhost/<percent-encoded-abs-path>
    let raw_path = uri
        .split_once("://")
        .map(|(_, rest)| rest)
        .and_then(|rest| rest.split_once('/'))
        .map(|(_, p)| p.to_string())
        .unwrap_or_default();
    let raw_path = raw_path.split('?').next().unwrap_or("").to_string();
    let decoded = percent_decode(&raw_path);
    let path = tabverse_fs::expand_path(&format!("/{}", decoded.trim_start_matches('/')));

    let not_found = |msg: &str| {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Content-Type", "text/plain")
            .body(msg.as_bytes().to_vec())
            .unwrap()
    };

    let Ok(meta) = std::fs::metadata(&path) else {
        return not_found("no such file");
    };
    if !meta.is_file() {
        return not_found("not a file");
    }
    let total = meta.len();
    let Ok(mut file) = std::fs::File::open(&path) else {
        return not_found("cannot read file");
    };

    // Sniff the mime from the head only — never the whole file.
    let mut head = vec![0u8; 4096.min(total as usize)];
    if file.read_exact(&mut head).is_err() {
        return not_found("cannot read file");
    }
    let (_, mime) = tabverse_fs::kind_for(&path, &head);

    // Ranges matter for media: WKWebView's players seek by asking for byte
    // ranges, and advertising Accept-Ranges: none forced a full-file fetch
    // per seek (and this handler used to read the whole file into memory).
    let range = req
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_byte_range(v, total));

    let (status, start, len) = match range {
        Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        None => (StatusCode::OK, 0, total),
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return not_found("cannot seek file");
    }
    let mut body = vec![0u8; len as usize];
    if file.read_exact(&mut body).is_err() {
        return not_found("cannot read file");
    }

    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-store")
        .header("Accept-Ranges", "bytes");
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            "Content-Range",
            format!("bytes {}-{}/{}", start, start + len - 1, total),
        );
    }
    builder.body(body).unwrap()
}

/// `bytes=a-b` → inclusive (a, b), clamped to the file. Open-ended `bytes=a-`
/// and suffix `bytes=-n` forms included; anything else means "no range".
fn parse_byte_range(header: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = header.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    match (a.is_empty(), b.is_empty()) {
        (false, false) => {
            let start: u64 = a.parse().ok()?;
            let end: u64 = b.parse().ok()?;
            (start <= end && start < total).then(|| (start, end.min(total - 1)))
        }
        (false, true) => {
            let start: u64 = a.parse().ok()?;
            (start < total).then(|| (start, total - 1))
        }
        (true, false) => {
            let n: u64 = b.parse().ok()?;
            (n > 0).then(|| (total.saturating_sub(n), total - 1))
        }
        (true, true) => None,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn run() {
    // The resident helper is the same signed executable in a windowless mode.
    // It answers before Tauri, plugins, HTTP clients, or webviews exist.
    if let Some(code) = terminal_helper::from_args(std::env::args().skip(1)) {
        std::process::exit(code);
    }
    if let Some(code) = config::validate_from_args(std::env::args().skip(1)) {
        std::process::exit(code);
    }
    http::ensure_crypto_provider();
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        // Asynchronous + blocking pool: this handler reads user files, and a
        // large video read on the main thread would freeze every terminal —
        // the same rule the fs commands follow.
        .register_asynchronous_uri_scheme_protocol("tabverse-file", |_ctx, req, responder| {
            // Threat model: this scheme serves arbitrary local files to the
            // app's own pages. A remote http(s) page rendered anywhere in the
            // app (an embedded browser view, a previewed HTML document) must
            // not be able to probe local files by embedding tabverse-file:// URLs.
            // Subresource requests initiated by a web page carry an Origin or
            // Referer header naming that page; top-level navigations and
            // requests from local/app pages carry neither. So: any request
            // arriving with a web origin is refused before touching the disk.
            let web_origin = ["origin", "referer"].iter().find_map(|name| {
                req.headers()
                    .get(*name)
                    .and_then(|v| v.to_str().ok())
                    .filter(|v| v.starts_with("http://") || v.starts_with("https://"))
                    .map(|v| v.to_string())
            });
            if let Some(origin) = web_origin {
                eprintln!("[core] tabverse-file denied origin={origin}");
                responder.respond(
                    tauri::http::Response::builder()
                        .status(tauri::http::StatusCode::FORBIDDEN)
                        .header("Content-Type", "text/plain")
                        .body(b"tabverse-file: refused for web origins".to_vec())
                        .unwrap(),
                );
                return;
            }
            tauri::async_runtime::spawn_blocking(move || responder.respond(serve_file(req)));
        })
        // Menu key equivalents are the only shortcuts that survive a focused
        // page, so the UI hears about them the same way either route arrives.
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "toggle-fullscreen" {
                if let Some(window) = app.get_window("main") {
                    if let Err(e) = toggle_simple_fullscreen(window) {
                        eprintln!("[window] simple fullscreen failed: {e}");
                    }
                }
                return;
            }
            // Logged so a shortcut's route is visible: a page can claim a key
            // equivalent before the menu ever sees it, and which of the two
            // fired is otherwise indistinguishable from the outside.
            eprintln!("[core] shortcut from menu: {}", event.id().as_ref());
            let _ = app.emit(
                "app-command",
                AppCommandEvent {
                    cmd: event.id().as_ref().to_string(),
                    from: "menu",
                },
            );
        })
        .on_window_event(|_window, _event| {
            #[cfg(target_os = "macos")]
            if _window.label() == "main"
                && matches!(
                    _event,
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true)
                )
            {
                let window = _window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    reapply_traffic_light_position(window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
                });
            }
        })
        .manage(AppState {
            helper: terminal_helper::TerminalHelper::new(),
            resident: resident::ResidentBridge::new(),
            hub: RemoteHub::new(),
            bridges: Arc::new(Mutex::new(HashMap::new())),
            helper_backlog: Arc::new(Mutex::new(HashMap::new())),
            helper_generations: Arc::new(Mutex::new(HashMap::new())),
            sources: Arc::new(SourceRegistry::default()),
            share_glue: Arc::new(share_commands::ShareGlue::default()),
            joins: Mutex::new(HashMap::new()),
            fs: Arc::new(FsBackend::new()),
            browsers: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashSet::new()),
            watches: fs_watch::WatchState::new(),
            page_proxy: Mutex::new(PageProxySlot::default()),
            app_source: app_share::AppShareSource::new(
                // dispatch_action: the webview applies it and broadcasts
                // back (see the module doc for why Rust holds no reducer).
                // A no-op until app_share_start hands the source the app
                // handle (set_dispatch_channel) — before that there is no
                // share for a viewer's action to arrive on.
                Arc::new(|_name: &str, _args: &serde_json::Value| {}),
                Arc::new(|| serde_json::json!({"tabs": []})),
                // write_clipboard: a joiner's ClipPush lands on the
                // general pasteboard — the same board the watcher walks,
                // so every other viewer hears it in the same stroke.
                Arc::new(|text: &str| clipboard_watch::put_string(text)),
                Arc::new(remote_proxy::run),
            ),
        })
        // Holds whatever the system asked us to open before the interface
        // existed to receive it (system_open.rs).
        .manage(system_open::Pending::default())
        .setup(|app| {
            {
                let main_cfg = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|w| w.label == "main")
                    .cloned()
                    .ok_or("no main window in tauri.conf.json")?;
                #[cfg(target_os = "macos")]
                let mut main_cfg = main_cfg;
                // AP-12 needs a real WebView/process measurement without
                // repeatedly stealing the user's desktop. The ordinary app
                // never sets this test-only environment switch.
                #[cfg(target_os = "macos")]
                let hidden_acceptance =
                    std::env::var_os("TABVERSE_HIDDEN_WINDOW_ACCEPTANCE").is_some();
                #[cfg(target_os = "macos")]
                if hidden_acceptance {
                    app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
                    main_cfg.visible = false;
                }
                #[cfg(target_os = "macos")]
                let traffic_light_position = main_cfg.traffic_light_position.clone();
                let mut wb = tauri::WebviewWindowBuilder::from_config(app.handle(), &main_cfg)?;
                let pref = theme_preference(app.handle());
                if theme_gen::theme(&pref).is_some() {
                    wb = wb.initialization_script(format!(
                        "window.__TABVERSE_BOOT_THEME__ = \"{pref}\";"
                    ));
                }
                // The settings the interface needs before it can paint anything,
                // handed over the same way the theme is. A store that has to wait
                // for a command round trip would need its own copy of every
                // default to show in the meantime, and a second copy of a default
                // is exactly what the registry exists to abolish. A load failure
                // injects nothing: the interface then knows the values are not
                // ready and asks config_get, which reports the error properly.
                if let Ok(loaded) = config::load() {
                    if let Ok(json) = serde_json::to_string(&loaded.config) {
                        wb = wb.initialization_script(format!(
                            "window.__TABVERSE_BOOT_CONFIG__ = {json};"
                        ));
                    }
                }
                let _main_window = wb.build()?;
                #[cfg(target_os = "macos")]
                if hidden_acceptance {
                    _main_window.hide()?;
                }
                #[cfg(target_os = "macos")]
                if let (Some(window), Some(position)) =
                    (app.get_window("main"), traffic_light_position)
                {
                    let delayed_window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                        reapply_traffic_light_position(delayed_window, position.x, position.y);
                    });
                }
            }
            #[cfg(target_os = "macos")]
            build_menu(app.handle(), &keys::current())?;
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            // Synchronous on purpose: setup completes before any command can
            // run, and that ordering is what keeps a restored browser tab's
            // first request from racing the session-cookie restore.
            // Before anything asks for a saved login: the encrypted store
            // has to know where it lives.
            match state_dir(app.handle()) {
                Ok(dir) => credentials::set_vault_dir(dir),
                Err(e) => eprintln!("[credentials] no state dir, logins unavailable: {e}"),
            }
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_window("main") {
                    let pref = theme_preference(app.handle());
                    let backdrop = match theme_gen::theme(&pref) {
                        Some(t) => &t.backdrop,
                        None => theme_gen::backdrop(
                            window
                                .theme()
                                .map(|t| t == tauri::Theme::Dark)
                                .unwrap_or(true),
                        ),
                    };
                    if let Err(e) = apply_backdrop(&window, backdrop) {
                        eprintln!("[ui-plane] window backdrop: {e}");
                    }
                    if let Some(wv) = window.get_webview("main") {
                        if let Err(e) = ui_plane::set_app_plane_transparent(&wv, true) {
                            eprintln!("[ui-plane] transparent: {e}");
                        }
                    }
                }
            }
            cookies::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            term_create,
            term_write,
            term_resize,
            term_kill,
            term_detach,
            term_attach,
            term_helper_list,
            term_resident_list,
            term_helper_kill_all,
            resident::resident_descriptor,
            resident::resident_ensure,
            resident::resident_list,
            resident::resident_attach,
            resident::resident_poll,
            resident::resident_intent,
            resident::resident_detach,
            resident::resident_stop,
            home_dir,
            app_health,
            page_coverable,
            notify,
            js_log,
            traffic_light_reapply,
            share_commands::share_start,
            share_commands::app_share_start,
            share_commands::app_share_stop,
            share_commands::app_share_snapshot_deliver,
            share_commands::app_share_contribution_snapshot,
            share_commands::app_share_contribution_frame,
            share_commands::app_share_intent_result,
            share_commands::app_share_private_stream,
            share_commands::app_share_set_active_tab,
            share_commands::app_share_term_snapshot,
            share_commands::app_share_broadcast_action,
            share_commands::share_snapshot,
            share_commands::share_kick,
            share_commands::share_set_viewer_access,
            share_commands::share_stop,
            remote_join,
            remote_input,
            remote_viewport,
            remote_ping,
            remote_leave,
            fs_list,
            fs_read,
            fs_write,
            fs_reveal,
            download_open,
            fs_walk,
            fs_transfer,
            fs_grep,
            fs_replace,
            fs_replace_preview,
            fs_changes,
            fs_create,
            fs_rename,
            fs_trash,
            fs_inspect,
            fs_sqlite_rows,
            fs_archive_create,
            fs_archive_extract,
            fs_read_range,
            fs_watch_start,
            fs_watch_stop,
            file_clipboard::clipboard_write_files,
            state_save,
            state_load,
            state_delete,
            state_list,
            state_migrate_session_v2,
            state_restore_session_backup,
            set_theme,
            theme_pref_save,
            theme_pref_load,
            browser_create,
            browser_find,
            browser_clear_find,
            ui_focus,
            browser_set_bounds,
            browser_set_peek_anchor,
            browser_navigate,
            browser_zoom,
            browser_set_muted,
            browser_print,
            browser_probe,
            browser_open_external,
            browser_auth_answer,
            window_buttons,
            browser_release_hover,
            ui_plane_set,
            browser_plane_raise,
            browser_snapshot,
            pw_authorize_view,
            pw_reveal,
            pw_authorize_export,
            pw_forget_all,
            pw_export,
            pw_import,
            migrate_authorize_export,
            migrate_export,
            migrate_import_check,
            migrate_import_apply,
            browser_dialog_answer,
            browser_ask_unload,
            trusted_hosts::trust_certificate_host,
            trusted_hosts::list_trusted_hosts,
            trusted_hosts::revoke_trusted_host,
            page_prompts::media_list,
            page_prompts::media_revoke,
            passwords::pw_offer_save,
            passwords::pw_offer_dismiss,
            passwords::pw_list,
            passwords::pw_delete,
            passwords::pw_fill,
            browser_close,
            favicon::favicon_lookup,
            userscripts::userscripts_list,
            userscripts::userscript_install_url,
            userscripts::userscript_install_file,
            userscripts::userscript_remove,
            userscripts::userscript_set_enabled,
            userscripts::userscript_revoke_grant,
            userscripts::userscript_menu_click,
            userscripts::userscript_xhr_answer,
            userscripts::userscript_check_update,
            userscripts::userscript_apply_update,
            completions::completions_get,
            completions::completions_update,
            default_apps::default_apps_status,
            default_apps::default_apps_set,
            config::config_get,
            config::config_set,
            config::config_reset,
            config::config_schema,
            config::config_key_set,
            config::config_key_reset,
            config::config_keys_clear,
            config::config_files_set,
            profiles::config_profile_set,
            profiles::config_profile_remove,
            templates::config_template_set,
            templates::config_template_remove,
            keys_apply,
            transfer::transfer_pull,
            transfer::transfer_push,
            system_open::system_open_drain
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // ⌘Q is how people actually quit a Mac app, and it exits the
            // process without ever asking the window to close — so the UI's
            // "flush pending state, then close" handler never ran and the
            // last few hundred milliseconds of work died with the process.
            // Routing quit through the window's close path gives that
            // handler its turn; it destroys the window when the flush is
            // done, which ends the app for real.
            // Double-clicked files and clicked links arrive together here,
            // as file:// and https:// URLs. Cold start delivers this *before*
            // the interface can listen, which is why system_open buffers as
            // well as broadcasts.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { ref urls } = event {
                system_open::receive(app, urls);
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // code.is_some() means someone called exit() deliberately
                // (including the teardown that follows our own close), so
                // only a user-initiated quit is redirected — otherwise this
                // would loop forever and the app could never exit.
                if code.is_none() {
                    api.prevent_exit();
                    // Best-effort last snapshot while the webviews still
                    // exist; the close below gives the worker a moment (the
                    // UI's flush window) but does not wait for it. Anything
                    // missed was already covered by the per-page-load
                    // snapshots, except a login in the final seconds.
                    cookies::request_snapshot();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.close();
                    }
                }
            }
        });
}

#[cfg(test)]
mod helper_route_tests {
    use super::*;
    struct CaptureSink {
        bytes: Arc<Mutex<Vec<u8>>>,
        exits: Arc<Mutex<Vec<Option<i32>>>>,
    }
    impl LocalSink for CaptureSink {
        fn data(&self, b: &[u8]) {
            self.bytes.lock().unwrap().extend_from_slice(b)
        }
        fn exit(&self, c: Option<i32>) {
            self.exits.lock().unwrap().push(c)
        }
        fn snapshot_request(&self, _: u64) {}
    }
    #[test]
    fn early_helper_events_wait_for_bridge_then_arrive_in_order() {
        let bridges = Arc::new(Mutex::new(HashMap::new()));
        let backlog = Arc::new(Mutex::new(HashMap::new()));
        let session = HelperSessionId([0x33; 16]);
        let id = session.to_hex();
        deliver_helper_frame(
            &bridges,
            &backlog,
            HelperFrame::new(HelperKind::Output, session, 1, b"early-".to_vec()),
        );
        deliver_helper_frame(
            &bridges,
            &backlog,
            HelperFrame::new(HelperKind::Output, session, 1, b"bytes".to_vec()),
        );
        assert_eq!(backlog.lock().unwrap().get(&id).unwrap().len(), 2);
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let exits = Arc::new(Mutex::new(Vec::new()));
        bridges.lock().unwrap().insert(
            id.clone(),
            SessionBridge::new(Arc::new(CaptureSink {
                bytes: Arc::clone(&bytes),
                exits: Arc::clone(&exits),
            })),
        );
        flush_helper_backlog(&bridges, &backlog, &id);
        assert_eq!(&*bytes.lock().unwrap(), b"early-bytes");
        assert!(backlog.lock().unwrap().get(&id).is_none());
        deliver_helper_frame(
            &bridges,
            &backlog,
            HelperFrame::new(HelperKind::Exit, session, 1, br#"{"code":7}"#.to_vec()),
        );
        assert_eq!(&*exits.lock().unwrap(), &[Some(7)]);
    }

    #[test]
    fn helper_backlog_is_bounded_and_keeps_exit() {
        let bridges = Arc::new(Mutex::new(HashMap::new()));
        let backlog = Arc::new(Mutex::new(HashMap::new()));
        let session = HelperSessionId([0x44; 16]);
        let id = session.to_hex();
        for _ in 0..(HELPER_BACKLOG_MAX_FRAMES + 200) {
            deliver_helper_frame(
                &bridges,
                &backlog,
                HelperFrame::new(HelperKind::Output, session, 1, vec![0; 1024]),
            );
        }
        deliver_helper_frame(
            &bridges,
            &backlog,
            HelperFrame::new(HelperKind::Exit, session, 1, br#"{"code":0}"#.to_vec()),
        );
        let held = backlog.lock().unwrap();
        let frames = held.get(&id).unwrap();
        assert!(frames.len() <= HELPER_BACKLOG_MAX_FRAMES);
        assert!(
            frames
                .iter()
                .map(|frame| frame.payload.len())
                .sum::<usize>()
                <= HELPER_BACKLOG_MAX_BYTES
        );
        assert!(frames.iter().any(|frame| frame.kind == HelperKind::Exit));
    }
}

#[cfg(test)]
mod page_coverage_tests {
    #[cfg(target_os = "macos")]
    use super::is_coverable_platform;
    use super::{macos_version_coverable, page_proxy_url, slot_page_proxy_url, PageProxySlot};
    use crate::http::DnsPolicy;

    #[test]
    fn only_all_three_conditions_hand_the_builder_a_proxy() {
        let doh = DnsPolicy::Doh("https://doh.example/dns-query".to_string());
        // The one covered combination.
        assert_eq!(
            page_proxy_url(true, &doh, true, 49152),
            Some("http://127.0.0.1:49152".to_string())
        );
        // The switch off — the default state of the whole feature.
        assert_eq!(
            page_proxy_url(false, &doh, true, 49152),
            None,
            "the switch is off"
        );
        // The System arm: no endpoint to route pages through.
        assert_eq!(
            page_proxy_url(true, &DnsPolicy::System, true, 49152),
            None,
            "the policy resolves through the system"
        );
        // Outside the platform gate: macOS older than 14.
        assert_eq!(
            page_proxy_url(true, &doh, false, 49152),
            None,
            "the platform gate is closed"
        );
        // The remaining combinations, each with two conditions false.
        assert_eq!(page_proxy_url(false, &DnsPolicy::System, true, 49152), None);
        assert_eq!(page_proxy_url(false, &doh, false, 49152), None);
        assert_eq!(page_proxy_url(true, &DnsPolicy::System, false, 49152), None);
        assert_eq!(
            page_proxy_url(false, &DnsPolicy::System, false, 49152),
            None
        );
    }

    /// The address is the proxy's own port, loopback, scheme included — the
    /// exact shape WebviewBuilder's proxy_url wants and a page can use.
    #[test]
    fn the_address_names_the_proxys_loopback_port() {
        let doh = DnsPolicy::Doh("https://doh.example/dns-query".to_string());
        assert_eq!(
            page_proxy_url(true, &doh, true, 8080),
            Some("http://127.0.0.1:8080".to_string())
        );
    }

    #[test]
    fn a_running_slot_whose_listener_died_hands_a_new_tab_nothing() {
        let doh = DnsPolicy::Doh("https://doh.example/dns-query".to_string());
        let live = crate::page_proxy::PageProxy::start(|| {}).expect("the proxy starts");
        let live_slot = PageProxySlot::Running(live);
        assert!(
            slot_page_proxy_url(&live_slot, true, &doh, true).is_some(),
            "a live listener must hand its address to a covered tab"
        );
        drop(live_slot);

        let mut dead = crate::page_proxy::PageProxy::start(|| {}).expect("the proxy starts");
        dead.stop();
        let dead_slot = PageProxySlot::Running(dead);
        assert!(
            slot_page_proxy_url(&dead_slot, true, &doh, true).is_none(),
            "a dead listener must not be handed to a new tab — the slot still \
             says Running, but the port answers nobody; the tab must resolve \
             through the system, not be pointed at a corpse"
        );
    }

    /// The macOS gate's boundary, on injected (major, minor): 14.0 is the
    /// first version inside, everything 13.x — including the last of the
    /// line — stays outside, and the versions this app actually ships on
    /// are well inside.
    #[test]
    fn the_macos_gate_opens_at_fourteen_zero() {
        assert!(!macos_version_coverable(0, 0), "no answer is no gate");
        assert!(!macos_version_coverable(13, 0), "macOS 13 is outside");
        assert!(
            !macos_version_coverable(13, 9),
            "the last 13 is still outside"
        );
        assert!(macos_version_coverable(14, 0), "14.0 is the first inside");
        assert!(macos_version_coverable(14, 1));
        assert!(macos_version_coverable(15, 0));
        assert!(macos_version_coverable(26, 0));
    }

    /// One live probe, on this machine: the NSProcessInfo plumbing must
    /// actually answer, and the machines this suite runs on are macOS 14
    /// or newer, so the answer here must be "in". A broken probe reads as
    /// 0.0 and fails here — rather than quietly gating every Mac out of
    /// the feature.
    #[test]
    #[cfg(target_os = "macos")]
    fn this_machine_probes_as_coverable() {
        assert!(
            is_coverable_platform(),
            "this suite runs on macOS 14+, so the probe must find the gate open"
        );
    }
}

#[cfg(test)]
mod find_frames_tests {
    use super::theme_gen;
    use super::{find_script_for, parse_find_counts};

    #[test]
    fn the_total_is_the_sum_of_every_frames_count() {
        // Top frame 2, a same-origin child 0, a nested one 3: the bar shows
        // 5 of 7 matches across 3 frames. A zero-count frame still reports
        // and still counts as searched — the frame count is a scope fact,
        // not a hit fact.
        assert_eq!(parse_find_counts("n=2&n=0&n=3&f=3&i=4"), Some((5, 4, 3)));
    }

    #[test]
    fn a_single_frame_report_is_the_degenerate_case() {
        // The one-frame page reports one n; the sum is that n.
        assert_eq!(parse_find_counts("n=7&f=1&i=7"), Some((7, 7, 1)));
        // f is advisory: a report without it parses the same.
        assert_eq!(parse_find_counts("n=7&i=7"), Some((7, 7, 1)));
    }

    #[test]
    fn a_malformed_count_drops_the_whole_report() {
        // Same strictness the single-frame parser had: no guesses, no
        // partial sums. The navigation is still cancelled by the caller.
        assert_eq!(parse_find_counts("n=7&n=x&i=1"), None);
        assert_eq!(parse_find_counts("n=7"), None);
        assert_eq!(parse_find_counts("i=7"), None);
        assert_eq!(parse_find_counts(""), None);
    }

    #[test]
    fn a_query_spelling_a_placeholder_cannot_corrupt_the_script() {
        // QUERY is replaced LAST (see find_script_for): the replacement
        // text is never rescanned, so the literal colour placeholders a
        // hostile query carries must arrive as inert text inside the
        // JSON-encoded string, not as live placeholders the earlier
        // passes would have filled.
        let evil = "__TABVERSE_FIND_BG__\"); alert(1); //";
        let js = find_script_for(evil, false);
        // The placeholder for the query itself is gone — it was filled.
        assert!(!js.contains("__TABVERSE_QUERY__"));
        // The evil spelling survives verbatim, JSON-escaped, exactly once —
        // the earlier colour replacements did not touch it.
        let expected = serde_json::to_string(evil).unwrap();
        assert_eq!(js.matches(expected.as_str()).count(), 1);
        // And the real colour slot was filled with the token value, not
        // with anything the query contributed.
        assert!(js.contains(theme_gen::FIND_HL_BG));
    }
}

#[cfg(test)]
mod injected_script_derives_its_keys {
    use super::{keys, shortcut_script_for};
    use std::collections::BTreeMap;

    fn with(overrides: &[(&str, &str)]) -> String {
        let map: BTreeMap<String, String> = overrides
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        shortcut_script_for(&keys::resolve(&map))
    }

    #[test]
    fn the_tab_cycle_follows_the_table_rather_than_a_line_in_this_file() {
        let shipped = with(&[]);
        assert!(
            shipped.contains(r#"var CYCLE = {cmd:false,ctrl:true,alt:false,key:"tab"}"#),
            "the shipped cycle chord is not serialized into the script"
        );

        // Rebound onto a different modifier and a different key. A
        // hand-written test for ctrl and "Tab" passes every other assertion
        // about this script and fails both of these.
        let moved = with(&[("cycle-tabs", "⌥`")]);
        assert!(
            moved.contains(r#"var CYCLE = {cmd:false,ctrl:false,alt:true,key:"`"}"#),
            "the script did not follow the rebinding"
        );
        assert!(
            !moved.contains(r#"key:"tab""#),
            "the script still answers the key the user moved away from"
        );

        // Unbound: the object is null, and the comparison is written to test
        // it before dereferencing it.
        assert!(
            with(&[("cycle-tabs", "")]).contains("var CYCLE = null"),
            "an unbound cycle should leave the script with nothing to match"
        );
    }

    #[test]
    fn no_key_is_compared_against_a_literal_in_the_script() {
        let script = with(&[]);
        // What a hand-written copy looks like: an event's key compared with a
        // key name this file spelled. Every legitimate comparison in the
        // script is against a value that came out of the composition
        // (CYCLE.key, or a table lookup), so the shape below is absent.
        for written in [r#"e.key === "Tab""#, r#"e.key == "Tab""#] {
            assert!(
                !script.contains(written),
                "the script compares a key against a literal: {written}"
            );
        }
        // The control, so that "contains nothing" cannot pass by the script
        // having become empty: it still answers keys, through the two tables
        // and the one chord.
        assert!(script.contains("var PLAIN = {"), "the plain table is gone");
        assert!(
            script.contains("CYCLE.key"),
            "the cycle chord is not consulted"
        );
    }
}

#[cfg(test)]
mod theme_gen_drift {
    use super::{is_theme_preference, theme_gen};

    // The path build.rs reads, resolved from this source file instead of
    // OUT_DIR, so the test cannot accidentally bless the generated copy.
    const TOKENS: &str = include_str!("../../packages/workbench/src/theme/tokens.json");

    fn tokens() -> serde_json::Value {
        serde_json::from_str(TOKENS).expect("tokens.json is not valid JSON")
    }

    /// One channel of "#rrggbb" as the exact fraction build.rs emits
    /// (u8 / 255.0), so equality below is bitwise, not approximate.
    fn channel(hex: &str, i: usize) -> f64 {
        assert!(
            hex.len() == 7 && hex.starts_with('#'),
            "theme bg {hex:?} is not a #rrggbb color"
        );
        u8::from_str_radix(&hex[1 + 2 * i..3 + 2 * i], 16).unwrap() as f64 / 255.0
    }

    /// The generated table is tokens.json, theme for theme — including any
    /// theme added since this test was written. A generator that quietly
    /// stopped at the two built-ins would leave the new rows missing, which
    /// the count assertion is here to catch; a generator that mangled a
    /// value would leave the channels wrong, which the loop catches.
    #[test]
    fn every_theme_in_tokens_json_has_a_generated_row() {
        let t = tokens();
        let themes = t["themes"].as_object().expect("themes is an object");
        assert_eq!(
            theme_gen::THEMES.len(),
            themes.len(),
            "the generated table has {} rows for {} themes in tokens.json",
            theme_gen::THEMES.len(),
            themes.len()
        );
        for (id, theme) in themes {
            let got =
                theme_gen::theme(id).unwrap_or_else(|| panic!("no generated row for theme {id:?}"));
            let bg = theme["color"]["bg"]
                .as_str()
                .unwrap_or_else(|| panic!("tokens.json has no themes.{id}.color.bg"));
            for (ch, want, have) in [
                ("r", channel(bg, 0), got.backdrop.r),
                ("g", channel(bg, 1), got.backdrop.g),
                ("b", channel(bg, 2), got.backdrop.b),
            ] {
                assert_eq!(
                    have, want,
                    "THEMES[{id:?}].backdrop.{ch} drifted from themes.{id}.color.bg = {bg}"
                );
            }
            assert_eq!(
                got.dark,
                theme["appearance"] == "dark",
                "THEMES[{id:?}].dark disagrees with themes.{id}.appearance"
            );
        }
    }

    /// "system" can only ever land on one of the two built-ins, because the
    /// OS reports an appearance and not a theme. Both must therefore exist.
    #[test]
    fn the_two_builtin_themes_back_the_system_preference() {
        let t = tokens();
        for (id, dark) in [("dark", true), ("light", false)] {
            let entry = theme_gen::theme(id)
                .unwrap_or_else(|| panic!("the built-in theme {id:?} is missing"));
            assert_eq!(entry.dark, dark, "{id} appearance");
            let bg = t["themes"][id]["color"]["bg"].as_str().expect("bg");
            assert_eq!(
                theme_gen::backdrop(dark).r,
                channel(bg, 0),
                "{id} backdrop.r"
            );
        }
    }

    /// A theme id nobody declared never reaches the paint path — the lookup
    /// is what turns a string from disk into something paintable, and it has
    /// to come back empty for a string that names nothing.
    #[test]
    fn an_undeclared_theme_id_has_no_row() {
        for bad in ["", "Dark", "sunset", "system", "light "] {
            assert!(
                theme_gen::theme(bad).is_none(),
                "{bad:?} resolved to a theme row"
            );
        }
    }

    #[test]
    fn a_theme_preference_is_system_or_a_declared_theme() {
        assert!(is_theme_preference("system"));
        for id in theme_gen::THEMES.iter().map(|t| t.id) {
            assert!(
                is_theme_preference(id),
                "{id} is not accepted as a preference"
            );
        }
        for bad in ["", "System", "sunset", "dark "] {
            assert!(!is_theme_preference(bad), "{bad:?} was accepted");
        }
    }

    #[test]
    fn find_highlight_matches_tokens_json() {
        let t = tokens();
        for (name, key, got) in [
            ("FIND_HL_BG", "bg", theme_gen::FIND_HL_BG),
            ("FIND_HL_FG", "fg", theme_gen::FIND_HL_FG),
            ("FIND_HL_CUR_BG", "currentBg", theme_gen::FIND_HL_CUR_BG),
            ("FIND_HL_CUR_FG", "currentFg", theme_gen::FIND_HL_CUR_FG),
        ] {
            let want = t["shared"]["findHighlight"][key]
                .as_str()
                .unwrap_or_else(|| panic!("tokens.json has no shared.findHighlight.{key}"));
            assert_eq!(got, want, "{name} drifted from shared.findHighlight.{key}");
        }
    }
}

#[cfg(test)]
mod theme_preference_read {
    use super::theme_preference_in;
    use std::path::PathBuf;

    // Same sandbox convention as tabverse-fs's own state tests: a pid-tagged
    // dir under the OS temp dir, removed at the end of each test.
    fn dir_with(tag: &str, contents: Option<&str>) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tabverse-theme-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(json) = contents {
            std::fs::write(dir.join("theme.json"), json).unwrap();
        }
        dir
    }

    #[test]
    fn explicit_preferences_come_back_as_written() {
        for pref in ["light", "dark", "system"] {
            let dir = dir_with(pref, Some(&format!("{{\"preference\":{pref:?}}}")));
            assert_eq!(theme_preference_in(&dir), pref);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn missing_file_and_broken_shapes_fall_back_to_system() {
        for (tag, contents) in [
            ("missing", None), // first launch: no file at all
            ("truncated", Some("{\"preference\":")),
            ("unknown", Some("{\"preference\":\"blue\"}")), // no version ever wrote this
            ("shape", Some("[]")),                          // valid JSON, wrong shape
        ] {
            let dir = dir_with(tag, contents);
            assert_eq!(theme_preference_in(&dir), "system", "for {contents:?}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
