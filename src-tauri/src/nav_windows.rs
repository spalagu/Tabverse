#![cfg(target_os = "windows")]

use crate::AppHandle;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2_14,
    COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW, COREWEBVIEW2_WEB_ERROR_STATUS,
    COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT,
    COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT,
    COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED,
    COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID,
    COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED, COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED,
    COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED,
    COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED,
    COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE, COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT,
};
use webview2_com::{NavigationCompletedEventHandler, ServerCertificateErrorDetectedEventHandler};
use windows_core::Interface;

use crate::nav_report::Trouble;

/// This engine's error status, in the vocabulary both engines share.
fn classify(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> Option<Trouble> {
    Some(match status {
        COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => Trouble::UnknownHost,
        COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT
        | COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE => Trouble::Refused,
        COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => Trouble::TimedOut,
        COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => Trouble::Offline,
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED => Trouble::Certificate,
        // Ours: the command channel starts a navigation and cancels it, so
        // cancellations arrive constantly and mean nothing. Reporting them
        // would put an error on screen for every keyboard shortcut.
        COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED => return None,
        other => Trouble::Unclassified(format!("the engine reported error status {}", other.0)),
    })
}

/// Read the address the page is at, for a message that can name the site.
unsafe fn current_url(core: &ICoreWebView2) -> String {
    let mut raw = windows::core::PWSTR::null();
    if core.Source(&mut raw).is_err() {
        return String::new();
    }
    webview2_com::take_pwstr(raw)
}

pub fn install(app: &AppHandle, controller: &ICoreWebView2Controller, tab_id: String) {
    unsafe {
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[nav] no core webview, failures will not be reported: {e}");
                return;
            }
        };

        // Why a page did not open.
        {
            let app = app.clone();
            let tab_id = tab_id.clone();
            let handler = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else {
                    return Ok(());
                };
                // A page that loaded has nothing to explain. Every getter
                // in these bindings answers through an out-parameter.
                let mut ok = windows::core::BOOL::default();
                if args.IsSuccess(&mut ok).is_err() || ok.as_bool() {
                    return Ok(());
                }
                let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                if args.WebErrorStatus(&mut status).is_err() {
                    return Ok(());
                }
                let Some(trouble) = classify(status) else {
                    return Ok(());
                };
                let url = current_url(&sender);
                eprintln!(
                    "[nav] failure on tab={tab_id} url={url} (status {})",
                    status.0
                );
                crate::nav_report::report(&app, &tab_id, &url, trouble);
                Ok(())
            }));
            let mut token = Default::default();
            if let Err(e) = core.add_NavigationCompleted(&handler, &mut token) {
                eprintln!("[nav] could not listen for navigation failures: {e}");
            }
        }

        // The way past a certificate the machine does not trust.
        {
            let app = app.clone();
            let tab_id = tab_id.clone();
            let handler = ServerCertificateErrorDetectedEventHandler::create(Box::new(
                move |_sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut raw = windows::core::PWSTR::null();
                    let host = if args.RequestUri(&mut raw).is_ok() {
                        let uri = webview2_com::take_pwstr(raw);
                        uri.parse::<tauri::Url>()
                            .ok()
                            .and_then(|u| u.host_str().map(str::to_string))
                            .unwrap_or_default()
                    } else {
                        String::new()
                    };
                    if !host.is_empty() && crate::trusted_hosts::is_trusted(&app, &host) {
                        let _ = args
                            .SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW);
                        return Ok(());
                    }
                    // Otherwise it is refused, and named as a certificate
                    // problem rather than a network one, so the tab can
                    // offer to proceed.
                    eprintln!("[nav] certificate refused on tab={tab_id} host={host}");
                    crate::nav_report::report(
                        &app,
                        &tab_id,
                        &format!("https://{host}/"),
                        Trouble::Certificate,
                    );
                    Ok(())
                },
            ));
            // The event arrived in a later revision of the interface, so
            // the core view is asked for that revision rather than assumed
            // to have it: an older runtime simply has no certificate
            // decisions, and says so once instead of failing to build.
            match core.cast::<ICoreWebView2_14>() {
                Ok(v14) => {
                    let mut token = Default::default();
                    if let Err(e) = v14.add_ServerCertificateErrorDetected(&handler, &mut token) {
                        eprintln!("[nav] no certificate decisions on this runtime: {e}");
                    }
                }
                Err(e) => eprintln!("[nav] this runtime is too old for certificate decisions: {e}"),
            }
        }
    }
}
