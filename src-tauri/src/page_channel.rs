#![cfg(target_os = "macos")]

use std::ffi::{c_char, CString};
use std::sync::OnceLock;

use crate::AppHandle;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2_foundation::NSString;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// The name the page posts to. Defined in the crate root, because the
/// script that posts to it is built on every platform (see `PAGE_CHANNEL`).
use crate::PAGE_CHANNEL as HANDLER_NAME;

fn handler_class() -> *mut AnyClass {
    static CLASS: OnceLock<usize> = OnceLock::new();
    let ptr = *CLASS.get_or_init(|| unsafe {
        let superclass = objc2::runtime::AnyClass::get(&CString::new("NSObject").unwrap())
            .expect("NSObject must exist");
        let name = CString::new("TabversePageChannel").unwrap();
        let cls = objc2::ffi::objc_allocateClassPair(
            superclass as *const AnyClass as *mut _,
            name.as_ptr(),
            0,
        );
        let sel_name = CString::new("userContentController:didReceiveScriptMessage:").unwrap();
        let types = CString::new("v@:@@").unwrap();
        let sel = objc2::ffi::sel_registerName(sel_name.as_ptr())
            .expect("registering the message selector");
        objc2::ffi::class_addMethod(
            cls,
            sel,
            std::mem::transmute::<MsgFn, objc2::runtime::Imp>(did_receive_message),
            types.as_ptr() as *const c_char,
        );
        objc2::ffi::objc_registerClassPair(cls);
        cls as usize
    });
    ptr as *mut AnyClass
}

type MsgFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject);

/// Attach the channel to one browser webview.
pub fn install(app: &AppHandle, webview: *mut AnyObject) {
    let _ = APP.set(app.clone());
    if webview.is_null() {
        return;
    }
    unsafe {
        let config: *mut AnyObject = msg_send![&*webview, configuration];
        if config.is_null() {
            return;
        }
        let controller: *mut AnyObject = msg_send![&*config, userContentController];
        if controller.is_null() {
            return;
        }
        let name = NSString::from_str(HANDLER_NAME);
        // Adding the same name twice raises; a webview is only ever set up
        // once, but removing first makes that guarantee local.
        let () = msg_send![&*controller, removeScriptMessageHandlerForName: &*name];
        let cls = handler_class();
        let handler: *mut AnyObject = msg_send![cls, new];
        let () = msg_send![&*controller, addScriptMessageHandler: &*handler, name: &*name];
    }
}

unsafe extern "C-unwind" fn did_receive_message(
    _this: *mut AnyObject,
    _cmd: Sel,
    _controller: *mut AnyObject,
    message: *mut AnyObject,
) {
    if message.is_null() {
        return;
    }
    let body: *mut AnyObject = msg_send![&*message, body];
    if body.is_null() {
        return;
    }
    let payload = (*(body as *const NSString)).to_string();
    // Which tab: the same webview-to-tab map the failure handlers use.
    let webview: *mut AnyObject = msg_send![&*message, webView];
    let Some(tab_id) = crate::nav_failures::tab_for(webview) else {
        return;
    };
    let Some(app) = APP.get() else { return };
    crate::handle_page_report(app, &tab_id, &payload);
}
