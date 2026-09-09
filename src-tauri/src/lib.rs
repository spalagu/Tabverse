mod agent_bridge;
mod agent_client;
mod agent_commands;
mod agent_http;
mod agent_login;
mod agent_supervisor;
mod appearance_commands;
mod basic_auth;
#[cfg(target_os = "windows")]
mod basic_auth_win;
mod browser_commands;
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
mod state_commands;
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
mod credential_commands;
mod credentials;
mod favicon;
mod file_clipboard;
mod fs_commands;
mod fs_watch;
mod http;
mod keys;
mod migrate;
pub mod page_proxy;
mod passwords;
mod profiles;
mod remote_commands;
mod templates;
mod terminal_commands;
mod terminal_helper;
mod transfer;
mod userscripts;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod theme_gen {
    include!(concat!(env!("OUT_DIR"), "/theme_generated.rs"));
}

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tabverse_fs::FsBackend;
use tabverse_remote::{JoinHandle, RemoteHub, SessionBridge, SourceRegistry};
use tabverse_term::protocol::Frame as HelperFrame;
#[cfg(target_os = "macos")]
use tauri::menu::SubmenuBuilder;
use tauri::{AppHandle, Emitter, Manager, State, Window};

#[cfg(test)]
use tabverse_proto::RemoteHostMsg;
#[cfg(test)]
use tabverse_remote::join;
#[cfg(test)]
use tabverse_remote::source::agent::AgentSource;

pub(crate) use browser_commands::{
    browser_label, cmd_token, dirs_next_download, handle_page_report, webview_label,
    AppCommandEvent, PageProxySlot, BROWSER_UA, CMD_SCHEME,
};
pub(crate) use state_commands::{app_state_store, state_dir, AppDatabase};

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

