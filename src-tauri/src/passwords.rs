use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use tauri::{AppHandle, Emitter, Manager, State};

/// Captured-but-not-yet-saved logins. The prompt's owning tab and displayed
/// account are part of the key, so concurrent submissions on one host cannot
/// make a prompt save another tab's password.
type PendingKey = (String, String, String);
static PENDING: Mutex<Option<HashMap<PendingKey, String>>> = Mutex::new(None);
static NEVER_WRITE: Mutex<()> = Mutex::new(());

fn pending_insert(tab_id: String, host: String, username: String, password: String) {
    let mut p = PENDING.lock().unwrap();
    p.get_or_insert_with(HashMap::new)
        .insert((tab_id, host, username), password);
}

fn pending_take(tab_id: &str, host: &str, username: &str) -> Option<String> {
    PENDING.lock().unwrap().as_mut()?.remove(&(
        tab_id.to_string(),
        host.to_string(),
        username.to_string(),
    ))
}

const NEVER_SCOPE: &str = "password-never";

fn never_list(app: &AppHandle) -> Result<Vec<String>, String> {
    let Some(json) = crate::app_state_store(app)?
        .load_scope(NEVER_SCOPE)
        .map_err(|e| format!("read password exclusions from app.db: {e:#}"))?
    else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&json)
        .map_err(|e| format!("password exclusions in app.db are invalid: {e}"))
}

fn never_add(app: &AppHandle, host: &str) -> Result<(), String> {
    let _write = NEVER_WRITE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut list = never_list(app)?;
    if list.iter().any(|h| h == host) {
        return Ok(());
    }
    list.push(host.to_string());
    let json =
        serde_json::to_string(&list).map_err(|e| format!("serialize password exclusions: {e}"))?;
    crate::app_state_store(app)?
        .save_scope(NEVER_SCOPE, &json)
        .map_err(|e| format!("save password exclusions to app.db: {e:#}"))
}

#[derive(serde::Deserialize)]
struct CapturedLogin {
    host: String,
    username: String,
    password: String,
}

/// Handle a `save-password?t=TOKEN&d=<b64 json>` report. Token is already
/// verified by the caller. Never log anything from `d` except the host.
pub fn handle_capture(app: &AppHandle, tab_id: &str, data_b64: &str) {
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_b64) else {
        return;
    };
    let Ok(cap) = serde_json::from_slice::<CapturedLogin>(&bytes) else {
        return;
    };
    if cap.host.is_empty() || cap.password.is_empty() {
        return;
    }
    match never_list(app) {
        Ok(list) if list.iter().any(|h| h == &cap.host) => return,
        Ok(_) => {}
        Err(error) => {
            eprintln!("[passwords] {error}");
            return;
        }
    }
    // Already saved with this exact value: nothing to offer. A different
    // value for the same user is an update worth asking about.
    if let Ok(saved) = crate::credentials::find_web(&cap.host) {
        if saved
            .iter()
            .any(|c| c.username == cap.username && c.password == cap.password)
        {
            return;
        }
    }
    eprintln!("[passwords] captured a login for {}", cap.host);
    pending_insert(
        tab_id.to_string(),
        cap.host.clone(),
        cap.username.clone(),
        cap.password,
    );
    // Which tab captured it (2026-08-12 review). The offer used to be
    // claimed by whichever browser view happened to be in front, which is the
    // same guess that put one tab's favicon on every tab of its host: a page's
    // report means nothing until it says whose page it was.
    let _ = app.emit(
        "browser-password-offer",
        serde_json::json!({ "tabId": tab_id, "host": cap.host, "username": cap.username }),
    );
}

/// Handle a `pw-form?t=TOKEN` report from a page that has a password field:
/// announce stored usernames for that tab so the UI can offer to fill.
pub fn handle_form_present(app: &AppHandle, tab_id: &str, host: &str) {
    if host.is_empty() {
        return;
    }
    let Ok(saved) = crate::credentials::find_web(host) else {
        return;
    };
    if saved.is_empty() {
        return;
    }
    let usernames: Vec<String> = saved.into_iter().map(|c| c.username).collect();
    let _ = app.emit(
        "browser-password-fillable",
        serde_json::json!({ "tabId": tab_id, "host": host, "usernames": usernames }),
    );
}

