use std::collections::HashMap;
use std::sync::Mutex;

use crate::AppHandle;
use base64::Engine as _;
use tauri::{Emitter, Manager, State};

/// Captured-but-not-yet-saved logins, keyed by host. Values live here and
/// nowhere else until the user decides.
static PENDING: Mutex<Option<HashMap<String, (String, String)>>> = Mutex::new(None);

fn pending_insert(host: String, username: String, password: String) {
    let mut p = PENDING.lock().unwrap();
    p.get_or_insert_with(HashMap::new)
        .insert(host, (username, password));
}

fn pending_take(host: &str) -> Option<(String, String)> {
    PENDING.lock().unwrap().as_mut()?.remove(host)
}

const NEVER_FILE: &str = "password-never.json";

fn never_list(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = crate::state_dir(app) else {
        return Vec::new();
    };
    std::fs::read(dir.join(NEVER_FILE))
        .ok()
        .and_then(|d| serde_json::from_slice(&d).ok())
        .unwrap_or_default()
}

fn never_add(app: &AppHandle, host: &str) {
    let mut list = never_list(app);
    if list.iter().any(|h| h == host) {
        return;
    }
    list.push(host.to_string());
    if let Ok(dir) = crate::state_dir(app) {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_vec(&list) {
            let _ = std::fs::write(dir.join(NEVER_FILE), json);
        }
    }
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
    if never_list(app).iter().any(|h| h == &cap.host) {
        return;
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
    pending_insert(cap.host.clone(), cap.username.clone(), cap.password);
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
    return {{ host: location.hostname, username: user, password: pw.value }};
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
      report("pw-form?t=" + TOKEN + "&h=" + encodeURIComponent(location.hostname));
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
pub fn pw_offer_save(host: String) -> Result<(), String> {
    let Some((user, pass)) = pending_take(&host) else {
        return Err("nothing pending for that host".into());
    };
    crate::credentials::save_web(&host, &user, &pass)?;
    eprintln!("[passwords] saved a login for {host}");
    Ok(())
}

#[tauri::command]
pub fn pw_offer_dismiss(app: AppHandle, host: String, never: bool) -> Result<(), String> {
    let _ = pending_take(&host);
    if never {
        never_add(&app, &host);
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

/// Fill the picked credential into the page. The injected script re-checks
/// the hostname before touching the DOM: the page may have navigated since
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
    // serde_json string literals are exactly JS string literals, escaping
    // included — the credential rides as data, never as code.
    let host_js = serde_json::to_string(&cred.host).map_err(|e| e.to_string())?;
    let user_js = serde_json::to_string(&cred.username).map_err(|e| e.to_string())?;
    let pass_js = serde_json::to_string(&cred.password).map_err(|e| e.to_string())?;
    let script = format!(
        r#"(function() {{
  if (location.hostname !== {host_js}) return;
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
    );
    wv.eval(&script).map_err(|e| e.to_string())
}
