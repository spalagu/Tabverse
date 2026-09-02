//! Keep browser-tab session cookies across restarts.
//!
//! WebKit persists cookies that carry an expiry, but follows the letter of
//! the HTTP spec for session cookies (the ones without one): they die with
//! the process. Desktop browsers stopped doing that years ago — restoring
//! yesterday's tabs restores their session cookies too — and sites park
//! their login in exactly such cookies (GitLab's `_gitlab_session`, most
//! SSO flows). Without this module, a restart restores the tab but not the
//! login behind it, which reads as "the app logged me out".
//!
//! So the app persists session cookies itself: snapshot after every
//! finished page load (plus a slow tick, because an XHR-only login never
//! fires a page load), reinstate synchronously during setup — which runs
//! before any command, so no restored tab's first request can race the
//! restore. Persistent cookies are deliberately left alone: WebKit already
//! stores those, and writing them back would risk clobbering a fresher
//! value with a stale one.
//!
//! The snapshot is login secrets in plain text — like WebKit's own cookie
//! store next door, but tighter: 0600 and session cookies only. Cookie
//! *values* never go to the log, only counts and names' domains.

use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::AppHandle;
use tauri::webview::cookie::{Cookie, Expiration, SameSite};
use tauri::Manager;

// A new namespace is intentional: the key bundle is not derived from or
// compatible with the three legacy Keychain items, so old ciphertext must
// never be opened as though it used the new cookie key.
const FILE_NAME: &str = "browser-session-cookies.v2.sealed";

const SEALED_MAGIC: &[u8] = b"TABVERSECOOKIES2";

fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit};
    let cipher = Aes256Gcm::new(key.into());
    let nonce: [u8; 12] = rand::random();
    let ct = cipher
        .encrypt((&nonce).into(), plaintext)
        .map_err(|e| format!("encrypt: {e}"))?;
    let mut out = Vec::with_capacity(SEALED_MAGIC.len() + nonce.len() + ct.len());
    out.extend_from_slice(SEALED_MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn unseal(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit};
    let rest = &data[SEALED_MAGIC.len()..];
    if rest.len() < 12 {
        return Err("sealed snapshot truncated".into());
    }
    let (nonce, ct) = rest.split_at(12);
    let cipher = Aes256Gcm::new(key.into());
    cipher
        .decrypt(nonce.into(), ct)
        .map_err(|_| "snapshot does not decrypt with this machine's key".to_string())
}

/// How long the snapshot worker waits before acting on a request, so a
/// burst of page loads (a redirect chain) becomes one disk write.
const DEBOUNCE: Duration = Duration::from_millis(200);

/// Fallback snapshot cadence for logins that never navigate (pure-XHR SPA
/// flows set their cookie without a page load ever finishing).
const TICK: Duration = Duration::from_secs(60);

#[derive(serde::Serialize, serde::Deserialize)]
struct SavedCookie {
    name: String,
    value: String,
    domain: Option<String>,
    path: Option<String>,
    secure: Option<bool>,
    http_only: Option<bool>,
    /// "lax" | "strict"; absent means the cookie never specified one.
    same_site: Option<String>,
}

enum WorkerMessage {
    Snapshot,
    Shutdown(mpsc::Sender<()>),
}

static SNAPSHOT_TX: OnceLock<mpsc::Sender<WorkerMessage>> = OnceLock::new();

/// Flips once the saved cookies are back in the store. Snapshots must not
/// run before that: a pre-restore snapshot would faithfully record the
/// still-empty store and overwrite the very file holding the logins.
static RESTORED: AtomicBool = AtomicBool::new(false);
static RESTORE_ONCE: std::sync::Once = std::sync::Once::new();

/// Ask the worker for a snapshot soon. Callable from any thread; a no-op
/// before initialization.
pub fn request_snapshot() {
    // The CEF provider persists session cookies in its native profile store.
    // Keeping this worker Wry-only also avoids two writers racing over one
    // browser session.
    if cfg!(feature = "runtime-cef") {
        return;
    }
    if let Some(tx) = SNAPSHOT_TX.get() {
        let _ = tx.send(WorkerMessage::Snapshot);
    }
}

/// Flush the final snapshot and wait until the worker has stopped using the
/// engine cookie store. CEF requires this before its process-global shutdown.
pub fn shutdown() {
    if cfg!(feature = "runtime-cef") {
        return;
    }
    let Some(tx) = SNAPSHOT_TX.get() else { return };
    let (done_tx, done_rx) = mpsc::channel();
    if tx.send(WorkerMessage::Shutdown(done_tx)).is_ok() {
        let _ = done_rx.recv_timeout(Duration::from_secs(15));
    }
}

