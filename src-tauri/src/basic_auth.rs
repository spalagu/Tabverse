#![cfg(target_os = "macos")]

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_char, CString};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use crate::AppHandle;
use block2::{Block, RcBlock};
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use tauri::Emitter;

/// completionHandler shape: (NSURLSessionAuthChallengeDisposition, NSURLCredential *)
type AuthBlock = Block<dyn Fn(isize, *mut AnyObject)>;

const USE_CREDENTIAL: isize = 0;
const PERFORM_DEFAULT_HANDLING: isize = 1;
const CANCEL_CHALLENGE: isize = 2;

static APP: OnceLock<AppHandle> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

thread_local! {
    /// Pending challenges, keyed by the id the UI answers with. Main thread
    /// only — the blocks inside are not Send, and hopping through
    /// `run_on_main_thread` is what keeps that honest.
    static PENDING: RefCell<HashMap<u64, PendingChallenge>> = RefCell::new(HashMap::new());
}

struct PendingChallenge {
    handler: RcBlock<dyn Fn(isize, *mut AnyObject)>,
    /// `host:port` — the keychain key for optionally remembered credentials.
    key: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthRequestEvent {
    challenge_id: u64,
    host: String,
    realm: String,
    /// Username of a stored credential that was already tried and failed,
    /// so the UI can prefill and say so.
    failed_username: Option<String>,
}

/// Install the challenge handler onto wry's delegate class. Idempotent;
/// call with any browser webview's platform handle after creation.
///
/// The delegate is re-assigned afterwards every time: WKWebView caches
/// which delegate methods exist at assignment, so a webview whose delegate
/// was set before the method was added would never call it (observed: the
/// add succeeded, sites kept getting 401s, the handler stayed silent).
/// Re-setting invalidates that cache. Webviews created after the add cache
/// the right answer from the start.
pub fn install(app: &AppHandle, webview: *mut AnyObject, delegate: *mut AnyObject) {
    static ONCE: OnceLock<()> = OnceLock::new();
    let _ = APP.set(app.clone());
    if webview.is_null() || delegate.is_null() {
        return;
    }
    ONCE.get_or_init(|| unsafe {
        let cls: *const AnyClass = msg_send![&*delegate, class];
        let sel_name =
            CString::new("webView:didReceiveAuthenticationChallenge:completionHandler:").unwrap();
        let types = CString::new("v@:@@@?").unwrap();
        let sel = objc2::ffi::sel_registerName(sel_name.as_ptr())
            .expect("registering the challenge selector");
        let added = objc2::ffi::class_addMethod(
            cls as *mut AnyClass,
            sel,
            std::mem::transmute::<
                unsafe extern "C-unwind" fn(
                    *mut AnyObject,
                    Sel,
                    *mut AnyObject,
                    *mut AnyObject,
                    *mut AnyObject,
                ),
                objc2::runtime::Imp,
            >(did_receive_challenge),
            types.as_ptr() as *const c_char,
        );
        if added.as_bool() {
            eprintln!("[auth] challenge handler installed on the webview delegate");
        } else {
            // wry grew its own implementation: defer to it entirely.
            eprintln!("[auth] delegate already handles challenges; ours not installed");
        }
    });
    unsafe {
        let nil: *mut AnyObject = std::ptr::null_mut();
        let () = msg_send![&*webview, setNavigationDelegate: nil];
        let () = msg_send![&*webview, setNavigationDelegate: &*delegate];
    }
}

unsafe fn ns_string_or_empty(obj: *mut AnyObject) -> String {
    if obj.is_null() {
        String::new()
    } else {
        (*(obj as *const NSString)).to_string()
    }
}

unsafe extern "C-unwind" fn did_receive_challenge(
    _this: *mut AnyObject,
    _cmd: Sel,
    _webview: *mut AnyObject,
    challenge: *mut AnyObject,
    handler: *mut AnyObject,
) {
    let call = |disposition: isize, credential: *mut AnyObject| {
        let block: &AuthBlock = &*(handler as *const AuthBlock);
        block.call((disposition, credential));
    };

    let ps: *mut AnyObject = msg_send![&*challenge, protectionSpace];
    let method: *mut AnyObject = msg_send![&*ps, authenticationMethod];
    let method = ns_string_or_empty(method);

    if method == "NSURLAuthenticationMethodServerTrust" {
        let host: *mut AnyObject = msg_send![&*ps, host];
        let host = ns_string_or_empty(host);
        if let Some(app) = APP.get() {
            if crate::trusted_hosts::is_trusted(app, &host) {
                let trust: *mut AnyObject = msg_send![&*ps, serverTrust];
                if !trust.is_null() {
                    let cred: *mut AnyObject =
                        msg_send![class!(NSURLCredential), credentialForTrust: trust];
                    eprintln!("[auth] using the user's certificate exception for {host}");
                    call(USE_CREDENTIAL, cred);
                    return;
                }
            }
        }
        call(PERFORM_DEFAULT_HANDLING, std::ptr::null_mut());
        return;
    }

    // Everything else that is not a password prompt keeps the exact
    // pre-module behavior.
    if method != "NSURLAuthenticationMethodHTTPBasic"
        && method != "NSURLAuthenticationMethodHTTPDigest"
    {
        call(PERFORM_DEFAULT_HANDLING, std::ptr::null_mut());
        return;
    }

    let host: *mut AnyObject = msg_send![&*ps, host];
    let host = ns_string_or_empty(host);
    let port: isize = msg_send![&*ps, port];
    let realm: *mut AnyObject = msg_send![&*ps, realm];
    let realm = ns_string_or_empty(realm);
    let prev_failures: isize = msg_send![&*challenge, previousFailureCount];
    let key = format!("{host}:{port}");

    // A stored credential is tried once, silently — the way every browser
    // treats its own saved passwords. After a failure the UI must appear,
    // or a stale password would loop forever.
    let mut failed_username = None;
    if prev_failures == 0 {
        if let Ok(saved) = crate::credentials::find_http_auth(&key) {
            if let Some(c) = saved.first() {
                eprintln!("[auth] using stored credential for {key}");
                call(USE_CREDENTIAL, make_credential(&c.username, &c.password));
                return;
            }
        }
    } else if let Ok(saved) = crate::credentials::find_http_auth(&key) {
        failed_username = saved.first().map(|c| c.username.clone());
    }

    let Some(app) = APP.get() else {
        call(PERFORM_DEFAULT_HANDLING, std::ptr::null_mut());
        return;
    };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let retained =
        RcBlock::copy(handler as *mut AuthBlock).expect("copying an auth completion block");
    PENDING.with(|p| {
        p.borrow_mut().insert(
            id,
            PendingChallenge {
                handler: retained,
                key: key.clone(),
            },
        )
    });
    eprintln!("[auth] challenge from {key}, asking the user");
    let _ = app.emit(
        "browser-auth-request",
        AuthRequestEvent {
            challenge_id: id,
            host: if port == 80 || port == 443 {
                host
            } else {
                key.clone()
            },
            realm,
            failed_username,
        },
    );
}

unsafe fn make_credential(user: &str, pass: &str) -> *mut AnyObject {
    let user = NSString::from_str(user);
    let pass = NSString::from_str(pass);
    // NSURLCredentialPersistenceNone: WebKit gets it for this challenge
    // only; OUR keychain is the sole place it is remembered.
    msg_send![
        class!(NSURLCredential),
        credentialWithUser: &*user,
        password: &*pass,
        persistence: 0isize
    ]
}

/// The UI's answer. Cancel (username None) aborts the load; save stores the
/// pair under this challenge's host:port for next time. Wrapped by the
/// `browser_auth_answer` command in lib.rs so the command table stays
/// platform-independent.
pub fn answer(
    app: AppHandle,
    challenge_id: u64,
    username: Option<String>,
    password: Option<String>,
    save: bool,
) -> Result<(), String> {
    app.run_on_main_thread(move || {
        let Some(pending) = PENDING.with(|p| p.borrow_mut().remove(&challenge_id)) else {
            eprintln!("[auth] answer for unknown challenge {challenge_id}, dropped");
            return;
        };
        match (username, password) {
            (Some(u), Some(p)) => {
                if save {
                    if let Err(e) = crate::credentials::save_http_auth(&pending.key, &u, &p) {
                        eprintln!("[auth] could not save credential: {e}");
                    }
                }
                unsafe {
                    let cred = make_credential(&u, &p);
                    pending.handler.call((USE_CREDENTIAL, cred));
                }
            }
            _ => pending
                .handler
                .call((CANCEL_CHALLENGE, std::ptr::null_mut())),
        }
    })
    .map_err(|e| e.to_string())
}
