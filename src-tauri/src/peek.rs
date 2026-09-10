use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

/// tab id -> the pinned address's host. Only anchored tabs can peek.
static ANCHORS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// tab id -> when a command last asked this tab to navigate. A stamp lives
/// until the commanded load finishes (or the TTL below, for loads that
/// never finish — a navigation that became a download, a hung server).
static COMMANDED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
const COMMAND_TTL: Duration = Duration::from_secs(30);

/// Whether the navigation currently being decided targets the MAIN frame.
///
/// The engine's policy callback fires for every frame, and a pinned page's
/// third-party iframes navigate cross-host constantly — peeking those would
/// break every page that embeds anything. On macOS the frame is stamped by
/// the swizzle in `install_frame_probe` immediately before the policy
/// function runs (same thread, synchronous call chain). On Windows the
/// engine's NavigationStarting is top-level-only, so the default `true`
/// is already the truth.
static MAIN_FRAME: AtomicBool = AtomicBool::new(true);

pub fn set_anchor(tab_id: &str, host: Option<String>) {
    let mut guard = ANCHORS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    match host {
        Some(h) if !h.is_empty() => {
            map.insert(tab_id.to_string(), h.to_ascii_lowercase());
        }
        _ => {
            map.remove(tab_id);
        }
    }
}

fn anchor_host(tab_id: &str) -> Option<String> {
    ANCHORS.lock().unwrap().as_ref()?.get(tab_id).cloned()
}

/// A tab's webview is gone; its bookkeeping goes with it.
pub fn forget_tab(tab_id: &str) {
    if let Some(map) = ANCHORS.lock().unwrap().as_mut() {
        map.remove(tab_id);
    }
    if let Some(map) = COMMANDED.lock().unwrap().as_mut() {
        map.remove(tab_id);
    }
}

/// A command (create / go / reload / back / forward / watchdog retry) is
/// about to navigate this tab. Stamped BEFORE the engine is asked, because
/// the policy callback can fire before the asking call returns.
pub fn command_stamp(tab_id: &str) {
    COMMANDED
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(tab_id.to_string(), Instant::now());
}

/// The commanded load finished; the tab's next navigation is the page's own.
pub fn load_finished(tab_id: &str) {
    if let Some(map) = COMMANDED.lock().unwrap().as_mut() {
        map.remove(tab_id);
    }
}

fn commanded_recently(tab_id: &str) -> bool {
    COMMANDED
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(tab_id))
        .is_some_and(|at| at.elapsed() < COMMAND_TTL)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PeekEvent {
    /// The pinned tab whose navigation was taken.
    tab_id: String,
    /// Where the page wanted to go; the peek opens here.
    url: String,
}

/// Decide one navigation. Returns true when it was taken for a peek,
/// meaning the caller must cancel it.
pub fn intercept(app: &AppHandle, tab_id: &str, url: &tauri::Url) -> bool {
    // Frame first: read (not reset) — the stamp is refreshed per decision
    // on macOS and permanently true where the engine only reports top-level.
    if !MAIN_FRAME.load(Ordering::SeqCst) {
        return false;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(anchor) = anchor_host(tab_id) else {
        return false;
    };
    let Some(target) = url.host_str() else {
        return false;
    };
    // Host NAMES, exactly (ports aside): the spec's "cross-host" is the
    // hostname — localhost and 127.0.0.1 are different hosts even when
    // they are the same machine.
    if target.eq_ignore_ascii_case(&anchor) {
        return false;
    }
    // Explicit intent goes through: a commanded load still owed to the
    // watchdog, or any command stamped and not yet finished loading.
    if crate::nav_watchdog::is_pending(tab_id) || commanded_recently(tab_id) {
        return false;
    }
    // Host only in the log — a full navigation url is browsing history.
    eprintln!(
        "[peek] cross-host page navigation on pinned tab={tab_id} -> {target}, opening as peek"
    );
    let _ = app.emit(
        "browser-open-peek",
        PeekEvent {
            tab_id: tab_id.to_string(),
            url: url.to_string(),
        },
    );
    true
}

/// macOS: stamp whether each policy decision is about the main frame.
///
/// wry's own delegate implements decidePolicyForNavigationAction and hands
/// the policy function nothing but the url, so the frame is recovered by
/// swizbling the method: the replacement reads the action's target frame,
/// stores the answer for `intercept` (which runs synchronously inside the
/// original implementation, on the same main thread), and calls straight
/// through. Installed once per delegate class.
#[cfg(target_os = "macos")]
pub fn install_frame_probe(delegate: *mut objc2::runtime::AnyObject) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use std::ffi::CString;
    use std::sync::OnceLock;

    type PolicyFn = unsafe extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
        *mut AnyObject,
        *mut AnyObject,
    );
    static ORIGINAL: OnceLock<usize> = OnceLock::new();
    static ONCE: OnceLock<()> = OnceLock::new();

    unsafe extern "C-unwind" fn probed(
        this: *mut AnyObject,
        cmd: Sel,
        webview: *mut AnyObject,
        action: *mut AnyObject,
        handler: *mut AnyObject,
    ) {
        // targetFrame is nil for a new-window ask (target=_blank without a
        // handler); that path is answered by the new-window route, not by
        // peek, so nil counts as "not the main frame" here.
        let is_main = if action.is_null() {
            false
        } else {
            let frame: *mut AnyObject = unsafe { msg_send![&*action, targetFrame] };
            if frame.is_null() {
                false
            } else {
                unsafe { msg_send![&*frame, isMainFrame] }
            }
        };
        MAIN_FRAME.store(is_main, Ordering::SeqCst);
        if let Some(orig) = ORIGINAL.get() {
            let orig: PolicyFn = unsafe { std::mem::transmute(*orig) };
            unsafe { orig(this, cmd, webview, action, handler) };
        }
        // Back to the default the moment the decision is made: any caller
        // that somehow reaches the policy function without passing through
        // here must see "main", never a stale iframe verdict.
        MAIN_FRAME.store(true, Ordering::SeqCst);
    }

    if delegate.is_null() {
        return;
    }
    ONCE.get_or_init(|| unsafe {
        let cls: *const AnyClass = msg_send![&*delegate, class];
        let name =
            CString::new("webView:decidePolicyForNavigationAction:decisionHandler:").unwrap();
        let Some(sel) = objc2::ffi::sel_registerName(name.as_ptr()) else {
            eprintln!("[peek] frame probe: selector did not register");
            return;
        };
        let method = objc2::ffi::class_getInstanceMethod(cls, sel);
        if method.is_null() {
            // Without the frame answer, peeking would swallow iframe
            // navigations; better to leave the feature off than break pages.
            eprintln!("[peek] frame probe: policy method not found; peek stays disabled");
            return;
        }
        let prior = objc2::ffi::method_setImplementation(
            method,
            std::mem::transmute::<PolicyFn, objc2::runtime::Imp>(probed),
        );
        match prior {
            Some(imp) => {
                let _ = ORIGINAL.set(imp as usize);
                // Only now may navigations be judged main-frame: with no
                // original to call, the probe would eat every navigation.
                eprintln!("[peek] frame probe installed");
            }
            None => eprintln!("[peek] frame probe: swizzle returned no original imp"),
        }
    });
}