/// Run the restore exactly once, before the caller's first browser webview
/// exists; concurrent callers block until the first one finishes.
///
/// Called from `browser_create` — and that placement is load-bearing, not
/// convenience. Cookie writes are handled by the main thread, and while the
/// process is still inside the platform's did-finish-launching notification,
/// handling one wedges the app in a render-flush deadlock (two builds of
/// this module died there: first restoring inside setup, then restoring
/// from a thread whose posted work launch still consumed). A command being
/// executed is proof the main thread is past all that: commands arrive over
/// IPC, and IPC is only pumped by the ordinary event loop.
pub fn ensure_restored(app: &AppHandle) {
    if cfg!(feature = "runtime-cef") {
        return;
    }
    RESTORE_ONCE.call_once(|| {
        restore(app);
        RESTORED.store(true, Ordering::Release);
    });
}

fn file_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    match crate::state_dir(app) {
        Ok(dir) => Some(dir.join(FILE_NAME)),
        Err(e) => {
            eprintln!("[cookies] no state dir, session cookies not kept: {e}");
            None
        }
    }
}

/// Start the snapshot worker. Deliberately does NOT restore — see
/// [`ensure_restored`] for why the restore must wait for the first command.
pub fn init(app: &AppHandle) {
    if cfg!(feature = "runtime-cef") {
        return;
    }
    let (tx, rx) = mpsc::channel::<WorkerMessage>();
    let _ = SNAPSHOT_TX.set(tx);
    let app = app.clone();
    std::thread::Builder::new()
        .name("cookie-snapshot".into())
        .spawn(move || worker(app, rx))
        .expect("spawning the cookie snapshot thread");
    eprintln!("[cookies] snapshot worker running");
}

fn restore(app: &AppHandle) {
    let Some(path) = file_path(app) else { return };
    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            eprintln!("[cookies] cannot read snapshot: {e}");
            return;
        }
    };
    if !data.starts_with(SEALED_MAGIC) {
        // Not this app's format. There is no second format to fall back to
        // and no reader for anything older, so it is left alone and
        // overwritten by the next snapshot.
        eprintln!("[cookies] snapshot is not in this app's format, ignoring it");
        return;
    }
    let key = match crate::credentials::cookie_key() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[cookies] no snapshot key, cookies not restored: {e}");
            return;
        }
    };
    let data = match unseal(&key, &data) {
        Ok(p) => p,
        Err(e) => {
            // A copied-over file or a lost key: treat as no snapshot rather
            // than failing startup over it.
            eprintln!("[cookies] {e}; ignoring snapshot");
            return;
        }
    };
    let saved: Vec<SavedCookie> = match serde_json::from_slice(&data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[cookies] snapshot unreadable, ignoring it: {e}");
            return;
        }
    };
    // Any webview reaches the store — it is one per app, not per webview —
    // and the main UI webview is the only one guaranteed to exist this
    // early. Fetched as window + webview, NOT via get_webview_window: that
    // helper answers None for any window that hosts more than one webview,
    // which is exactly what this window becomes once a browser tab exists.
    let Some(ww) = app.get_window("main").and_then(|w| w.get_webview("main")) else {
        eprintln!("[cookies] main webview missing, cookies not restored");
        return;
    };
    let total = saved.len();
    let mut ok = 0;
    for s in saved {
        let mut b = Cookie::build((s.name, s.value));
        if let Some(d) = s.domain {
            b = b.domain(d);
        }
        if let Some(p) = s.path {
            b = b.path(p);
        }
        // Only ever set these two when TRUE. The platform treats the mere
        // presence of the Secure/HttpOnly cookie properties as the flag
        // being on — the layer below writes booleans as the strings
        // "TRUE"/"FALSE", and "FALSE" still counts as present. A restored
        // non-secure cookie that gets marked Secure this way silently stops
        // riding http requests, and even blocks the site's own subsequent
        // non-secure Set-Cookie for the same name (strict-secure rules) —
        // exactly the trap this module exists to prevent.
        if s.secure == Some(true) {
            b = b.secure(true);
        }
        if s.http_only == Some(true) {
            b = b.http_only(true);
        }
        match s.same_site.as_deref() {
            Some("lax") => b = b.same_site(SameSite::Lax),
            Some("strict") => b = b.same_site(SameSite::Strict),
            // Absent or unknown: leave unspecified, which is what the
            // platform reports for cookies that never said.
            _ => {}
        }
        // Reinstated WITH a bounded expiry, not as a session cookie again:
        // WebKit's network session drops expiry-less cookies injected
        // through the cookie-store API — reads see them, snapshots see
        // them, but no request ever carries them (verified against a local
        // probe server; the webkit.org/b/198553 family). The expiry also
        // hands the cookie to WebKit's own persistence, and it re-enters
        // this file the next time the site refreshes it as a session
        // cookie. Two weeks bounds how long a stale login can resurrect;
        // the server side of the session ages out on its own anyway.
        let expiry = tauri::webview::cookie::time::OffsetDateTime::now_utc()
            + tauri::webview::cookie::time::Duration::days(14);
        b = b.expires(expiry);
        let cookie = b.build();
        let domain = cookie.domain().unwrap_or("").to_string();
        match ww.set_cookie(cookie) {
            Ok(()) => ok += 1,
            Err(e) => eprintln!("[cookies] restore failed for {domain}: {e}"),
        }
    }
    // Writes are fire-and-forget posts to the event loop; this read queues
    // behind them and blocks until answered, so once it returns every write
    // above has actually reached the store. Only then may RESTORED flip.
    let _ = ww.cookies();
    eprintln!("[cookies] restored {ok}/{total} session cookies");
}

