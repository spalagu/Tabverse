//! Which plane draws on top: the app's own webview, or the pages'.
//!
//! Every page is a child WKWebView added as a SIBLING of the app's own
//! webview inside the window's content view (wry adds both with
//! `addSubview:`), and AppKit draws siblings in array order — last added
//! wins. That single fact is why a DOM menu, a hover panel or a split pane's
//! chrome cannot be seen over a page: `z-index` orders boxes inside one
//! webview and says nothing about two sibling NSViews.
//!
//! The industry answer to exactly this is to reorder the views rather than
//! to hide the page — Electron's own workaround for its `WebContentsView`
//! stacking bug is `removeChildView` + `addChildView`, and a native browser
//! simply keeps its chrome in views that sit above the web content. AppKit
//! spells the same thing as `addSubview:positioned:relativeTo:`, which moves
//! a view already in the tree instead of re-adding it.
//!
//! Raising the app's plane is only half of it: the app's webview paints its
//! own opaque background over everything beneath, so it also has to stop
//! drawing one (`drawsBackground = NO`, the same private KVC key wry uses for
//! its `transparent` feature) and the DOM has to leave the content area
//! transparent. Then the live page shows through wherever the app draws
//! nothing — no snapshot, no parking, and nothing that can flash black.
//!
//! Raw `msg_send!` rather than typed bindings: this crate compiles
//! objc2-app-kit with only the `NSWorkspace` header enabled (see Cargo.toml),
//! and one view reorder does not earn widening that feature set.

#![cfg(target_os = "macos")]

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

/// `NSWindowOrderingMode` values; the enum itself lives behind an
/// objc2-app-kit header feature this crate does not compile.
const NS_WINDOW_ABOVE: isize = 1;
const NS_WINDOW_BELOW: isize = -1;

/// Put a webview above every sibling, or back below them.
///
/// Used for two things: the app's own layer (raised while a piece of the
/// interface overlaps a page) and the peek overlay's page, which must sit
/// above the interface so it stays clickable while the scrim dims everything
/// else.
///
/// `relativeTo: nil` means "above/below all siblings", which is exactly the
/// question being asked — the app's interface either owns the top of the
/// window or it does not; there is never a reason to interleave it between
/// pages.
pub fn set_plane_on_top(webview: &tauri::Webview, on_top: bool) -> Result<(), String> {
    let place = if on_top {
        NS_WINDOW_ABOVE
    } else {
        NS_WINDOW_BELOW
    };
    webview
        .with_webview(move |pw| unsafe {
            let view = pw.inner() as *mut AnyObject;
            let superview: *mut AnyObject = msg_send![view, superview];
            if superview.is_null() {
                eprintln!("[ui-plane] the app webview has no superview");
                return;
            }
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![superview, addSubview: view, positioned: place, relativeTo: nil];
            // Reordering sibling views does not move a stationary mouse, so
            // invalidate the containing view for AppKit's normal cursor-rect
            // bookkeeping. This is only a cache refresh; it is not a cursor
            // ownership fix for overlapping WKWebViews. Browser pages are
            // parked behind a snapshot during the affected floating states.
            let window: *mut AnyObject = msg_send![view, window];
            if !window.is_null() {
                let _: () = msg_send![window, invalidateCursorRectsForView: superview];
            }
            eprintln!("[ui-plane] plane on_top={on_top}");
        })
        .map_err(|e| e.to_string())
}

/// Paint the window itself in the app's own background colour.
///
/// Once the app's webview stops drawing a background, whatever this document
/// leaves transparent shows the window beneath — which is white by default and
/// would flash white exactly where a page is not yet placed. Setting it to the
/// app's own background makes "no page here yet" look like the app, not like a
/// hole.
pub fn set_window_backdrop(window: &tauri::Window, r: f64, g: f64, b: f64) -> Result<(), String> {
    let win = window.clone();
    window
        .run_on_main_thread(move || unsafe {
            let Ok(ptr) = win.ns_window() else {
                return;
            };
            let ns_window = ptr as *mut AnyObject;
            let color: *mut AnyObject = msg_send![
                class!(NSColor),
                colorWithSRGBRed: r, green: g, blue: b, alpha: 1.0f64
            ];
            let _: () = msg_send![ns_window, setBackgroundColor: color];
        })
        .map_err(|e| e.to_string())
}

/// Is this webview the one the keyboard is talking to?
///
/// Asked before taking the keyboard away from a page that is being parked.
/// Reclaiming focus unconditionally is wrong during an unsplit: one pane is
/// parked while another remains visible, so focus must stay with the pane the
/// user is still viewing.
///
/// The first responder is usually an inner content view rather than the
/// WKWebView itself, so the answer walks up the view chain.
pub fn holds_keyboard(webview: &tauri::Webview) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    webview
        .with_webview(move |pw| unsafe {
            let view = pw.inner() as *mut AnyObject;
            let window: *mut AnyObject = msg_send![view, window];
            if window.is_null() {
                let _ = tx.send(false);
                return;
            }
            let mut r: *mut AnyObject = msg_send![window, firstResponder];
            let mut hit = false;
            for _ in 0..32 {
                if r.is_null() {
                    break;
                }
                if std::ptr::eq(r, view) {
                    hit = true;
                    break;
                }
                let is_view: bool = msg_send![r, isKindOfClass: class!(NSView)];
                if !is_view {
                    break;
                }
                r = msg_send![r, superview];
            }
            let _ = tx.send(hit);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())
}

/// Stop the app's webview from painting its own background, so whatever the
/// DOM leaves transparent shows the page sitting behind it.
///
/// `drawsBackground` is a private KVC key on WKWebView. It is the same key
/// wry sets for its `transparent` feature, so this is the path this stack
/// already depends on rather than a new bet.
pub fn set_app_plane_transparent(
    webview: &tauri::Webview,
    transparent: bool,
) -> Result<(), String> {
    webview
        .with_webview(move |pw| unsafe {
            let view = pw.inner() as *mut AnyObject;
            let value: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: !transparent];
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![view, setValue: value, forKey: &*key];
            eprintln!("[ui-plane] app plane transparent={transparent}");
        })
        .map_err(|e| e.to_string())
}
