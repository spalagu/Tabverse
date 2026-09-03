#![cfg(target_os = "windows")]

use crate::AppHandle;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
use webview2_com::WebMessageReceivedEventHandler;

/// Listen to one browser tab's page.
///
/// The tab is captured rather than looked up: on this platform there is no
/// pointer-to-tab map to consult, and one handler per webview knows which
/// tab it belongs to by construction.
pub fn install(app: &AppHandle, controller: &ICoreWebView2Controller, tab_id: String) {
    let app = app.clone();
    unsafe {
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[page-channel] no core webview, page reports are off: {e}");
                return;
            }
        };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_webview, args| {
            let Some(args) = args else { return Ok(()) };
            let mut raw = windows::core::PWSTR::null();
            // A page can post something that is not a string; that is not
            // ours and is nothing to complain about.
            if args.TryGetWebMessageAsString(&mut raw).is_err() {
                return Ok(());
            }
            // Takes ownership and frees what the engine allocated.
            let payload = webview2_com::take_pwstr(raw);
            // The token still gates it: this channel is reachable by any
            // script on the page, not only the one the app injected.
            crate::handle_page_report(&app, &tab_id, &payload);
            Ok(())
        }));
        let mut token = Default::default();
        if let Err(e) = core.add_WebMessageReceived(&handler, &mut token) {
            eprintln!("[page-channel] could not listen for page reports: {e}");
            return;
        }
        eprintln!("[page-channel] listening on this tab's page");
    }
}
