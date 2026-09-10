#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::ffi::{c_char, CString};
use std::sync::{Mutex, OnceLock};

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2_foundation::{NSDictionary, NSString};
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Which tab a webview belongs to. The delegate is shared by every browser
/// webview, so the pointer is the only thing distinguishing them.
static TABS: Mutex<Option<HashMap<usize, String>>> = Mutex::new(None);

pub fn register_tab(webview: *mut AnyObject, tab_id: &str) {
    TABS.lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(webview as usize, tab_id.to_string());
}

pub fn forget_tab(tab_id: &str) {
    if let Some(map) = TABS.lock().unwrap().as_mut() {
        map.retain(|_, v| v != tab_id);
    }
}

/// Which tab a webview belongs to — shared with the page channel, which
/// has to answer the same question about a message's sender.
pub fn tab_for(webview: *mut AnyObject) -> Option<String> {
    tab_of(webview)
}

fn tab_of(webview: *mut AnyObject) -> Option<String> {
    TABS.lock()
        .unwrap()
        .as_ref()?
        .get(&(webview as usize))
        .cloned()
}

/// What each tab was last asked to open. The engine's error does not always
/// carry the failing address, and reading it off the webview is forbidden
/// (an uncommitted webview has none, and the layer below unwraps that and
/// takes the process down with it) — so the app remembers what it asked for.
static REQUESTED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn remember_request(tab_id: &str, url: &str) {
    REQUESTED
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(tab_id.to_string(), url.to_string());
}

fn requested(tab_id: &str) -> Option<String> {
    REQUESTED.lock().unwrap().as_ref()?.get(tab_id).cloned()
}

pub fn report_blank_load(app: &AppHandle, tab_id: &str, loaded: &str) {
    if loaded != "about:blank" {
        return;
    }
    let Some(asked) = requested(tab_id) else {
        return;
    };
    let Ok(url) = asked.parse::<tauri::Url>() else {
        return;
    };
    if url.port().is_none() || !matches!(url.scheme(), "http" | "https") {
        return;
    }
    let port = url.port().unwrap_or_default();
    eprintln!("[nav] blank load on tab={tab_id} for {asked} — refused port");
    crate::nav_report::report(
        app,
        tab_id,
        &asked,
        crate::nav_report::Trouble::Unclassified(format!(
            "the browser engine refuses to open port {port}, because other protocols use it \
             and a web page must not be able to reach them. Nothing was sent. If the service \
             really listens there, open it in your system browser"
        )),
    );
}

/// Install the failure handlers on the navigation delegate class. The
/// delegate is re-assigned by the auth module for the same reason (WebKit
/// caches which methods a delegate responds to at assignment time), and
/// this runs before that, so one re-assignment covers both.
pub fn install(app: &AppHandle, delegate: *mut AnyObject) {
    static ONCE: OnceLock<()> = OnceLock::new();
    let _ = APP.set(app.clone());
    if delegate.is_null() {
        return;
    }
    ONCE.get_or_init(|| unsafe {
        let cls: *const AnyClass = msg_send![&*delegate, class];
        let cls = cls as *mut AnyClass;
        for selector in [
            // Before the page commits: DNS, refused connections, TLS,
            // policy blocks — nearly everything lands here.
            "webView:didFailProvisionalNavigation:withError:",
            // After it commits: a connection dropped mid-page.
            "webView:didFailNavigation:withError:",
        ] {
            let name = CString::new(selector).unwrap();
            let types = CString::new("v@:@@@").unwrap();
            let sel = objc2::ffi::sel_registerName(name.as_ptr())
                .expect("registering a failure selector");
            let added = objc2::ffi::class_addMethod(
                cls,
                sel,
                std::mem::transmute::<FailFn, objc2::runtime::Imp>(did_fail),
                types.as_ptr() as *const c_char,
            );
            if !added.as_bool() {
                eprintln!("[nav] {selector} already implemented, left alone");
            }
        }
        eprintln!("[nav] failure handlers installed");
    });
}

type FailFn = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
);

unsafe extern "C-unwind" fn did_fail(
    _this: *mut AnyObject,
    _cmd: Sel,
    webview: *mut AnyObject,
    _navigation: *mut AnyObject,
    error: *mut AnyObject,
) {
    if error.is_null() {
        return;
    }
    let code: isize = msg_send![&*error, code];
    let domain: *mut AnyObject = msg_send![&*error, domain];
    let domain = if domain.is_null() {
        String::new()
    } else {
        (*(domain as *const NSString)).to_string()
    };

    // Our own doing: the command channel navigates to a custom scheme and
    // then cancels it, and a started download cancels its navigation too.
    // Both arrive here as errors and neither is one.
    if is_self_inflicted(&domain, code) {
        return;
    }

    let Some(app) = APP.get() else { return };
    let Some(tab_id) = tab_of(webview) else {
        eprintln!("[nav] failure for an unknown webview ({domain} {code}), dropped");
        return;
    };
    // The error's own failing address when it carries one, and otherwise
    // what this tab was asked to open — a message that cannot name the site
    // is barely better than the blanket sentence this replaced.
    let url = match failing_url(error) {
        u if !u.is_empty() => u,
        _ => requested(&tab_id).unwrap_or_default(),
    };
    let trouble = classify(&domain, code, error);
    eprintln!("[nav] failure on tab={tab_id} url={url} ({domain} {code})");
    crate::nav_report::report(app, &tab_id, &url, trouble);
}

/// Errors this app caused on purpose, which must never surface.
fn is_self_inflicted(domain: &str, code: isize) -> bool {
    // NSURLErrorCancelled, and WebKit's "frame load interrupted by policy
    // change" — what cancelling a navigation from the policy decision
    // looks like from here.
    (domain == "NSURLErrorDomain" && code == -999)
        || (domain == "WebKitErrorDomain" && (code == 102 || code == 101))
}

unsafe fn failing_url(error: *mut AnyObject) -> String {
    let info: *mut AnyObject = msg_send![&*error, userInfo];
    if info.is_null() {
        return String::new();
    }
    let dict = &*(info as *const NSDictionary);
    let key = NSString::from_str("NSErrorFailingURLStringKey");
    let value: *mut AnyObject = msg_send![dict, objectForKey: &*key];
    if value.is_null() {
        return String::new();
    }
    (*(value as *const NSString)).to_string()
}

unsafe fn localized(error: *mut AnyObject) -> String {
    let d: *mut AnyObject = msg_send![&*error, localizedDescription];
    if d.is_null() {
        String::new()
    } else {
        (*(d as *const NSString)).to_string()
    }
}

unsafe fn classify(domain: &str, code: isize, error: *mut AnyObject) -> crate::nav_report::Trouble {
    use crate::nav_report::Trouble;
    if domain == "NSURLErrorDomain" {
        match code {
            -1206..=-1199 => return Trouble::Certificate,
            -1003 => return Trouble::UnknownHost,
            -1004 => return Trouble::Refused,
            -1001 => return Trouble::TimedOut,
            -1009 => return Trouble::Offline,
            -1022 => return Trouble::BlockedByApp,
            _ => {}
        }
    }
    Trouble::Unclassified(format!("{} ({domain} {code})", localized(error)))
}