struct AppState {
    helper: terminal_helper::TerminalHelper,
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
    browser_commands::is_coverable_platform()
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
    let remote_network = tabverse_network::HostNetworkGateway::new(
        http::build_remote_browser().expect("build Remote Browser Host HTTP client"),
    );
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
                    if let Err(e) = appearance_commands::toggle_simple_fullscreen(window) {
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
                    appearance_commands::reapply_traffic_light_position(
                        window,
                        TRAFFIC_LIGHT_X,
                        TRAFFIC_LIGHT_Y,
                    );
                });
            }
        })
        .manage(AppState {
            helper: terminal_helper::TerminalHelper::new(),
            hub: RemoteHub::with_network_gateway(remote_network),
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
            ),
        })
        // Holds whatever the system asked us to open before the interface
        // existed to receive it (system_open.rs).
        .manage(system_open::Pending::default())
        .manage(std::sync::Arc::new(agent_client::AgentClientRegistry::new()))
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let app_db = Arc::new(
                tabverse_state::AppStateStore::open(&app_data_dir)
                    .map_err(|e| format!("cannot open app.db: {e:#}"))?,
            );
            app.manage(AppDatabase(app_db.clone()));
            credentials::set_app_data_dir(app_data_dir);
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
                let traffic_light_position = main_cfg.traffic_light_position.clone();
                let mut wb = tauri::WebviewWindowBuilder::from_config(app.handle(), &main_cfg)?;
                let pref = appearance_commands::theme_preference(app.handle());
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
                if let Ok(snapshot) = config::snapshot_with_store(&app_db) {
                    if let Ok(json) = serde_json::to_string(&snapshot.values) {
                        wb = wb.initialization_script(format!(
                            "window.__TABVERSE_BOOT_CONFIG__ = {json};"
                        ));
                    }
                }
                wb.build()?;
                #[cfg(target_os = "macos")]
                if let (Some(window), Some(position)) =
                    (app.get_window("main"), traffic_light_position)
                {
                    let delayed_window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                        appearance_commands::reapply_traffic_light_position(
                            delayed_window,
                            position.x,
                            position.y,
                        );
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
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_window("main") {
                    let pref = appearance_commands::theme_preference(app.handle());
                    let backdrop = match theme_gen::theme(&pref) {
                        Some(t) => &t.backdrop,
                        None => theme_gen::backdrop(
                            window
                                .theme()
                                .map(|t| t == tauri::Theme::Dark)
                                .unwrap_or(true),
                        ),
                    };
                    if let Err(e) = appearance_commands::apply_backdrop(&window, backdrop) {
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
            agent_commands::agent_start,
            agent_commands::agent_prompt,
            agent_commands::agent_cancel,
            agent_commands::agent_answer,
            agent_commands::agent_close,
            agent_commands::agent_detach,
            agent_commands::agent_login_start,
            agent_commands::agent_login_poll,
            agent_commands::agent_login_status,
            agent_commands::agent_logout,
            terminal_commands::term_create,
            terminal_commands::term_write,
            terminal_commands::term_resize,
            terminal_commands::term_kill,
            terminal_commands::term_detach,
            terminal_commands::term_attach,
            terminal_commands::term_helper_list,
            terminal_commands::term_helper_kill_all,
            home_dir,
            app_health,
            page_coverable,
            notify,
            appearance_commands::js_log,
            appearance_commands::traffic_light_reapply,
            share_commands::share_start,
            share_commands::app_share_start,
            share_commands::app_share_stop,
            share_commands::app_share_snapshot_deliver,
            share_commands::app_share_set_active_tab,
            share_commands::app_share_term_snapshot,
            share_commands::app_share_broadcast_action,
            share_commands::share_snapshot,
            share_commands::share_kick,
            share_commands::share_set_viewer_access,
            share_commands::share_stop,
            remote_commands::remote_join,
            remote_commands::remote_input,
            remote_commands::remote_agent_prompt,
            remote_commands::remote_agent_answer,
            remote_commands::remote_agent_cancel,
            remote_commands::remote_viewport,
            remote_commands::remote_ping,
            remote_commands::remote_leave,
            fs_commands::fs_list,
            fs_commands::fs_read,
            fs_commands::fs_write,
            fs_commands::fs_reveal,
            fs_commands::fs_walk,
            fs_commands::fs_transfer,
            fs_commands::fs_grep,
            fs_commands::fs_replace,
            fs_commands::fs_replace_preview,
            fs_commands::fs_changes,
            fs_commands::fs_create,
            fs_commands::fs_rename,
            fs_commands::fs_trash,
            fs_commands::fs_inspect,
            fs_commands::fs_sqlite_rows,
            fs_commands::fs_archive_create,
            fs_commands::fs_archive_extract,
            fs_commands::fs_read_range,
            fs_commands::fs_watch_start,
            fs_commands::fs_watch_stop,
            file_clipboard::clipboard_write_files,
            state_commands::state_save,
            state_commands::state_load,
            state_commands::state_delete,
            state_commands::state_list,
            appearance_commands::set_theme,
            appearance_commands::theme_pref_save,
            appearance_commands::theme_pref_load,
            browser_commands::browser_create,
            browser_commands::browser_find,
            browser_commands::browser_clear_find,
            browser_commands::ui_focus,
            browser_commands::browser_set_bounds,
            browser_commands::browser_set_peek_anchor,
            browser_commands::browser_navigate,
            browser_commands::browser_zoom,
            browser_commands::browser_set_muted,
            browser_commands::browser_print,
            browser_commands::browser_probe,
            browser_commands::browser_open_external,
            browser_commands::browser_auth_answer,
            browser_commands::window_buttons,
            browser_commands::browser_release_hover,
            browser_commands::ui_plane_set,
            browser_commands::browser_plane_raise,
            browser_commands::browser_snapshot,
            credential_commands::pw_authorize_view,
            credential_commands::pw_reveal,
            credential_commands::pw_authorize_export,
            credential_commands::pw_forget_all,
            credential_commands::pw_export,
            credential_commands::pw_import,
            credential_commands::migrate_authorize_export,
            credential_commands::migrate_export,
            credential_commands::migrate_import_check,
            credential_commands::migrate_import_apply,
            browser_commands::browser_dialog_answer,
            browser_commands::browser_ask_unload,
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
            browser_commands::browser_close,
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
            state_commands::config_get,
            state_commands::config_set,
            state_commands::config_reset,
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
mod page_coverage_tests {
    #[cfg(target_os = "macos")]
    use super::browser_commands::is_coverable_platform;
    use super::browser_commands::{macos_version_coverable, page_proxy_url, slot_page_proxy_url};
    use super::PageProxySlot;
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
mod agent_tab_close_tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;
    use tabverse_proto::Access;
    use tabverse_remote::ShareOpts;

    /// Poll `pred` over the collected frames until it holds, or panic with
    /// `what`. Polling rather than a fixed sleep: a slow machine should make
    /// the test slower, not red.
    fn wait_for(
        seen: &Arc<StdMutex<Vec<RemoteHostMsg>>>,
        what: &str,
        pred: impl Fn(&[RemoteHostMsg]) -> bool,
    ) {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            {
                let frames = seen.lock().unwrap();
                if pred(&frames) {
                    return;
                }
                if std::time::Instant::now() > deadline {
                    panic!("timed out waiting for {what}; saw {frames:?}");
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn closing_a_shared_agent_tab_ends_its_viewers_with_a_reason() {
        let work = tempfile::tempdir().unwrap();
        let registry = agent_bridge::AgentRegistry::new();
        let channel: agent_bridge::AgentEventCallback = Arc::new(|_| {});
        let agent_id = registry
            .start(
                "tab-close".to_string(),
                work.path().display().to_string(),
                None,
                channel,
            )
            .unwrap();

        // The same wiring agent_start does: adapter registered under the tab
        // id, session row mapping the registry handle back to the tab.
        let hub = RemoteHub::new();
        let sources = SourceRegistry::default();
        let glue = share_commands::ShareGlue::default();
        let hooks = registry.agent_hooks(&agent_id).unwrap();
        sources.register("tab-close", Arc::new(AgentSource::new(hooks)));
        glue.session_tabs
            .lock()
            .unwrap()
            .insert(agent_id.clone(), "tab-close".to_string());

        // The same wiring share_start does: resolve the source through the
        // registry, bind it into a share, record the share row.
        let source = sources
            .get("tab-close")
            .expect("the registered runtime is the one that shares");
        let (share, ticket) = tauri::async_runtime::block_on(hub.share_start(ShareOpts {
            title: "Agent".into(),
            source,
            on_presence: Arc::new(|_| {}),
            ttl: None,
            access: Access::View,
        }))
        .unwrap();
        glue.share_sessions
            .lock()
            .unwrap()
            .insert(share.id.clone(), agent_id.clone());

        let seen: Arc<StdMutex<Vec<RemoteHostMsg>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink = {
            let seen = Arc::clone(&seen);
            Arc::new(move |m| seen.lock().unwrap().push(m))
                as Arc<dyn Fn(RemoteHostMsg) + Send + Sync>
        };
        let viewer = tauri::async_runtime::block_on(join(&ticket, "watcher", sink)).unwrap();
        wait_for(&seen, "the welcome", |ms| {
            ms.iter()
                .any(|m| matches!(m, RemoteHostMsg::Welcome { .. }))
        });

        // The user closes the tab.
        agent_commands::close_agent_tab(&hub, &sources, &glue, &registry, &agent_id);

        // The viewer is told, with the reason the hub gives every share it
        // stops — not left on a stream that silently fell quiet.
        wait_for(&seen, "the End frame after the tab closed", |ms| {
            ms.iter().any(
                |m| matches!(m, RemoteHostMsg::End { reason } if reason == "host stopped sharing"),
            )
        });
        assert!(
            sources.get("tab-close").is_none(),
            "the dead tab must leave the source registry"
        );
        assert!(
            glue.session_tabs.lock().unwrap().is_empty(),
            "the session row dies with its runtime"
        );
        assert!(
            glue.share_sessions.lock().unwrap().is_empty(),
            "the share row dies with its runtime"
        );

        tauri::async_runtime::block_on(viewer.leave());
    }
}

#[cfg(test)]
mod find_frames_tests {
    use super::browser_commands::{find_script_for, parse_find_counts};
    use super::theme_gen;

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
    use super::{browser_commands::shortcut_script_for, keys};
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
    use super::{appearance_commands::is_theme_preference, theme_gen};

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
    use super::appearance_commands::theme_preference_in;
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
