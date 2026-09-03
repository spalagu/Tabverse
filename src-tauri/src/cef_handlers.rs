#![cfg(feature = "runtime-cef")]

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex,
    },
};

use tauri::Emitter;
use tauri_runtime_cef::{
    AuthenticationRequest, AuthenticationResponder, CertificateErrorRequest,
    CertificateErrorResponder, MediaAccessRequest, MediaAccessResponder, PermissionPromptRequest,
    PermissionPromptResponder,
};

use crate::AppHandle;

static NEXT_PROMPT_ID: AtomicU64 = AtomicU64::new(1);
static AUTH: LazyLock<Mutex<HashMap<u64, PendingAuth>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PERMISSIONS: LazyLock<Mutex<HashMap<u64, PendingPermission>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct PendingAuth {
    responder: AuthenticationResponder,
    key: String,
}

enum PendingPermission {
    General(PermissionPromptResponder),
    Media {
        responder: MediaAccessResponder,
        kinds: Vec<tauri::webview::PermissionKind>,
        origin: String,
        kind: String,
    },
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthRequestEvent {
    challenge_id: u64,
    host: String,
    realm: String,
    failed_username: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionEvent {
    dialog_id: u64,
    kind: String,
    origin: String,
    message: String,
    default_text: String,
}

pub fn authentication(
    app: AppHandle,
    request: AuthenticationRequest,
    responder: AuthenticationResponder,
) {
    let id = NEXT_PROMPT_ID.fetch_add(1, Ordering::Relaxed);
    let key = format!("{}:{}", request.host, request.port);
    AUTH.lock()
        .unwrap()
        .insert(id, PendingAuth { responder, key });
    let host = if matches!(request.port, 80 | 443) {
        request.host
    } else {
        format!("{}:{}", request.host, request.port)
    };
    let _ = app.emit(
        "browser-auth-request",
        AuthRequestEvent {
            challenge_id: id,
            host,
            realm: request.realm,
            failed_username: None,
        },
    );
}

pub fn answer_auth(
    challenge_id: u64,
    username: Option<String>,
    password: Option<String>,
    save: bool,
) -> Result<(), String> {
    let pending = AUTH
        .lock()
        .unwrap()
        .remove(&challenge_id)
        .ok_or_else(|| format!("unknown CEF authentication challenge: {challenge_id}"))?;
    match (username, password) {
        (Some(username), Some(password)) => {
            if save {
                crate::credentials::save_http_auth(&pending.key, &username, &password)?;
            }
            pending.responder.continue_with(&username, &password);
        }
        _ => pending.responder.cancel(),
    }
    Ok(())
}

pub fn certificate(
    app: AppHandle,
    tab_id: String,
    request: CertificateErrorRequest,
    responder: CertificateErrorResponder,
) {
    let trusted = request
        .request_url
        .parse::<tauri::Url>()
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| crate::trusted_hosts::is_trusted(&app, &host));
    if trusted {
        responder.continue_once();
        return;
    }
    crate::nav_report::report(
        &app,
        &tab_id,
        &request.request_url,
        crate::nav_report::Trouble::Certificate,
    );
    responder.cancel();
}

pub fn permission(
    app: AppHandle,
    request: PermissionPromptRequest,
    responder: PermissionPromptResponder,
) {
    let id = NEXT_PROMPT_ID.fetch_add(1, Ordering::Relaxed);
    PERMISSIONS
        .lock()
        .unwrap()
        .insert(id, PendingPermission::General(responder));
    let _ = app.emit(
        "browser-dialog",
        PermissionEvent {
            dialog_id: id,
            kind: "permission".into(),
            origin: request.requesting_origin,
            message: format!(
                "The page requests {} browser permission(s).",
                request.kinds.len()
            ),
            default_text: String::new(),
        },
    );
}

pub fn media(app: AppHandle, request: MediaAccessRequest, responder: MediaAccessResponder) {
    let origin = request
        .requesting_origin
        .parse::<tauri::Url>()
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    let has_audio = request
        .kinds
        .contains(&tauri::webview::PermissionKind::Microphone);
    let has_video = request
        .kinds
        .contains(&tauri::webview::PermissionKind::Camera);
    let kind = match (has_audio, has_video) {
        (true, true) => "camera and microphone",
        (true, false) => "microphone",
        (false, true) => "camera",
        (false, false) => "media",
    }
    .to_string();
    if let Some(allow) = crate::page_prompts::remembered(&app, &origin, &kind) {
        if allow {
            responder.allow(&request.kinds);
        } else {
            responder.deny();
        }
        return;
    }
    let id = NEXT_PROMPT_ID.fetch_add(1, Ordering::Relaxed);
    PERMISSIONS.lock().unwrap().insert(
        id,
        PendingPermission::Media {
            responder,
            kinds: request.kinds,
            origin: origin.clone(),
            kind: kind.clone(),
        },
    );
    let _ = app.emit(
        "browser-dialog",
        PermissionEvent {
            dialog_id: id,
            kind,
            origin,
            message: String::new(),
            default_text: String::new(),
        },
    );
}

pub fn answer_permission(
    app: &AppHandle,
    dialog_id: u64,
    allow: bool,
    remember: bool,
) -> Result<bool, String> {
    let Some(pending) = PERMISSIONS.lock().unwrap().remove(&dialog_id) else {
        return Ok(false);
    };
    match pending {
        PendingPermission::General(responder) => {
            if allow {
                responder.allow();
            } else {
                responder.deny();
            }
        }
        PendingPermission::Media {
            responder,
            kinds,
            origin,
            kind,
        } => {
            if remember {
                crate::page_prompts::remember(app, &origin, &kind, allow);
            }
            if allow {
                responder.allow(&kinds);
            } else {
                responder.deny();
            }
        }
    }
    Ok(true)
}
