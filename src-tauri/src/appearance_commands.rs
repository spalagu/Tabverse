//! Tauri adapter for window appearance, theme persistence and webview logging.

use tauri::{AppHandle, Window};

use crate::{app_state_store, config, theme_gen};
#[cfg(target_os = "macos")]
use crate::{ui_plane, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y};

#[cfg(target_os = "macos")]
pub(crate) fn reapply_traffic_light_position(window: Window, x: f64, y: f64) {
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
pub(crate) fn traffic_light_reapply(window: Window) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    reapply_traffic_light_position(window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

#[tauri::command]
pub(crate) fn toggle_simple_fullscreen(window: Window) -> Result<(), String> {
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

const THEME_SCOPE: &str = "theme";

/// The saved theme preference. Anything unreadable — no file, bad JSON, an
/// unknown value — is "system": a first launch and a corrupt file both get
/// the follow-the-OS default rather than an error.
pub(crate) fn theme_preference(app: &AppHandle) -> String {
    let fallback = || "system".to_string();
    let Ok(store) = app_state_store(app) else {
        return fallback();
    };
    let Ok(Some(json)) = store.load_scope(THEME_SCOPE) else {
        return fallback();
    };
    theme_preference_json(&json)
}

fn theme_preference_json(json: &str) -> String {
    let fallback = || "system".to_string();
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| {
            v.get("preference")
                .and_then(|p| p.as_str())
                .map(String::from)
        })
        .filter(|p| is_theme_preference(p))
        .unwrap_or_else(fallback)
}

/// The disk half of [`theme_preference`], split on the state directory so a
/// test can drive it against a sandbox dir without an [`AppHandle`].
#[cfg(test)]
pub(crate) fn theme_preference_in(dir: &std::path::Path) -> String {
    let fallback = || "system".to_string();
    let Ok(Some(json)) = tabverse_fs::state::load(dir, THEME_SCOPE) else {
        return fallback();
    };
    theme_preference_json(&json)
}

pub(crate) fn is_theme_preference(p: &str) -> bool {
    config::ThemePref::from_token(p).is_some()
}

/// Paint the window backdrop: the one funnel to
/// ui_plane::set_window_backdrop, so the color can only come from the
/// generated table (theme token tests pin the call shape).
#[cfg(target_os = "macos")]
pub(crate) fn apply_backdrop(
    window: &tauri::Window,
    backdrop: &theme_gen::Backdrop,
) -> Result<(), String> {
    ui_plane::set_window_backdrop(window, backdrop.r, backdrop.g, backdrop.b)
}

#[tauri::command]
pub(crate) fn set_theme(window: tauri::Window, theme: String) -> Result<(), String> {
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

// Theme preference is also an app.db scope; the synchronous startup reader
// and asynchronous settings writer share one source of truth.
#[tauri::command]
pub(crate) async fn theme_pref_save(app: AppHandle, pref: String) -> Result<(), String> {
    if !is_theme_preference(&pref) {
        return Err(format!("unknown theme preference {pref:?}"));
    }
    let json = serde_json::json!({ "preference": pref }).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        app_state_store(&app)?
            .save_scope(THEME_SCOPE, &json)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn theme_pref_load(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(theme_preference(&app)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn js_log(level: String, msg: String) {
    eprintln!("[webview:{level}] {msg}");
}
