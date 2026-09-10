#![cfg(target_os = "macos")]

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_char, CString};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use block2::{Block, RcBlock};
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2_foundation::NSString;
use tauri::{AppHandle, Emitter};

/// WKPermissionDecision
const DECISION_DENY: isize = 2;
const DECISION_GRANT: isize = 1;

static APP: OnceLock<AppHandle> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// What WebKit is waiting on, and how to answer it.
enum Pending {
    /// `void (^)(void)`
    Alert(RcBlock<dyn Fn()>),
    /// `void (^)(BOOL)`
    Confirm(RcBlock<dyn Fn(Bool)>),
    /// `void (^)(NSString *)` — nil means the user cancelled.
    Prompt(RcBlock<dyn Fn(*mut AnyObject)>),
    /// `void (^)(WKPermissionDecision)`, plus the origin the answer is
    /// remembered against.
    Media {
        handler: RcBlock<dyn Fn(isize)>,
        origin: String,
    },
}

thread_local! {
    static PENDING: RefCell<HashMap<u64, Pending>> = RefCell::new(HashMap::new());
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DialogEvent {
    dialog_id: u64,
    /// "alert" | "confirm" | "prompt" | "camera" | "microphone" | "camera and microphone"
    kind: &'static str,
    origin: String,
    message: String,
    default_text: String,
}

/// Install the page-dialog and media-permission handlers. Idempotent per
/// process; the delegate is re-assigned on every call so that webviews
/// created before the install still route through the new methods.
pub fn install(app: &AppHandle, webview: *mut AnyObject, ui_delegate: *mut AnyObject) {
    static ONCE: OnceLock<()> = OnceLock::new();
    let _ = APP.set(app.clone());
    if webview.is_null() || ui_delegate.is_null() {
        return;
    }
    ONCE.get_or_init(|| unsafe {
        let cls: *const AnyClass = msg_send![&*ui_delegate, class];
        let cls = cls as *mut AnyClass;
        add(
            cls,
            "webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:",
            "v@:@@@@?",
            std::mem::transmute::<AlertFn, objc2::runtime::Imp>(run_alert_panel),
        );
        add(
            cls,
            "webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:",
            "v@:@@@@?",
            std::mem::transmute::<AlertFn, objc2::runtime::Imp>(run_confirm_panel),
        );
        add(
            cls,
            "webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:",
            "v@:@@@@@?",
            std::mem::transmute::<PromptFn, objc2::runtime::Imp>(run_prompt_panel),
        );
        // Replace, not add: the wrapper's own implementation is the bug.
        let sel_name = CString::new(
            "webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:",
        )
        .unwrap();
        let types = CString::new("v@:@@@q@?").unwrap();
        let sel = objc2::ffi::sel_registerName(sel_name.as_ptr())
            .expect("registering the media-permission selector");
        objc2::ffi::class_replaceMethod(
            cls,
            sel,
            std::mem::transmute::<MediaFn, objc2::runtime::Imp>(request_media_permission),
            types.as_ptr() as *const c_char,
        );
        eprintln!("[dialogs] page dialogs added; media permission now asks");
        eprintln!(
            "[dialogs] screen share (getDisplayMedia): no public WKWebView permission hook; skipped"
        );
    });
    unsafe {
        let nil: *mut AnyObject = std::ptr::null_mut();
        let () = msg_send![&*webview, setUIDelegate: nil];
        let () = msg_send![&*webview, setUIDelegate: &*ui_delegate];
    }
}

type AlertFn = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
);
type PromptFn = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
);
type MediaFn = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
    isize,
    *mut AnyObject,
);

unsafe fn add(cls: *mut AnyClass, selector: &str, types: &str, imp: objc2::runtime::Imp) {
    let sel_name = CString::new(selector).unwrap();
    let types = CString::new(types).unwrap();
    let sel =
        objc2::ffi::sel_registerName(sel_name.as_ptr()).expect("registering a panel selector");
    let added = objc2::ffi::class_addMethod(cls, sel, imp, types.as_ptr() as *const c_char);
    if !added.as_bool() {
        // Someone below us implements it: theirs wins, ours is not needed.
        eprintln!("[dialogs] {selector} already implemented, left alone");
    }
}

unsafe fn ns_str(obj: *mut AnyObject) -> String {
    if obj.is_null() {
        String::new()
    } else {
        (*(obj as *const NSString)).to_string()
    }
}

/// The page's own origin, as the security origin object spells it.
unsafe fn frame_origin(frame: *mut AnyObject) -> String {
    if frame.is_null() {
        return String::new();
    }
    let req: *mut AnyObject = msg_send![&*frame, request];
    if req.is_null() {
        return String::new();
    }
    let url: *mut AnyObject = msg_send![&*req, URL];
    if url.is_null() {
        return String::new();
    }
    let host: *mut AnyObject = msg_send![&*url, host];
    ns_str(host)
}

