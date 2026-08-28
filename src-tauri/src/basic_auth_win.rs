#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use webview2_com::BasicAuthenticationRequestedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2BasicAuthenticationRequestedEventArgs, ICoreWebView2Controller,
    ICoreWebView2Deferral, ICoreWebView2_10,
};
use windows_core::Interface;

/// A challenge waiting for an answer. Held on the main thread's side of the
/// app because the interfaces are not `Send`; the map is keyed by an id the
/// interface layer hands out and hands back.
struct Pending {
    args: ICoreWebView2BasicAuthenticationRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
    /// Where to save it if the user says to: host, or host:port.
    key: String,
}

// The COM interfaces are apartment-bound, and every touch of them happens
// on the thread that received the event or on the main thread the answer is
// dispatched to. The map itself is guarded.
unsafe impl Send for Pending {}

static PENDING: Mutex<Option<HashMap<u64, Pending>>> = Mutex::new(None);
static NEXT_ID: Mutex<u64> = Mutex::new(1);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthRequestEvent {
    challenge_id: u64,
    host: String,
    realm: String,
    failed_username: Option<String>,
}

fn take_id() -> u64 {
    let mut n = NEXT_ID.lock().unwrap();
    let id = *n;
    *n += 1;
    id
}

pub fn install(app: &AppHandle, controller: &ICoreWebView2Controller, tab_id: String) {
    let app = app.clone();
    unsafe {
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[auth] no core webview, challenges cannot be answered: {e}");
                return;
            }
        };
        let handler =
            BasicAuthenticationRequestedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };

                let mut raw = windows::core::PWSTR::null();
                let uri = if args.Uri(&mut raw).is_ok() {
                    webview2_com::take_pwstr(raw)
                } else {
                    String::new()
                };
                let parsed = uri.parse::<tauri::Url>().ok();
                let host = parsed
                    .as_ref()
                    .and_then(|u| u.host_str().map(str::to_string))
                    .unwrap_or_default();
                let port = parsed.as_ref().and_then(|u| u.port());
                // The saved-credential key: host alone on a default port,
                // host:port otherwise, so two services on one machine do
                // not share one saved login.
                let key = match port {
                    Some(p) => format!("{host}:{p}"),
                    None => host.clone(),
                };

                let realm = match args.Challenge(&mut raw) {
                    Ok(()) => webview2_com::take_pwstr(raw),
                    Err(_) => String::new(),
                };

                // A login already saved for this key answers by itself —
                // the same as everywhere else a password is remembered.
                if let Ok(saved) = crate::credentials::find_http_auth(&key) {
                    if let Some(cred) = saved.into_iter().next() {
                        if let Ok(response) = args.Response() {
                            let user: Vec<u16> = cred
                                .username
                                .encode_utf16()
                                .chain(std::iter::once(0))
                                .collect();
                            let pass: Vec<u16> = cred
                                .password
                                .encode_utf16()
                                .chain(std::iter::once(0))
                                .collect();
                            let _ = response.SetUserName(windows::core::PCWSTR(user.as_ptr()));
                            let _ = response.SetPassword(windows::core::PCWSTR(pass.as_ptr()));
                            return Ok(());
                        }
                    }
                }

                // Nobody can answer synchronously: a person has to type.
                let Ok(deferral) = args.GetDeferral() else {
                    return Ok(());
                };
                let id = take_id();
                PENDING
                    .lock()
                    .unwrap()
                    .get_or_insert_with(HashMap::new)
                    .insert(
                        id,
                        Pending {
                            args: args.clone(),
                            deferral,
                            key,
                        },
                    );
                eprintln!("[auth] challenge {id} on tab={tab_id} for {host}");
                let _ = app.emit(
                    "browser-auth-request",
                    AuthRequestEvent {
                        challenge_id: id,
                        host,
                        realm,
                        failed_username: None,
                    },
                );
                Ok(())
            }));
        // Added in a later revision of the interface; asked for rather
        // than assumed, so an older runtime says so once.
        match core.cast::<ICoreWebView2_10>() {
            Ok(v10) => {
                let mut token = Default::default();
                if let Err(e) = v10.add_BasicAuthenticationRequested(&handler, &mut token) {
                    eprintln!("[auth] could not listen for authentication challenges: {e}");
                }
            }
            Err(e) => eprintln!("[auth] this runtime cannot report challenges: {e}"),
        }
    }
}

/// The user answered — or dismissed it, which is also an answer.
pub fn answer(
    app: AppHandle,
    challenge_id: u64,
    username: Option<String>,
    password: Option<String>,
    save: bool,
) -> Result<(), String> {
    app.run_on_main_thread(move || {
        let Some(pending) = PENDING
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|m| m.remove(&challenge_id))
        else {
            eprintln!("[auth] answer for unknown challenge {challenge_id}, dropped");
            return;
        };
        unsafe {
            match (username, password) {
                (Some(u), Some(p)) => {
                    if save {
                        if let Err(e) = crate::credentials::save_http_auth(&pending.key, &u, &p) {
                            eprintln!("[auth] could not save credential: {e}");
                        }
                    }
                    if let Ok(response) = pending.args.Response() {
                        let user: Vec<u16> = u.encode_utf16().chain(std::iter::once(0)).collect();
                        let pass: Vec<u16> = p.encode_utf16().chain(std::iter::once(0)).collect();
                        let _ = response.SetUserName(windows::core::PCWSTR(user.as_ptr()));
                        let _ = response.SetPassword(windows::core::PCWSTR(pass.as_ptr()));
                    }
                }
                // Dismissed: cancelled explicitly, so the page gets the
                // engine's own "not authorized" rather than hanging on a
                // deferral nobody ever completes.
                _ => {
                    let _ = pending.args.SetCancel(true);
                }
            }
            let _ = pending.deferral.Complete();
        }
    })
    .map_err(|e| e.to_string())
}
