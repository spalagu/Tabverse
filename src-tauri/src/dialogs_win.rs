#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::sync::Mutex;

use crate::AppHandle;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Deferral, ICoreWebView2PermissionRequestedEventArgs,
    ICoreWebView2ScriptDialogOpeningEventArgs, COREWEBVIEW2_PERMISSION_KIND,
    COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    COREWEBVIEW2_SCRIPT_DIALOG_KIND, COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD,
    COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM, COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT,
};
use webview2_com::{PermissionRequestedEventHandler, ScriptDialogOpeningEventHandler};

use crate::page_prompts::{self, DialogEvent};

/// A question on screen, waiting for its answer.
enum Pending {
    Script {
        args: ICoreWebView2ScriptDialogOpeningEventArgs,
        deferral: ICoreWebView2Deferral,
    },
    Permission {
        args: ICoreWebView2PermissionRequestedEventArgs,
        deferral: ICoreWebView2Deferral,
        host: String,
        kind: &'static str,
    },
}

// Touched only on the thread that received the event or on the main thread
// the answer is dispatched to; the map itself is guarded.
unsafe impl Send for Pending {}

static PENDING: Mutex<Option<HashMap<u64, Pending>>> = Mutex::new(None);
static NEXT_ID: Mutex<u64> = Mutex::new(1);

fn take_id() -> u64 {
    let mut n = NEXT_ID.lock().unwrap();
    let id = *n;
    *n += 1;
    id
}

unsafe fn text_of(
    read: impl FnOnce(*mut windows::core::PWSTR) -> windows::core::Result<()>,
) -> String {
    let mut raw = windows::core::PWSTR::null();
    match read(&mut raw) {
        Ok(()) => webview2_com::take_pwstr(raw),
        Err(_) => String::new(),
    }
}

fn permission_name(kind: COREWEBVIEW2_PERMISSION_KIND) -> Option<&'static str> {
    match kind {
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => Some("camera"),
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => Some("microphone"),
        // Everything else keeps the engine's own handling: this app has
        // nothing to say about notifications or MIDI, and pretending to
        // decide would mean deciding badly.
        _ => None,
    }
}

pub fn install(app: &AppHandle, controller: &ICoreWebView2Controller, tab_id: String) {
    unsafe {
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[dialogs] no core webview, page dialogs stay the engine's: {e}");
                return;
            }
        };

        // alert / confirm / prompt.
        {
            let app = app.clone();
            let handler =
                ScriptDialogOpeningEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND::default();
                    if args.Kind(&mut kind).is_err() {
                        return Ok(());
                    }
                    if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD {
                        return Ok(());
                    }
                    let named = if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM {
                        "confirm"
                    } else if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT {
                        "prompt"
                    } else {
                        "alert"
                    };
                    let message = text_of(|p| args.Message(p));
                    let default_text = text_of(|p| args.DefaultText(p));
                    let origin = page_prompts::origin_of(&text_of(|p| args.Uri(p)));
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
                            Pending::Script {
                                args: args.clone(),
                                deferral,
                            },
                        );
                    page_prompts::ask(
                        &app,
                        DialogEvent {
                            dialog_id: id,
                            kind: named,
                            origin,
                            message,
                            default_text,
                        },
                    );
                    Ok(())
                }));
            let mut token = Default::default();
            if let Err(e) = core.add_ScriptDialogOpening(&handler, &mut token) {
                eprintln!("[dialogs] page dialogs stay the engine's: {e}");
            }
        }

        // The camera and the microphone.
        {
            let app = app.clone();
            let handler =
                PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    if args.PermissionKind(&mut kind).is_err() {
                        return Ok(());
                    }
                    let Some(named) = permission_name(kind) else {
                        return Ok(());
                    };
                    let host = page_prompts::origin_of(&text_of(|p| args.Uri(p)));

                    // Answered before for this site: honour it without asking.
                    if let Some(allow) = page_prompts::remembered(&app, &host, named) {
                        let _ = args.SetState(if allow {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        });
                        return Ok(());
                    }

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
                            Pending::Permission {
                                args: args.clone(),
                                deferral,
                                host: host.clone(),
                                kind: named,
                            },
                        );
                    eprintln!("[dialogs] {named} asked for by {host} on tab={tab_id}");
                    page_prompts::ask(
                        &app,
                        DialogEvent {
                            dialog_id: id,
                            kind: named,
                            origin: host,
                            message: String::new(),
                            default_text: String::new(),
                        },
                    );
                    Ok(())
                }));
            let mut token = Default::default();
            if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
                eprintln!("[dialogs] camera and microphone stay the engine's: {e}");
            }
        }
    }
}

/// The user's answer. `ok` is the confirm/permission verdict; `text` is the
/// prompt's reply.
pub fn answer(
    app: AppHandle,
    dialog_id: u64,
    ok: bool,
    text: Option<String>,
    remember_choice: bool,
    _kind: Option<String>,
) -> Result<(), String> {
    let for_memory = app.clone();
    app.run_on_main_thread(move || {
        let Some(pending) = PENDING
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|m| m.remove(&dialog_id))
        else {
            eprintln!("[dialogs] answer for unknown dialog {dialog_id}, dropped");
            return;
        };
        unsafe {
            match pending {
                Pending::Script { args, deferral } => {
                    if ok {
                        let _ = args.Accept();
                        if let Some(reply) = text {
                            let wide: Vec<u16> =
                                reply.encode_utf16().chain(std::iter::once(0)).collect();
                            let _ = args.SetResultText(windows::core::PCWSTR(wide.as_ptr()));
                        }
                    }
                    // Not accepting is how this engine hears "cancelled";
                    // an empty reply is a legitimate answer and must stay
                    // distinguishable from it.
                    let _ = deferral.Complete();
                }
                Pending::Permission {
                    args,
                    deferral,
                    host,
                    kind,
                } => {
                    let _ = args.SetState(if ok {
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    } else {
                        COREWEBVIEW2_PERMISSION_STATE_DENY
                    });
                    if remember_choice {
                        page_prompts::remember(&for_memory, &host, kind, ok);
                    }
                    let _ = deferral.Complete();
                }
            }
        }
    })
    .map_err(|e| e.to_string())
}