fn worker(app: AppHandle, rx: mpsc::Receiver<WorkerMessage>) {
    // Skipping unchanged writes matters because of the tick: without it the
    // file would be rewritten every minute the app sits idle.
    let last_written: Mutex<Option<String>> = Mutex::new(None);
    loop {
        let mut shutdown = None;
        match rx.recv_timeout(TICK) {
            Ok(WorkerMessage::Snapshot) => {
                eprintln!("[cookies] snapshot requested");
                std::thread::sleep(DEBOUNCE);
                while let Ok(message) = rx.try_recv() {
                    if let WorkerMessage::Shutdown(done) = message {
                        shutdown = Some(done);
                        break;
                    }
                }
            }
            Ok(WorkerMessage::Shutdown(done)) => shutdown = Some(done),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        snapshot(&app, &last_written);
        if let Some(done) = shutdown {
            let _ = done.send(());
            eprintln!("[cookies] snapshot worker stopped");
            return;
        }
    }
}

fn snapshot(app: &AppHandle, last_written: &Mutex<Option<String>>) {
    if !RESTORED.load(Ordering::Acquire) {
        return;
    }
    let Some(path) = file_path(app) else { return };
    // Same window-plus-webview fetch as restore(), and for the same reason.
    // A miss here is normal exactly once — during shutdown, after the main
    // window died — so it logs rather than erroring, but it must log:
    // a silent skip once hid this whole feature not running at all.
    let Some(ww) = app.get_window("main").and_then(|w| w.get_webview("main")) else {
        eprintln!("[cookies] main webview gone, snapshot skipped");
        return;
    };
    let cookies = match ww.cookies() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[cookies] cannot read cookie store: {e}");
            return;
        }
    };
    let saved: Vec<SavedCookie> = cookies
        .iter()
        .filter(|c| matches!(c.expires(), Some(Expiration::Session)))
        .map(|c| SavedCookie {
            name: c.name().to_string(),
            value: c.value().to_string(),
            domain: c.domain().map(str::to_string),
            path: c.path().map(str::to_string),
            secure: c.secure(),
            http_only: c.http_only(),
            same_site: match c.same_site() {
                Some(SameSite::Lax) => Some("lax".into()),
                Some(SameSite::Strict) => Some("strict".into()),
                // The platform reports "never specified" as None; storing
                // nothing round-trips that faithfully.
                _ => None,
            },
        })
        .collect();
    let json = match serde_json::to_string(&saved) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[cookies] cannot serialize snapshot: {e}");
            return;
        }
    };
    {
        // Deduplicate on the plaintext: every sealing uses a fresh nonce,
        // so comparing ciphertext would defeat the idle-tick suppression.
        let mut last = last_written.lock().unwrap();
        if last.as_deref() == Some(json.as_str()) {
            return;
        }
        last.replace(json.clone());
    }
    // No key means no snapshot — never fall back to writing plaintext.
    let key = match crate::credentials::cookie_key() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[cookies] no snapshot key, session cookies NOT persisted: {e}");
            return;
        }
    };
    let sealed = match seal(&key, json.as_bytes()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[cookies] cannot seal snapshot: {e}");
            return;
        }
    };
    if let Err(e) = write_atomically(&path, &sealed) {
        eprintln!("[cookies] cannot write snapshot: {e}");
        return;
    }
    eprintln!("[cookies] snapshot: {} session cookies", saved.len());
}

/// Temp-file-and-rename, 0600 before any byte lands: the file holds live
/// logins, and a crash mid-write must never leave a truncated store.
fn write_atomically(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod namespace_tests {
    use super::*;

    #[test]
    fn cookie_runtime_uses_only_the_key_bundle_namespace() {
        assert_eq!(FILE_NAME, "browser-session-cookies.v2.sealed");
        assert_eq!(SEALED_MAGIC, b"TABVERSECOOKIES2");
    }
}