/// Injected into every browser page's top frame. Reports ride a hidden
/// iframe pointed at the command scheme — cancelled by the app — because a
/// top-frame navigation here would race the form submission being observed.
pub fn capture_script() -> String {
    format!(
        r#"(function() {{
  if (window.top !== window) return;
  var TOKEN = "{token}", SCHEME = "{scheme}";
  function report(path) {{
    try {{
      window.webkit.messageHandlers.{handler}.postMessage(path);
      return;
    }} catch (_) {{}}
    try {{ window.chrome.webview.postMessage(path); }} catch (_) {{}}
  }}
  // What the last filled password field held, and who it belonged to.
  // The app decides whether it is worth offering; this only remembers.
  var seen = null;
  function offer() {{
    if (!seen) return;
    var payload = JSON.stringify(seen);
    seen = null;
    report("save-password?t=" + TOKEN + "&d=" +
      encodeURIComponent(btoa(unescape(encodeURIComponent(payload)))));
  }}
  function readPair(scope) {{
    var pw = scope.querySelector('input[type="password"]');
    if (!pw || !pw.value) return null;
    var user = "";
    var candidates = scope.querySelectorAll(
      'input[type="text"],input[type="email"],input:not([type])');
    for (var i = 0; i < candidates.length; i++) {{
      if (candidates[i].value) {{ user = candidates[i].value; break; }}
    }}
    return {{ host: location.origin, username: user, password: pw.value }};
  }}
  document.addEventListener("submit", function(e) {{
    if (!e.isTrusted) return;
    var form = e.target;
    if (!form || !form.querySelectorAll) return;
    var pair = readPair(form);
    if (!pair) return;
    seen = pair;
    offer();
  }}, true);
  document.addEventListener("input", function(e) {{
    var t = e.target;
    if (!t || t.tagName !== "INPUT") return;
    if (t.type !== "password" && t.type !== "text" && t.type !== "email") return;
    var pair = readPair(t.form || document);
    if (pair) seen = pair;
  }}, true);
  var gone = new MutationObserver(function() {{
    if (seen && !document.querySelector('input[type="password"]')) offer();
  }});
  function watch() {{
    if (document.body) gone.observe(document.body, {{ childList: true, subtree: true }});
  }}
  if (document.body) watch(); else document.addEventListener("DOMContentLoaded", watch);
  ["pushState", "replaceState"].forEach(function(name) {{
    var orig = history[name];
    if (typeof orig !== "function") return;
    history[name] = function() {{
      var r = orig.apply(this, arguments);
      offer();
      return r;
    }};
  }});
  window.addEventListener("popstate", offer);
  function probe() {{
    if (document.querySelector('input[type="password"]')) {{
      report("pw-form?t=" + TOKEN + "&h=" + encodeURIComponent(location.origin));
      return true;
    }}
    return false;
  }}
  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", function() {{
      if (!probe()) setTimeout(probe, 3000);
    }});
  }} else if (!probe()) {{
    setTimeout(probe, 3000);
  }}
}})();"#,
        token = crate::cmd_token(),
        scheme = crate::CMD_SCHEME,
        handler = crate::PAGE_CHANNEL,
    )
}

#[tauri::command]
pub fn pw_offer_save(tab_id: String, host: String, username: String) -> Result<(), String> {
    let Some(pass) = pending_take(&tab_id, &host, &username) else {
        return Err("no matching pending credential".into());
    };
    crate::credentials::save_web(&host, &username, &pass)?;
    eprintln!("[passwords] saved a login for {host}");
    Ok(())
}