fn emit(
    kind: &'static str,
    origin: String,
    message: String,
    default_text: String,
    pending: Pending,
) {
    let Some(app) = APP.get() else { return };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    PENDING.with(|p| p.borrow_mut().insert(id, pending));
    eprintln!("[dialogs] {kind} from {origin}");
    let _ = app.emit(
        "browser-dialog",
        DialogEvent {
            dialog_id: id,
            kind,
            origin,
            message,
            default_text,
        },
    );
}

unsafe extern "C-unwind" fn run_alert_panel(
    _this: *mut AnyObject,
    _cmd: Sel,
    _webview: *mut AnyObject,
    message: *mut AnyObject,
    frame: *mut AnyObject,
    handler: *mut AnyObject,
) {
    let block =
        RcBlock::copy(handler as *mut Block<dyn Fn()>).expect("copying an alert completion block");
    emit(
        "alert",
        frame_origin(frame),
        ns_str(message),
        String::new(),
        Pending::Alert(block),
    );
}

unsafe extern "C-unwind" fn run_confirm_panel(
    _this: *mut AnyObject,
    _cmd: Sel,
    _webview: *mut AnyObject,
    message: *mut AnyObject,
    frame: *mut AnyObject,
    handler: *mut AnyObject,
) {
    let block = RcBlock::copy(handler as *mut Block<dyn Fn(Bool)>)
        .expect("copying a confirm completion block");
    emit(
        "confirm",
        frame_origin(frame),
        ns_str(message),
        String::new(),
        Pending::Confirm(block),
    );
}

unsafe extern "C-unwind" fn run_prompt_panel(
    _this: *mut AnyObject,
    _cmd: Sel,
    _webview: *mut AnyObject,
    prompt: *mut AnyObject,
    default_text: *mut AnyObject,
    frame: *mut AnyObject,
    handler: *mut AnyObject,
) {
    let block = RcBlock::copy(handler as *mut Block<dyn Fn(*mut AnyObject)>)
        .expect("copying a prompt completion block");
    emit(
        "prompt",
        frame_origin(frame),
        ns_str(prompt),
        ns_str(default_text),
        Pending::Prompt(block),
    );
}

unsafe extern "C-unwind" fn request_media_permission(
    _this: *mut AnyObject,
    _cmd: Sel,
    _webview: *mut AnyObject,
    origin: *mut AnyObject,
    _frame: *mut AnyObject,
    capture_type: isize,
    handler: *mut AnyObject,
) {
    let block = RcBlock::copy(handler as *mut Block<dyn Fn(isize)>)
        .expect("copying a media decision block");
    let host = if origin.is_null() {
        String::new()
    } else {
        let h: *mut AnyObject = msg_send![&*origin, host];
        ns_str(h)
    };
    // WKMediaCaptureType: 0 camera, 1 microphone, 2 both.
    let kind = match capture_type {
        0 => "camera",
        1 => "microphone",
        _ => "camera and microphone",
    };
    // A remembered choice answers straight away — including a remembered
    // refusal, which must not degrade into a fresh prompt every visit.
    if let Some(app) = APP.get() {
        if let Some(allow) = crate::page_prompts::remembered(app, &host, kind) {
            eprintln!("[dialogs] remembered {kind} decision for {host}: {allow}");
            block.call((if allow { DECISION_GRANT } else { DECISION_DENY },));
            return;
        }
    }
    emit(
        kind,
        host.clone(),
        String::new(),
        String::new(),
        Pending::Media {
            handler: block,
            origin: host,
        },
    );
}

/// The user's answer. `ok` is the confirm/permission verdict; `text` is
/// the prompt's reply. Wrapped by a platform-independent command in lib.rs.
pub fn answer(
    app: AppHandle,
    dialog_id: u64,
    ok: bool,
    text: Option<String>,
    remember_choice: bool,
    kind: Option<String>,
) -> Result<(), String> {
    let on_main = app.clone();
    on_main
        .run_on_main_thread(move || {
            let Some(pending) = PENDING.with(|p| p.borrow_mut().remove(&dialog_id)) else {
                eprintln!("[dialogs] answer for unknown dialog {dialog_id}, dropped");
                return;
            };
            match pending {
                Pending::Alert(b) => b.call(()),
                Pending::Confirm(b) => b.call((Bool::new(ok),)),
                Pending::Prompt(b) => {
                    // nil is how WebKit hears "cancelled"; an empty string is a
                    // legitimate answer and must stay distinguishable from it.
                    if ok {
                        let s = NSString::from_str(text.as_deref().unwrap_or(""));
                        let ptr: *const NSString = &*s;
                        b.call((ptr as *mut AnyObject,));
                    } else {
                        b.call((std::ptr::null_mut(),));
                    }
                }
                Pending::Media { handler, origin } => {
                    if remember_choice {
                        crate::page_prompts::remember(
                            &app,
                            &origin,
                            kind.as_deref().unwrap_or("camera"),
                            ok,
                        );
                    }
                    handler.call((if ok { DECISION_GRANT } else { DECISION_DENY },));
                }
            }
        })
        .map_err(|e| e.to_string())
}
