#![cfg(target_os = "macos")]

#[cfg(feature = "runtime-wry")]
use std::ffi::CString;
use std::sync::mpsc::Sender;

#[cfg(feature = "runtime-wry")]
use base64::Engine as _;
#[cfg(feature = "runtime-wry")]
use block2::RcBlock;
#[cfg(feature = "runtime-wry")]
use objc2::msg_send;
#[cfg(feature = "runtime-wry")]
use objc2::runtime::{AnyClass, AnyObject};
#[cfg(feature = "runtime-wry")]
use objc2_app_kit::NSImage;
#[cfg(feature = "runtime-wry")]
use objc2_foundation::NSError;
#[cfg(feature = "runtime-wry")]
use objc2_web_kit::WKWebView;

#[cfg(feature = "runtime-wry")]
pub fn take(webview: &crate::Webview, tx: Sender<Result<String, String>>) {
    // The closure runs on the main thread (the only thread WebKit may be
    // spoken to from); the completion handler is invoked there later, and
    // the channel carries the bytes back to the waiting command.
    let outcome = webview.with_webview(move |pw| unsafe {
        let wk: &WKWebView = &*pw.inner().cast();
        let reply = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let _ = tx.send(encode(image, error));
        });
        // No configuration: the default captures the visible viewport at
        // the page's own scale, which is exactly the slot the image will
        // be laid back over.
        wk.takeSnapshotWithConfiguration_completionHandler(None, &reply);
    });
    if let Err(e) = outcome {
        // The closure never ran, so `tx` died with it and the waiting
        // command sees a disconnect; the log says why.
        eprintln!("[snapshot] could not reach the webview: {e}");
    }
}

#[cfg(feature = "runtime-cef")]
pub fn take(_webview: &crate::Webview, tx: Sender<Result<String, String>>) {
    let _ = tx.send(Err(
        "CEF page snapshots require the Chromium capture provider".into(),
    ));
}

/// NSImage -> PNG bytes -> data URL, by direct message sends.
///
/// Raw `msg_send` rather than typed bindings: NSBitmapImageRep is not among
/// the AppKit classes this crate's feature set compiles typed wrappers for,
/// and one conversion does not earn widening it.
#[cfg(feature = "runtime-wry")]
unsafe fn encode(image: *mut NSImage, error: *mut NSError) -> Result<String, String> {
    if image.is_null() {
        let code: isize = if error.is_null() {
            0
        } else {
            msg_send![&*error, code]
        };
        return Err(format!("the engine returned no image (code {code})"));
    }
    let img = image as *mut AnyObject;
    let tiff: *mut AnyObject = msg_send![&*img, TIFFRepresentation];
    if tiff.is_null() {
        return Err("the snapshot image holds no bitmap".into());
    }
    let rep_cls = class("NSBitmapImageRep")?;
    let rep: *mut AnyObject = msg_send![rep_cls, imageRepWithData: &*tiff];
    if rep.is_null() {
        return Err("the snapshot bitmap could not be read".into());
    }
    // representationUsingType:properties: wants a dictionary, not nil.
    let dict_cls = class("NSDictionary")?;
    let props: *mut AnyObject = msg_send![dict_cls, dictionary];
    // NSBitmapImageFileTypePNG = 4.
    let png: *mut AnyObject =
        msg_send![&*rep, representationUsingType: 4usize, properties: &*props];
    if png.is_null() {
        return Err("the snapshot could not be encoded as PNG".into());
    }
    let len: usize = msg_send![&*png, length];
    let bytes: *const u8 = msg_send![&*png, bytes];
    if bytes.is_null() || len == 0 {
        return Err("the encoded snapshot is empty".into());
    }
    let data = std::slice::from_raw_parts(bytes, len);
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    ))
}

#[cfg(feature = "runtime-wry")]
fn class(name: &str) -> Result<&'static AnyClass, String> {
    let c = CString::new(name).map_err(|e| e.to_string())?;
    AnyClass::get(&c).ok_or_else(|| format!("{name} is missing from this system"))
}