#[tauri::command]
pub fn pw_offer_dismiss(
    app: AppHandle,
    tab_id: String,
    host: String,
    username: String,
    never: bool,
) -> Result<(), String> {
    let _ = pending_take(&tab_id, &host, &username);
    if never {
        never_add(&app, &host)?;
        eprintln!("[passwords] never offering for {host}");
    }
    Ok(())
}

#[tauri::command]
pub fn pw_list() -> Result<Vec<(String, String)>, String> {
    crate::credentials::list_web()
}

#[tauri::command]
pub fn pw_delete(host: String, username: String) -> Result<(), String> {
    crate::credentials::delete_web(&host, &username)
}

fn fill_script(cred: &crate::credentials::WebCredential) -> Result<String, String> {
    // serde_json string literals are exactly JS string literals, escaping
    // included — the credential rides as data, never as code.
    let host_js = serde_json::to_string(&cred.host).map_err(|e| e.to_string())?;
    let user_js = serde_json::to_string(&cred.username).map_err(|e| e.to_string())?;
    let pass_js = serde_json::to_string(&cred.password).map_err(|e| e.to_string())?;
    Ok(format!(
        r#"(function() {{
  if (location.origin !== {host_js}) return;
  function put(el, value) {{
    if (!el) return;
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", {{ bubbles: true }}));
    el.dispatchEvent(new Event("change", {{ bubbles: true }}));
  }}
  var pw = document.querySelector('input[type="password"]');
  if (!pw) return;
  var form = pw.form || document;
  var user = form.querySelector(
    'input[type="text"],input[type="email"],input:not([type])');
  put(user, {user_js});
  put(pw, {pass_js});
}})();"#
    ))
}

/// Fill the picked credential into the page. The injected script re-checks
/// the origin before touching the DOM: the page may have navigated since
/// the offer, and a mismatch must fail closed.
#[tauri::command]
pub fn pw_fill(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    tab_id: String,
    host: String,
    username: String,
) -> Result<(), String> {
    let creds = crate::credentials::find_web(&host)?;
    let Some(cred) = creds.into_iter().find(|c| c.username == username) else {
        return Err("no such credential".into());
    };
    let label = state
        .browsers
        .lock()
        .unwrap()
        .get(&tab_id)
        .cloned()
        .ok_or_else(|| format!("no browser for {tab_id}"))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    let script = fill_script(&cred)?;
    wv.eval(&script).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_credentials_are_bound_to_tab_host_and_account() {
        *PENDING.lock().unwrap() = None;
        let password_a = format!("a-{:016x}", rand::random::<u64>());
        let password_b = format!("b-{:016x}", rand::random::<u64>());
        pending_insert(
            "tab-a".into(),
            "example.test".into(),
            "alice".into(),
            password_a.clone(),
        );
        pending_insert(
            "tab-b".into(),
            "example.test".into(),
            "alice".into(),
            password_b.clone(),
        );
        assert!(pending_take("tab-a", "example.test", "bob").is_none());
        assert_eq!(
            pending_take("tab-a", "example.test", "alice").as_deref(),
            Some(password_a.as_str())
        );
        assert_eq!(
            pending_take("tab-b", "example.test", "alice").as_deref(),
            Some(password_b.as_str())
        );
    }

    #[test]
    fn browser_bridge_uses_full_origin_not_hostname() {
        let capture = capture_script();
        assert!(capture.contains("host: location.origin"));
        assert!(capture.contains("encodeURIComponent(location.origin)"));
        assert!(!capture.contains("location.hostname"));

        let credential = crate::credentials::WebCredential {
            host: "https://example.test:8443".into(),
            username: "a\"; globalThis.pwned = true; //".into(),
            password: "p\"; globalThis.pwned = true; //".into(),
        };
        let fill = fill_script(&credential).unwrap();
        assert!(fill.contains("location.origin !== \"https://example.test:8443\""));
        assert!(fill.contains(r#"put(user, "a\"; globalThis.pwned = true; //")"#));
        assert!(fill.contains(r#"put(pw, "p\"; globalThis.pwned = true; //")"#));
    }
}
