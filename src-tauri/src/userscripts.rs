use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use tauri::{AppHandle, Emitter, Manager};

const MAX_SCRIPT_BYTES: usize = 32 * 1024 * 1024;
/// GM_xmlhttpRequest response cap. Binary is unsupported anyway (declared);
/// text answers a translation script needs fit far under this.
const MAX_XHR_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
/// Default and ceiling for a script-requested timeout.
const XHR_DEFAULT_TIMEOUT_MS: u64 = 30_000;
const XHR_MAX_TIMEOUT_MS: u64 = 120_000;

const INDEX_SCOPE: &str = "userscripts";
const GRANTS_SCOPE: &str = "userscript-grants";

// ---------------------------------------------------------------------------
// Metadata: parsing and validation (pure — unit-tested below)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptMeta {
    pub name: String,
    pub version: String,
    pub matches: Vec<String>,
    pub includes: Vec<String>,
    pub excludes: Vec<String>,
    /// "document-start" | "document-end" | "document-idle"
    pub run_at: String,
    pub grants: Vec<String>,
    #[serde(default)]
    pub update_url: Option<String>,
}

pub fn parse_metadata(source: &str) -> Result<ScriptMeta, String> {
    let mut in_header = false;
    let mut saw_open = false;
    let mut saw_close = false;
    let mut name = String::new();
    let mut version = String::new();
    let mut matches = Vec::new();
    let mut includes = Vec::new();
    let mut excludes = Vec::new();
    let mut run_at = String::new();
    let mut grants = Vec::new();
    let mut update_url = None;

    for line in source.lines() {
        let line = line.trim();
        // Header lines are comments; tolerate whitespace after `//`.
        let Some(rest) = line.strip_prefix("//") else {
            continue;
        };
        let rest = rest.trim();
        if rest == "==UserScript==" {
            saw_open = true;
            in_header = true;
            continue;
        }
        if rest == "==/UserScript==" {
            if in_header {
                saw_close = true;
            }
            in_header = false;
            continue;
        }
        if !in_header {
            continue;
        }
        let Some(directive) = rest.strip_prefix('@') else {
            continue;
        };
        let (key, value) = match directive.split_once(char::is_whitespace) {
            Some((k, v)) => (k, v.trim()),
            None => (directive, ""),
        };
        match key {
            "name" => name = value.to_string(),
            "version" => version = value.to_string(),
            "match" => matches.push(value.to_string()),
            "include" => includes.push(value.to_string()),
            "exclude" => excludes.push(value.to_string()),
            "run-at" => run_at = value.to_string(),
            "grant" if !value.is_empty() && value != "none" => grants.push(value.to_string()),
            "grant" => {}
            "updateURL" => update_url = Some(value.to_string()),
            // Unknown directives (@description, @namespace, @author, …) are
            // fine; unknown @grant VALUES are kept above so the settings
            // page can show what the script asked for — the bridge simply
            // never injects a capability it does not implement.
            _ => {}
        }
    }

    if !saw_open || !saw_close {
        return Err(
            "not a userscript: the ==UserScript== … ==/UserScript== header is missing".into(),
        );
    }
    if name.is_empty() {
        return Err("the header names no @name".into());
    }
    if matches.is_empty() && includes.is_empty() {
        return Err(
            "the header has no @match and no @include — a script that matches nothing \
             cannot run, and one meant to match everything must say so explicitly"
                .into(),
        );
    }
    if version.is_empty() {
        version = "0".into();
    }
    if run_at.is_empty() {
        run_at = "document-end".into();
    }
    if !matches!(
        run_at.as_str(),
        "document-start" | "document-end" | "document-idle"
    ) {
        return Err(format!(
            "@run-at {run_at:?} is not one of document-start / document-end / document-idle"
        ));
    }
    for p in &matches {
        parse_match_pattern(p).map_err(|e| format!("@match {p:?}: {e}"))?;
    }
    for r in matches.iter().chain(&includes).chain(&excludes) {
        if let Some(re) = r.strip_prefix('/').and_then(|s| s.strip_suffix('/')) {
            // Regex rules must compile at install time, not fail silently
            // at match time.
            if r.len() > 2 {
                regex::Regex::new(re).map_err(|e| format!("regex rule {r:?}: {e}"))?;
            }
        }
    }
    Ok(ScriptMeta {
        name,
        version,
        matches,
        includes,
        excludes,
        run_at,
        grants,
        update_url,
    })
}

// ---------------------------------------------------------------------------
// URL matching (pure — unit-tested below)
// ---------------------------------------------------------------------------

struct MatchPattern<'a> {
    scheme: &'a str,
    host: &'a str,
    path: &'a str,
}

/// Split a Chrome-style match pattern (`<scheme>://<host><path>`), the
/// grammar @match uses: scheme is `*` (= http or https), `http` or `https`;
/// host is `*`, `*.example.com` or exact; path is a glob starting with `/`.
fn parse_match_pattern(pattern: &str) -> Result<MatchPattern<'_>, String> {
    let (scheme, rest) = pattern
        .split_once("://")
        .ok_or_else(|| "no <scheme>:// part".to_string())?;
    if !matches!(scheme, "*" | "http" | "https") {
        return Err(format!("scheme must be *, http or https, got {scheme:?}"));
    }
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => return Err("no /path part (use /* to mean any path)".into()),
    };
    if host.is_empty() {
        return Err("empty host".into());
    }
    // `*` alone or a `*.` prefix are the only wildcard placements @match allows.
    if host.contains('*') && host != "*" && !host.starts_with("*.") {
        return Err("host wildcard must be * or a *.suffix".into());
    }
    Ok(MatchPattern { scheme, host, path })
}

/// Glob with `*` matching any run of characters (including `/` and none).
pub fn glob_match(pattern: &str, text: &str) -> bool {
    // Iterative wildcard match — no recursion, no regex, no allocation.
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == t[ti] || p[pi] == '?') {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn match_pattern_matches(pattern: &str, url: &tauri::Url) -> bool {
    let Ok(p) = parse_match_pattern(pattern) else {
        return false;
    };
    let scheme_ok = match p.scheme {
        "*" => matches!(url.scheme(), "http" | "https"),
        s => url.scheme() == s,
    };
    if !scheme_ok {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    // A pattern host may carry a port (`127.0.0.1:18923`), which a userscript
    // for a local dev server routinely does; `url.host_str()` never does. A
    // portless pattern matches any port (Chrome match-pattern semantics); a
    // pattern with a port requires that exact port.
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let host_ok = match p.host {
        "*" => true,
        h if h.starts_with("*.") => {
            let suffix = &h[2..];
            host == suffix || host.ends_with(&format!(".{suffix}"))
        }
        h if h.contains(':') => h == authority,
        h => host == h,
    };
    if !host_ok {
        return false;
    }
    // Path + query, the way Chrome matches: `?` is part of what the glob sees.
    let mut path = url.path().to_string();
    if let Some(q) = url.query() {
        path.push('?');
        path.push_str(q);
    }
    glob_match(p.path, &path)
}

/// One @include / @exclude rule against the whole URL: `/…/` is a regex,
/// anything else a glob over the full address (Greasemonkey convention).
fn include_rule_matches(rule: &str, url: &str) -> bool {
    if let Some(re) = rule.strip_prefix('/').and_then(|s| s.strip_suffix('/')) {
        if rule.len() > 2 {
            return regex::Regex::new(re)
                .map(|r| r.is_match(url))
                .unwrap_or(false);
        }
    }
    glob_match(rule, url)
}

/// The whole verdict: (any @match OR any @include) AND no @exclude.
pub fn url_matches(meta: &ScriptMeta, url: &str) -> bool {
    let Ok(parsed) = url.parse::<tauri::Url>() else {
        return false;
    };
    if meta.excludes.iter().any(|r| include_rule_matches(r, url)) {
        return false;
    }
    meta.matches
        .iter()
        .any(|p| match_pattern_matches(p, &parsed))
        || meta.includes.iter().any(|r| include_rule_matches(r, url))
}

// ---------------------------------------------------------------------------
// Grant → capability mapping (pure)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
struct Caps {
    get: bool,
    set: bool,
    del: bool,
    list: bool,
    style: bool,
    menu: bool,
    xhr: bool,
}

fn caps_of(grants: &[String]) -> Caps {
    let has = |a: &str, b: &str| grants.iter().any(|g| g == a || g == b);
    Caps {
        get: has("GM_getValue", "GM.getValue"),
        set: has("GM_setValue", "GM.setValue"),
        del: has("GM_deleteValue", "GM.deleteValue"),
        list: has("GM_listValues", "GM.listValues"),
        style: has("GM_addStyle", "GM.addStyle"),
        menu: has("GM_registerMenuCommand", "GM.registerMenuCommand"),
        xhr: has("GM_xmlhttpRequest", "GM.xmlHttpRequest"),
    }
}

// ---------------------------------------------------------------------------
// The grant decision (pure — unit-tested below)
// ---------------------------------------------------------------------------

/// Is this script already allowed to reach this host, per the persisted
/// table? "Allow once" never enters the table — it authorizes exactly the
/// request that asked.
pub fn grant_decision(table: &HashMap<String, Vec<String>>, script_id: &str, host: &str) -> bool {
    table
        .get(script_id)
        .is_some_and(|hosts| hosts.iter().any(|h| h == host))
}

/// The value scope for one script: `usv-<id>`. Ids are 32 lowercase hex
/// chars (uuid_like), so the result always passes the state-store's scope
/// charset and never carries the `:<uuid>` tail that marks a scope as tab
/// state for the orphan sweep.
pub fn values_scope(script_id: &str) -> String {
    format!("usv-{script_id}")
}

// ---------------------------------------------------------------------------
// Registry: the installed scripts, in memory + persisted
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Script {
    id: String,
    enabled: bool,
    meta: ScriptMeta,
    body: String,
    install_url: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredIndexEntry {
    id: String,
    enabled: bool,
    #[serde(default)]
    install_url: Option<String>,
    #[serde(flatten)]
    meta: ScriptMeta,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredIndex {
    version: u32,
    scripts: Vec<StoredIndexEntry>,
}

fn registry() -> &'static Mutex<Option<Vec<Script>>> {
    static REG: OnceLock<Mutex<Option<Vec<Script>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(None))
}

fn bodies_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::state_dir(app).ok().map(|d| d.join("userscripts"))
}

/// Load-once, then serve from memory.
fn ensure_loaded(app: &AppHandle) {
    let mut reg = registry().lock().unwrap();
    if reg.is_some() {
        return;
    }
    let mut scripts = Vec::new();
    let index = crate::state_dir(app)
        .ok()
        .and_then(|dir| tabverse_fs::state::load(&dir, INDEX_SCOPE).ok().flatten())
        .and_then(|json| serde_json::from_str::<StoredIndex>(&json).ok());
    if let (Some(index), Some(dir)) = (index, bodies_dir(app)) {
        for entry in index.scripts {
            let path = dir.join(format!("{}.js", entry.id));
            match std::fs::read_to_string(&path) {
                Ok(body) => scripts.push(Script {
                    id: entry.id,
                    enabled: entry.enabled,
                    meta: entry.meta,
                    body,
                    install_url: entry.install_url,
                }),
                Err(_) => {
                    // An indexed script whose body is gone cannot run;
                    // dropping the entry is honest, keeping it would show a
                    // toggle that toggles nothing.
                    eprintln!("[userscripts] body file missing for {}, dropped", entry.id);
                }
            }
        }
    }
    *reg = Some(scripts);
}

fn persist_registry(app: &AppHandle) {
    let entries: Vec<StoredIndexEntry> = registry()
        .lock()
        .unwrap()
        .as_ref()
        .map(|v| {
            v.iter()
                .map(|s| StoredIndexEntry {
                    id: s.id.clone(),
                    enabled: s.enabled,
                    install_url: s.install_url.clone(),
                    meta: s.meta.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    let Ok(json) = serde_json::to_string(&StoredIndex {
        version: 1,
        scripts: entries,
    }) else {
        return;
    };
    let Ok(dir) = crate::state_dir(app) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tabverse_fs::state::save(&dir, INDEX_SCOPE, &json);
        let _ = app; // keep the handle alive for the write's duration
    });
}

pub fn any_enabled(app: &AppHandle) -> bool {
    ensure_loaded(app);
    registry()
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|v| v.iter().any(|s| s.enabled))
}

// ---------------------------------------------------------------------------
// Values: per-script storage, memory-cached, persisted per scope
// ---------------------------------------------------------------------------

fn values_cache() -> &'static Mutex<HashMap<String, serde_json::Map<String, serde_json::Value>>> {
    static VALUES: OnceLock<Mutex<HashMap<String, serde_json::Map<String, serde_json::Value>>>> =
        OnceLock::new();
    VALUES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn values_of(app: &AppHandle, script_id: &str) -> serde_json::Map<String, serde_json::Value> {
    if let Some(hit) = values_cache().lock().unwrap().get(script_id) {
        return hit.clone();
    }
    let loaded: serde_json::Map<String, serde_json::Value> = crate::state_dir(app)
        .ok()
        .and_then(|dir| {
            tabverse_fs::state::load(&dir, &values_scope(script_id))
                .ok()
                .flatten()
        })
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    values_cache()
        .lock()
        .unwrap()
        .insert(script_id.to_string(), loaded.clone());
    loaded
}

fn persist_values(app: &AppHandle, script_id: &str) {
    let Some(map) = values_cache().lock().unwrap().get(script_id).cloned() else {
        return;
    };
    let Ok(json) = serde_json::to_string(&map) else {
        return;
    };
    let Ok(dir) = crate::state_dir(app) else {
        return;
    };
    let scope = values_scope(script_id);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tabverse_fs::state::save(&dir, &scope, &json);
    });
}

// ---------------------------------------------------------------------------
// Grant table: script id -> permanently allowed hosts
// ---------------------------------------------------------------------------

type GrantTable = Option<HashMap<String, Vec<String>>>;

fn grants() -> &'static Mutex<GrantTable> {
    static GRANTS: OnceLock<Mutex<GrantTable>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(None))
}

fn ensure_grants_loaded(app: &AppHandle) {
    let mut g = grants().lock().unwrap();
    if g.is_some() {
        return;
    }
    let loaded = crate::state_dir(app)
        .ok()
        .and_then(|dir| tabverse_fs::state::load(&dir, GRANTS_SCOPE).ok().flatten())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    *g = Some(loaded);
}

fn persist_grants(app: &AppHandle) {
    let Some(map) = grants().lock().unwrap().clone() else {
        return;
    };
    let Ok(json) = serde_json::to_string(&map) else {
        return;
    };
    let Ok(dir) = crate::state_dir(app) else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _ = tabverse_fs::state::save(&dir, GRANTS_SCOPE, &json);
    });
}

fn host_granted(app: &AppHandle, script_id: &str, host: &str) -> bool {
    ensure_grants_loaded(app);
    grants()
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|t| grant_decision(t, script_id, host))
}

fn record_grant(app: &AppHandle, script_id: &str, host: &str) {
    ensure_grants_loaded(app);
    {
        let mut g = grants().lock().unwrap();
        let table = g.get_or_insert_with(HashMap::new);
        let hosts = table.entry(script_id.to_string()).or_default();
        if !hosts.iter().any(|h| h == host) {
            hosts.push(host.to_string());
        }
    }
    persist_grants(app);
}

// ---------------------------------------------------------------------------
// Injection: bootstrap, per-tab nonces, wrappers
// ---------------------------------------------------------------------------

/// Webview labels whose creation included the bootstrap init script — the
/// late (page-load) path must not double-inject into those.
fn bootstrapped() -> &'static Mutex<std::collections::HashSet<String>> {
    static SET: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

pub fn mark_bootstrapped(label: &str) {
    bootstrapped().lock().unwrap().insert(label.to_string());
}

/// (tab id, script id) -> the nonce of the CURRENT injection there. A new
/// document's injection overwrites it, so a stale reply evals into a page
/// whose listener holds a different nonce and lands on deaf ears.
fn nonces() -> &'static Mutex<HashMap<(String, String), String>> {
    static N: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    N.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A browser webview is gone; drop everything keyed by its tab.
pub fn forget_tab(tab_id: &str) {
    nonces().lock().unwrap().retain(|(t, _), _| t != tab_id);
    bootstrapped()
        .lock()
        .unwrap()
        .remove(&crate::webview_label(tab_id));
}

/// The document-start bootstrap: reports the page's address and nothing
/// else. Zero DOM, zero globals — a page with scripts enabled but none
/// matching must still render untouched.
pub fn bootstrap_script() -> String {
    format!(
        r#"(function() {{
  if (window.top !== window) return;
  var TOKEN = "{token}";
  var msg = "us-query?t=" + TOKEN + "&u=" + encodeURIComponent(location.href);
  try {{
    window.webkit.messageHandlers.{handler}.postMessage(msg);
    return;
  }} catch (_) {{}}
  try {{ window.chrome.webview.postMessage(msg); }} catch (_) {{}}
}})();"#,
        token = crate::cmd_token(),
        handler = crate::PAGE_CHANNEL,
    )
}

/// The late path (see module docs): a webview created before any script
/// existed gets the same bootstrap evaled at page-load-finished.
pub fn on_page_finished(app: &AppHandle, tab_id: &str, webview: &tauri::Webview) {
    if bootstrapped()
        .lock()
        .unwrap()
        .contains(&crate::webview_label(tab_id))
    {
        return;
    }
    if !any_enabled(app) {
        return;
    }
    let _ = webview.eval(bootstrap_script());
}

fn tab_webview(app: &AppHandle, tab_id: &str) -> Option<tauri::Webview> {
    let label = app
        .state::<crate::AppState>()
        .browsers
        .lock()
        .unwrap()
        .get(tab_id)
        .cloned()?;
    app.get_window("main")?.get_webview(&label)
}

/// A page (top frame) reported its address at document-start: inject every
/// enabled matching script. Also resets that tab's script menu commands —
/// a new document starts with none.
pub fn handle_query(app: &AppHandle, tab_id: &str, url: &str) {
    let _ = app.emit(
        "userscript-menu-reset",
        serde_json::json!({ "tabId": tab_id }),
    );
    ensure_loaded(app);
    let matched: Vec<Script> = registry()
        .lock()
        .unwrap()
        .as_ref()
        .map(|v| {
            v.iter()
                .filter(|s| s.enabled && url_matches(&s.meta, url))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if matched.is_empty() {
        return;
    }
    let Some(wv) = tab_webview(app, tab_id) else {
        return;
    };
    let host = url
        .parse::<tauri::Url>()
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    for s in &matched {
        let nonce = crate::uuid_like();
        nonces()
            .lock()
            .unwrap()
            .insert((tab_id.to_string(), s.id.clone()), nonce.clone());
        let values = values_of(app, &s.id);
        let wrapper = build_wrapper(s, &values, &nonce, url);
        let _ = wv.eval(&wrapper);
    }
    // Host only: the full URL is browsing history and stays out of logs.
    eprintln!(
        "[userscripts] injected {} script(s) tab={tab_id} host={host}",
        matched.len()
    );
}

fn build_wrapper(
    s: &Script,
    values: &serde_json::Map<String, serde_json::Value>,
    nonce: &str,
    url: &str,
) -> String {
    let caps = caps_of(&s.meta.grants);
    let j = |v: &str| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into());
    let values_json = serde_json::to_string(values).unwrap_or_else(|_| "{}".into());

    let mut js = String::with_capacity(s.body.len() + 4096);
    js.push_str("(function(){\n");
    js.push_str(&format!("var __calT = {};\n", j(crate::cmd_token())));
    js.push_str(&format!("var __calN = {};\n", j(nonce)));
    js.push_str(&format!("var __calS = {};\n", j(&s.id)));
    // The page may have moved on while this eval was in flight; a wrapper
    // for one document must never run in another.
    js.push_str(&format!("if (location.href !== {}) return;\n", j(url)));
    js.push_str(&format!(
        "function __calPost(m) {{\n\
         try {{ window.webkit.messageHandlers.{h}.postMessage(m); return true; }} catch (_) {{}}\n\
         try {{ window.chrome.webview.postMessage(m); return true; }} catch (_) {{}}\n\
         return false;\n}}\n",
        h = crate::PAGE_CHANNEL
    ));
    js.push_str(
        "function __calSend(kind, obj) {\n\
         obj.script = __calS;\n\
         try {\n\
         __calPost(kind + \"?t=\" + __calT + \"&d=\" +\n\
         encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(obj))))));\n\
         } catch (_) {}\n}\n",
    );
    js.push_str(&format!("var __calVals = {values_json};\n"));

    if caps.get {
        js.push_str(
            "function GM_getValue(k, d) { return Object.prototype.hasOwnProperty.call(__calVals, k) ? __calVals[k] : d; }\n",
        );
    }
    if caps.set {
        js.push_str(
            "function GM_setValue(k, v) { __calVals[String(k)] = v; __calSend(\"us-set\", { op: \"set\", key: String(k), value: v }); }\n",
        );
    }
    if caps.del {
        js.push_str(
            "function GM_deleteValue(k) { delete __calVals[String(k)]; __calSend(\"us-set\", { op: \"del\", key: String(k) }); }\n",
        );
    }
    if caps.list {
        js.push_str("function GM_listValues() { return Object.keys(__calVals); }\n");
    }
    if caps.style {
        js.push_str(
            "function GM_addStyle(css) { var s = document.createElement(\"style\"); s.textContent = String(css); (document.head || document.documentElement).appendChild(s); return s; }\n",
        );
    }
    if caps.menu {
        js.push_str("var __calMenuN = 0, __calMenuCbs = {};\n");
        js.push_str(
            "window.addEventListener(\"tabverse-us-menu\", function(ev) {\n\
             var d = ev.detail || {};\n\
             if (d.token !== __calN || d.script !== __calS) return;\n\
             var f = __calMenuCbs[d.cmd];\n\
             if (f) { try { f(); } catch (_) {} }\n});\n",
        );
        js.push_str(
            "function GM_registerMenuCommand(name, fn) { var id = ++__calMenuN; __calMenuCbs[id] = fn; __calSend(\"us-menu\", { cmd: id, name: String(name) }); return id; }\n",
        );
    }
    if caps.xhr {
        js.push_str("var __calXhrN = 0, __calXhrCbs = {};\n");
        js.push_str(
            "window.addEventListener(\"tabverse-us-xhr\", function(ev) {\n\
             var d = ev.detail || {};\n\
             if (d.token !== __calN || d.script !== __calS) return;\n\
             var cb = __calXhrCbs[d.req];\n\
             if (!cb) return;\n\
             delete __calXhrCbs[d.req];\n\
             if (d.ok) {\n\
             var r = { readyState: 4, status: d.status, statusText: d.statusText || \"\",\n\
             responseHeaders: d.headers || \"\", responseText: d.text || \"\",\n\
             response: d.text || \"\", finalUrl: d.finalUrl || \"\" };\n\
             if (cb.responseType === \"json\") { try { r.response = JSON.parse(r.responseText); } catch (_) { r.response = null; } }\n\
             if (cb.onload) { try { cb.onload(r); } catch (_) {} }\n\
             if (cb.onloadend) { try { cb.onloadend(r); } catch (_) {} }\n\
             } else {\n\
             var e = { readyState: 4, status: 0, error: d.error || \"request failed\" };\n\
             if (d.timedOut && cb.ontimeout) { try { cb.ontimeout(e); } catch (_) {} }\n\
             else if (cb.onerror) { try { cb.onerror(e); } catch (_) {} }\n\
             if (cb.onloadend) { try { cb.onloadend(e); } catch (_) {} }\n\
             }\n});\n",
        );
        js.push_str(
            "function GM_xmlhttpRequest(d) {\n\
             d = d || {};\n\
             if (d.responseType && d.responseType !== \"text\" && d.responseType !== \"json\") {\n\
             setTimeout(function() { if (d.onerror) { try { d.onerror({ error: \"binary responses are not supported\", readyState: 4, status: 0 }); } catch (_) {} } }, 0);\n\
             return { abort: function() {} };\n\
             }\n\
             var id = ++__calXhrN;\n\
             __calXhrCbs[id] = d;\n\
             var h = {};\n\
             if (d.headers) { for (var k in d.headers) { if (Object.prototype.hasOwnProperty.call(d.headers, k)) h[String(k)] = String(d.headers[k]); } }\n\
             __calSend(\"us-xhr\", { req: id, method: String(d.method || \"GET\"), url: String(d.url || \"\"), headers: h, data: typeof d.data === \"string\" ? d.data : null, timeout: (typeof d.timeout === \"number\" && d.timeout > 0) ? Math.floor(d.timeout) : 0 });\n\
             return { abort: function() {} };\n}\n",
        );
    }

    // GM_info and the GM.* promise aliases (always present, like the
    // handlers they mirror; an alias only exists when its classic form was
    // granted).
    js.push_str(&format!(
        "var GM_info = {{ script: {{ name: {name}, version: {version} }}, scriptHandler: \"Tabverse\", version: {app} }};\n",
        name = j(&s.meta.name),
        version = j(&s.meta.version),
        app = j(env!("CARGO_PKG_VERSION")),
    ));
    js.push_str("var GM = { info: GM_info };\n");
    if caps.get {
        js.push_str(
            "GM.getValue = function(k, d) { return Promise.resolve(GM_getValue(k, d)); };\n",
        );
    }
    if caps.set {
        js.push_str(
            "GM.setValue = function(k, v) { GM_setValue(k, v); return Promise.resolve(); };\n",
        );
    }
    if caps.del {
        js.push_str(
            "GM.deleteValue = function(k) { GM_deleteValue(k); return Promise.resolve(); };\n",
        );
    }
    if caps.list {
        js.push_str("GM.listValues = function() { return Promise.resolve(GM_listValues()); };\n");
    }
    if caps.style {
        js.push_str("GM.addStyle = function(css) { return GM_addStyle(css); };\n");
    }
    if caps.menu {
        js.push_str("GM.registerMenuCommand = GM_registerMenuCommand;\n");
    }
    if caps.xhr {
        js.push_str("GM.xmlHttpRequest = GM_xmlhttpRequest;\n");
    }

    js.push_str(
        "function __calRun() {\n\
         (function(unsafeWindow) {\n\
         var __calT, __calN, __calS, __calPost, __calSend, __calVals,\n\
         __calMenuN, __calMenuCbs, __calXhrN, __calXhrCbs, __calRun;\n",
    );
    js.push_str(&s.body);
    js.push_str("\n})(window);\n}\n");

    js.push_str(&format!("var __calRunAt = {};\n", j(&s.meta.run_at)));
    js.push_str(
        "if (__calRunAt === \"document-start\") { __calRun(); }\n\
         else if (__calRunAt === \"document-idle\") {\n\
         if (document.readyState === \"complete\") { __calRun(); }\n\
         else { window.addEventListener(\"load\", function() { __calRun(); }); }\n\
         } else {\n\
         if (document.readyState === \"loading\") { document.addEventListener(\"DOMContentLoaded\", function() { __calRun(); }); }\n\
         else { __calRun(); }\n\
         }\n",
    );
    js.push_str("})();\n");
    js
}

// ---------------------------------------------------------------------------
// Reports from the bridge (dispatched by handle_command, token verified)
// ---------------------------------------------------------------------------

/// `us-set` / `us-menu` / `us-xhr`, payload base64-JSON in `d=`. Values and
/// request bodies ride here — nothing from the payload may be logged.
pub fn handle_report(app: &AppHandle, tab_id: &str, cmd: &str, data_b64: &str) {
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_b64) else {
        return;
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return;
    };
    let script_id = v.get("script").and_then(|s| s.as_str()).unwrap_or("");
    if script_id.is_empty() {
        return;
    }
    // The report must come from a script that exists and is enabled — a
    // forged id gets nothing, not even storage.
    ensure_loaded(app);
    let known = registry()
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|r| r.iter().any(|s| s.id == script_id && s.enabled));
    if !known {
        return;
    }
    match cmd {
        "us-set" => handle_value_op(app, script_id, &v),
        "us-menu" => {
            let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let cmd_id = v.get("cmd").and_then(|c| c.as_u64()).unwrap_or(0);
            if name.is_empty() || cmd_id == 0 {
                return;
            }
            let _ = app.emit(
                "userscript-menu",
                serde_json::json!({
                    "tabId": tab_id,
                    "scriptId": script_id,
                    "cmdId": cmd_id,
                    "name": name,
                }),
            );
        }
        "us-xhr" => handle_xhr_request(app, tab_id, script_id, &v),
        _ => {}
    }
}

fn handle_value_op(app: &AppHandle, script_id: &str, v: &serde_json::Value) {
    let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let Some(key) = v.get("key").and_then(|k| k.as_str()) else {
        return;
    };
    {
        // Make sure the map is loaded before mutating, or the first write
        // of a run would shadow everything stored before it.
        values_of(app, script_id);
        let mut cache = values_cache().lock().unwrap();
        let map = cache.entry(script_id.to_string()).or_default();
        match op {
            "set" => {
                map.insert(
                    key.to_string(),
                    v.get("value").cloned().unwrap_or(serde_json::Value::Null),
                );
            }
            "del" => {
                map.remove(key);
            }
            _ => return,
        }
    }
    persist_values(app, script_id);
}

// ---------------------------------------------------------------------------
// GM_xmlhttpRequest: authorization queue + core-side execution
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct XhrRequest {
    req_id: u64,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    data: Option<String>,
    timeout_ms: u64,
}

struct PendingAsk {
    ask_id: u64,
    tab_id: String,
    script_id: String,
    script_name: String,
    host: String,
    req: XhrRequest,
}

fn asks() -> &'static Mutex<VecDeque<PendingAsk>> {
    static ASKS: OnceLock<Mutex<VecDeque<PendingAsk>>> = OnceLock::new();
    ASKS.get_or_init(|| Mutex::new(VecDeque::new()))
}

static ASK_SEQ: AtomicU64 = AtomicU64::new(1);

fn xhr_counts() -> &'static Mutex<HashMap<(String, String), u64>> {
    static C: OnceLock<Mutex<HashMap<(String, String), u64>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn handle_xhr_request(app: &AppHandle, tab_id: &str, script_id: &str, v: &serde_json::Value) {
    // Server-side grant check, not only bridge trimming: a bridge is page
    // world and page world is not a boundary (module docs).
    let granted_cap = registry().lock().unwrap().as_ref().is_some_and(|r| {
        r.iter()
            .any(|s| s.id == script_id && caps_of(&s.meta.grants).xhr)
    });
    let req_id = v.get("req").and_then(|r| r.as_u64()).unwrap_or(0);
    if req_id == 0 {
        return;
    }
    if !granted_cap {
        xhr_fail(
            app,
            tab_id,
            script_id,
            req_id,
            "GM_xmlhttpRequest is not granted",
            false,
        );
        return;
    }
    let method = v
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("GET")
        .to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "PATCH" | "OPTIONS"
    ) {
        xhr_fail(app, tab_id, script_id, req_id, "method not allowed", false);
        return;
    }
    let url_str = v.get("url").and_then(|u| u.as_str()).unwrap_or("");
    let Ok(url) = url_str.parse::<tauri::Url>() else {
        xhr_fail(app, tab_id, script_id, req_id, "bad url", false);
        return;
    };
    if !matches!(url.scheme(), "http" | "https") {
        xhr_fail(app, tab_id, script_id, req_id, "only http(s) urls", false);
        return;
    }
    let Some(host) = url.host_str().map(str::to_string) else {
        xhr_fail(app, tab_id, script_id, req_id, "url has no host", false);
        return;
    };
    let headers: Vec<(String, String)> = v
        .get("headers")
        .and_then(|h| h.as_object())
        .map(|m| {
            m.iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.to_ascii_lowercase().as_str(),
                        "host" | "content-length" | "transfer-encoding" | "connection"
                    )
                })
                .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let timeout_ms = v
        .get("timeout")
        .and_then(|t| t.as_u64())
        .filter(|t| *t > 0)
        .map(|t| t.min(XHR_MAX_TIMEOUT_MS))
        .unwrap_or(XHR_DEFAULT_TIMEOUT_MS);
    let req = XhrRequest {
        req_id,
        method,
        url: url_str.to_string(),
        headers,
        data: v.get("data").and_then(|d| d.as_str()).map(str::to_string),
        timeout_ms,
    };
    if host_granted(app, script_id, &host) {
        execute_xhr(app, tab_id, script_id, req, host);
        return;
    }
    // Not authorized: queue the question. One dialog at a time — the front
    // of the queue is the one on screen (anyOverlayOpen counts it).
    let script_name = registry()
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|r| {
            r.iter()
                .find(|s| s.id == script_id)
                .map(|s| s.meta.name.clone())
        })
        .unwrap_or_default();
    let ask_id = ASK_SEQ.fetch_add(1, Ordering::Relaxed);
    let emit_now = {
        let mut q = asks().lock().unwrap();
        q.push_back(PendingAsk {
            ask_id,
            tab_id: tab_id.to_string(),
            script_id: script_id.to_string(),
            script_name,
            host,
            req,
        });
        q.len() == 1
    };
    if emit_now {
        emit_front_ask(app);
    }
}

fn emit_front_ask(app: &AppHandle) {
    let payload = {
        let q = asks().lock().unwrap();
        q.front().map(|a| {
            serde_json::json!({
                "askId": a.ask_id,
                "scriptId": a.script_id,
                "scriptName": a.script_name,
                "host": a.host,
            })
        })
    };
    if let Some(p) = payload {
        let _ = app.emit("userscript-xhr-ask", p);
    }
}

/// The user's answer to the front-of-queue ask. `decision` is "once",
/// "always" or "deny". After answering, the queue advances — and asks that
/// an "always" just covered are executed rather than re-asked.
#[tauri::command]
pub fn userscript_xhr_answer(app: AppHandle, ask_id: u64, decision: String) -> Result<(), String> {
    let ask = {
        let mut q = asks().lock().unwrap();
        match q.front() {
            Some(front) if front.ask_id == ask_id => q.pop_front(),
            _ => None,
        }
    };
    let Some(ask) = ask else {
        return Err("that question is no longer pending".into());
    };
    match decision.as_str() {
        "always" => {
            record_grant(&app, &ask.script_id, &ask.host);
            execute_xhr(&app, &ask.tab_id, &ask.script_id, ask.req, ask.host);
        }
        "once" => {
            execute_xhr(&app, &ask.tab_id, &ask.script_id, ask.req, ask.host);
        }
        _ => {
            eprintln!(
                "[userscripts] xhr denied script={} host={}",
                ask.script_id, ask.host
            );
            xhr_fail(
                &app,
                &ask.tab_id,
                &ask.script_id,
                ask.req.req_id,
                "the user denied access to this domain",
                false,
            );
        }
    }
    // Drain everything a fresh grant now covers, then show the next real
    // question if one remains.
    loop {
        let covered = {
            let mut q = asks().lock().unwrap();
            match q.front() {
                Some(front) if host_granted(&app, &front.script_id, &front.host) => q.pop_front(),
                _ => None,
            }
        };
        match covered {
            Some(a) => execute_xhr(&app, &a.tab_id, &a.script_id, a.req, a.host),
            None => break,
        }
    }
    emit_front_ask(&app);
    Ok(())
}

fn xhr_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            crate::http::build(crate::http::Spec {
                // A script's request is made on behalf of the page it runs
                // in, so it goes out looking like that page's own.
                user_agent: Some(crate::BROWSER_UA),
                // No deadline of either kind, which is what this has always
                // had: a userscript decides for itself how long its request
                // may take — several of them hold a long poll open — and a
                // limit imposed here would end those without explaining
                // itself to the script or to the user.
                timeout: None,
                connect_timeout: None,
            })
            .ok()
        })
        .as_ref()
}

fn execute_xhr(app: &AppHandle, tab_id: &str, script_id: &str, req: XhrRequest, host: String) {
    let n = {
        let mut c = xhr_counts().lock().unwrap();
        let n = c.entry((script_id.to_string(), host.clone())).or_insert(0);
        *n += 1;
        *n
    };
    // Script id, host, count. Never the path, query, headers or body.
    eprintln!("[userscripts] xhr script={script_id} host={host} count={n}");
    let app = app.clone();
    let tab_id = tab_id.to_string();
    let script_id = script_id.to_string();
    tauri::async_runtime::spawn(async move {
        let Some(client) = xhr_client() else {
            xhr_fail(
                &app,
                &tab_id,
                &script_id,
                req.req_id,
                "http client unavailable",
                false,
            );
            return;
        };
        let method = match reqwest::Method::from_bytes(req.method.as_bytes()) {
            Ok(m) => m,
            Err(_) => {
                xhr_fail(
                    &app,
                    &tab_id,
                    &script_id,
                    req.req_id,
                    "method not allowed",
                    false,
                );
                return;
            }
        };
        let mut builder = client
            .request(method, &req.url)
            .timeout(std::time::Duration::from_millis(req.timeout_ms));
        for (k, v) in &req.headers {
            builder = builder.header(k, v);
        }
        if let Some(data) = &req.data {
            builder = builder.body(data.clone());
        }
        let sent = builder.send().await;
        let resp = match sent {
            Ok(r) => r,
            Err(e) => {
                let timed_out = e.is_timeout();
                xhr_fail(
                    &app,
                    &tab_id,
                    &script_id,
                    req.req_id,
                    if timed_out {
                        "timed out"
                    } else {
                        "request failed"
                    },
                    timed_out,
                );
                return;
            }
        };
        let status = resp.status().as_u16();
        let status_text = resp.status().canonical_reason().unwrap_or("").to_string();
        let final_url = resp.url().to_string();
        let headers_joined: String = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|val| format!("{k}: {val}\r\n")))
            .collect();
        // Read capped, chunk by chunk — a content-length header is a claim,
        // not a bound.
        let mut resp = resp;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    buf.extend_from_slice(&chunk);
                    if buf.len() > MAX_XHR_RESPONSE_BYTES {
                        xhr_fail(
                            &app,
                            &tab_id,
                            &script_id,
                            req.req_id,
                            "response too large",
                            false,
                        );
                        return;
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    xhr_fail(&app, &tab_id, &script_id, req.req_id, "read failed", false);
                    return;
                }
            }
        }
        let text = String::from_utf8_lossy(&buf).to_string();
        let detail = serde_json::json!({
            "token": nonce_for(&tab_id, &script_id),
            "script": script_id,
            "req": req.req_id,
            "ok": true,
            "status": status,
            "statusText": status_text,
            "headers": headers_joined,
            "text": text,
            "finalUrl": final_url,
        });
        eval_reply(&app, &tab_id, "tabverse-us-xhr", &detail);
    });
}

fn nonce_for(tab_id: &str, script_id: &str) -> String {
    nonces()
        .lock()
        .unwrap()
        .get(&(tab_id.to_string(), script_id.to_string()))
        .cloned()
        .unwrap_or_default()
}

fn xhr_fail(
    app: &AppHandle,
    tab_id: &str,
    script_id: &str,
    req_id: u64,
    error: &str,
    timed_out: bool,
) {
    let detail = serde_json::json!({
        "token": nonce_for(tab_id, script_id),
        "script": script_id,
        "req": req_id,
        "ok": false,
        "error": error,
        "timedOut": timed_out,
    });
    eval_reply(app, tab_id, "tabverse-us-xhr", &detail);
}

/// Reply core→page: a CustomEvent whose detail carries the injection nonce,
/// never the command token (module docs).
fn eval_reply(app: &AppHandle, tab_id: &str, event: &str, detail: &serde_json::Value) {
    let Some(wv) = tab_webview(app, tab_id) else {
        return;
    };
    let Ok(json) = serde_json::to_string(detail) else {
        return;
    };
    let _ = wv.eval(format!(
        "window.dispatchEvent(new CustomEvent(\"{event}\", {{ detail: {json} }}));"
    ));
}

#[tauri::command]
pub fn userscript_menu_click(
    app: AppHandle,
    tab_id: String,
    script_id: String,
    cmd_id: u64,
) -> Result<(), String> {
    let detail = serde_json::json!({
        "token": nonce_for(&tab_id, &script_id),
        "script": script_id,
        "cmd": cmd_id,
    });
    eval_reply(&app, &tab_id, "tabverse-us-menu", &detail);
    Ok(())
}

// ---------------------------------------------------------------------------
// Install / manage commands (the Settings page's API)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    id: String,
    name: String,
    version: String,
    enabled: bool,
    run_at: String,
    matches: Vec<String>,
    includes: Vec<String>,
    excludes: Vec<String>,
    grants: Vec<String>,
    granted_hosts: Vec<String>,
    /// The pinned update source, or None when the script came from a file
    /// or raw text (the Settings row disables "Check for update" then).
    install_url: Option<String>,
}

fn info_of(app: &AppHandle, s: &Script) -> ScriptInfo {
    ensure_grants_loaded(app);
    let granted_hosts = grants()
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|t| t.get(&s.id).cloned())
        .unwrap_or_default();
    ScriptInfo {
        id: s.id.clone(),
        name: s.meta.name.clone(),
        version: s.meta.version.clone(),
        enabled: s.enabled,
        run_at: s.meta.run_at.clone(),
        matches: s.meta.matches.clone(),
        includes: s.meta.includes.clone(),
        excludes: s.meta.excludes.clone(),
        grants: s.meta.grants.clone(),
        granted_hosts,
        install_url: s.install_url.clone(),
    }
}

#[tauri::command]
pub fn userscripts_list(app: AppHandle) -> Result<Vec<ScriptInfo>, String> {
    ensure_loaded(&app);
    Ok(registry()
        .lock()
        .unwrap()
        .as_ref()
        .map(|v| v.iter().map(|s| info_of(&app, s)).collect())
        .unwrap_or_default())
}

fn write_body(app: &AppHandle, id: &str, body: &str) {
    let Some(dir) = bodies_dir(app) else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join(format!("{id}.js")), body);
}

pub fn install_source(
    app: &AppHandle,
    source: &str,
    origin: Option<&str>,
) -> Result<ScriptInfo, String> {
    if source.len() > MAX_SCRIPT_BYTES {
        return Err(format!(
            "script is {:.1} MB, larger than the {} MB an install may carry",
            source.len() as f64 / (1024.0 * 1024.0),
            MAX_SCRIPT_BYTES / (1024 * 1024)
        ));
    }
    let meta = parse_metadata(source)?;
    ensure_loaded(app);
    let install_url = origin.map(str::to_string);
    let script = {
        let mut reg = registry().lock().unwrap();
        let scripts = reg.as_mut().expect("registry loaded above");
        if let Some(existing) = scripts.iter_mut().find(|s| s.meta.name == meta.name) {
            existing.meta = meta;
            existing.body = source.to_string();
            existing.install_url = install_url;
            existing.clone()
        } else {
            let s = Script {
                id: crate::uuid_like(),
                enabled: true,
                meta,
                body: source.to_string(),
                install_url,
            };
            scripts.push(s.clone());
            s
        }
    };
    write_body(app, &script.id, &script.body);
    persist_registry(app);
    eprintln!("[userscripts] installed script={}", script.id);
    Ok(info_of(app, &script))
}

async fn fetch_script_source(url: &str) -> Result<String, String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) urls can be fetched".into());
    }
    let client = xhr_client().ok_or("http client unavailable")?;
    let resp = client
        .get(parsed)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the server answered {}", resp.status()));
    }
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if buf.len() > MAX_SCRIPT_BYTES {
                    return Err(format!(
                        "script is over {} MB, more than an install may carry",
                        MAX_SCRIPT_BYTES / (1024 * 1024)
                    ));
                }
            }
            Ok(None) => break,
            Err(e) => return Err(format!("read failed: {e}")),
        }
    }
    String::from_utf8(buf).map_err(|_| "the file is not UTF-8 text".to_string())
}

#[tauri::command]
pub async fn userscript_install_url(app: AppHandle, url: String) -> Result<ScriptInfo, String> {
    let source = fetch_script_source(&url).await?;
    install_source(&app, &source, Some(&url))
}

/// Install from a local file the user picked. A file is not a URL — the
/// script gets no pinned update source, and its "Check for update" button
/// in Settings says so instead of pretending.
#[tauri::command]
pub async fn userscript_install_file(app: AppHandle, path: String) -> Result<ScriptInfo, String> {
    let source = tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| format!("cannot read the file: {e}"))?;
        if meta.len() as usize > MAX_SCRIPT_BYTES {
            return Err(format!(
                "script is {:.1} MB, larger than the {} MB an install may carry",
                meta.len() as f64 / (1024.0 * 1024.0),
                MAX_SCRIPT_BYTES / (1024 * 1024)
            ));
        }
        std::fs::read_to_string(&path).map_err(|e| format!("cannot read the file: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    install_source(&app, &source, None)
}

/// The URL an update check fetches: the one the user installed from,
/// always. The script's own `@updateURL` — which the installed version's
/// header, or the newly fetched version's, may point at any host — is
/// passed in here precisely so it can be seen being refused. A script that
/// could re-home its own update source could ship a clean version today
/// and pull tomorrow's from somewhere the user never chose; the pin is the
/// guardrail, not a convenience.
pub fn pinned_update_url(install_url: &str, header_update_url: Option<&str>) -> String {
    let _ = header_update_url; // read, named, and deliberately not followed
    install_url.to_string()
}

/// What a check found, for the Settings UI. `current_source` and
/// `new_source` ride along only when an update is available — that is the
/// pair the diff dialog reviews; an up-to-date answer carries no bodies.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub new_version: String,
    pub current_source: Option<String>,
    pub new_source: Option<String>,
}

/// Fetch the pinned source and compare — nothing is written. The whole
/// body decides "available", not the version string: a body that changed
/// without a version bump still gets its diff shown, and identical bytes
/// are "up to date" no matter what the header claims.
#[tauri::command]
pub async fn userscript_check_update(
    app: AppHandle,
    script_id: String,
) -> Result<UpdateCheckResult, String> {
    ensure_loaded(&app);
    let script = {
        let reg = registry().lock().unwrap();
        reg.as_ref()
            .and_then(|v| v.iter().find(|s| s.id == script_id).cloned())
            .ok_or("no such script")?
    };
    let Some(install_url) = script.install_url.clone() else {
        return Err(
            "this script was not installed from a URL, so no update source is pinned for it".into(),
        );
    };
    let url = pinned_update_url(&install_url, script.meta.update_url.as_deref());
    let source = fetch_script_source(&url).await?;
    let meta = parse_metadata(&source)?;
    if meta.name != script.meta.name {
        return Err(format!(
            "the pinned source now calls itself {:?}, not {:?} — an update cannot rename \
             a script; install the new one separately if that is what you want",
            meta.name, script.meta.name
        ));
    }
    if source == script.body {
        let version = script.meta.version.clone();
        return Ok(UpdateCheckResult {
            available: false,
            current_version: version.clone(),
            new_version: version,
            current_source: None,
            new_source: None,
        });
    }
    Ok(UpdateCheckResult {
        available: true,
        current_version: script.meta.version,
        new_version: meta.version,
        current_source: Some(script.body),
        new_source: Some(source),
    })
}

fn apply_update_core(
    scripts: &mut [Script],
    grants: &mut HashMap<String, Vec<String>>,
    script_id: &str,
    source: &str,
) -> Result<(), String> {
    if source.len() > MAX_SCRIPT_BYTES {
        return Err(format!(
            "script is {:.1} MB, larger than the {} MB an update may carry",
            source.len() as f64 / (1024.0 * 1024.0),
            MAX_SCRIPT_BYTES / (1024 * 1024)
        ));
    }
    let meta = parse_metadata(source)?;
    let script = scripts
        .iter_mut()
        .find(|s| s.id == script_id)
        .ok_or("no such script")?;
    if meta.name != script.meta.name {
        return Err(format!(
            "the update calls itself {:?}, not {:?} — an update cannot rename a script",
            meta.name, script.meta.name
        ));
    }
    script.meta = meta;
    script.body = source.to_string();
    // The pin and the grants reset are the two halves of this write; both
    // are asserted in the tests below by name.
    grants.remove(script_id);
    Ok(())
}

/// Apply an update the user has reviewed. `source` is the exact text the
/// check returned and the dialog diffed — the app does not re-fetch, so
/// what was confirmed is byte-for-byte what lands.
#[tauri::command]
pub fn userscript_apply_update(
    app: AppHandle,
    script_id: String,
    source: String,
) -> Result<ScriptInfo, String> {
    ensure_loaded(&app);
    ensure_grants_loaded(&app);
    {
        let mut reg = registry().lock().unwrap();
        let scripts = reg.as_mut().ok_or("registry unavailable")?;
        let mut g = grants().lock().unwrap();
        let table = g.get_or_insert_with(HashMap::new);
        apply_update_core(scripts, table, &script_id, &source)?;
    }
    let script = {
        let reg = registry().lock().unwrap();
        reg.as_ref()
            .and_then(|v| v.iter().find(|s| s.id == script_id).cloned())
            .ok_or("no such script")?
    };
    write_body(&app, &script.id, &script.body);
    persist_registry(&app);
    persist_grants(&app);
    eprintln!("[userscripts] updated script={script_id}");
    Ok(info_of(&app, &script))
}

#[tauri::command]
pub fn userscript_set_enabled(
    app: AppHandle,
    script_id: String,
    enabled: bool,
) -> Result<(), String> {
    ensure_loaded(&app);
    {
        let mut reg = registry().lock().unwrap();
        let scripts = reg.as_mut().ok_or("registry unavailable")?;
        let s = scripts
            .iter_mut()
            .find(|s| s.id == script_id)
            .ok_or("no such script")?;
        s.enabled = enabled;
    }
    persist_registry(&app);
    Ok(())
}

/// Remove a script and everything that was its: body, stored values, grants.
#[tauri::command]
pub fn userscript_remove(app: AppHandle, script_id: String) -> Result<(), String> {
    ensure_loaded(&app);
    {
        let mut reg = registry().lock().unwrap();
        let scripts = reg.as_mut().ok_or("registry unavailable")?;
        let before = scripts.len();
        scripts.retain(|s| s.id != script_id);
        if scripts.len() == before {
            return Err("no such script".into());
        }
    }
    persist_registry(&app);
    values_cache().lock().unwrap().remove(&script_id);
    {
        ensure_grants_loaded(&app);
        if let Some(t) = grants().lock().unwrap().as_mut() {
            t.remove(&script_id);
        }
    }
    persist_grants(&app);
    if let Some(dir) = bodies_dir(&app) {
        let _ = std::fs::remove_file(dir.join(format!("{script_id}.js")));
    }
    if let Ok(dir) = crate::state_dir(&app) {
        let scope = values_scope(&script_id);
        tauri::async_runtime::spawn_blocking(move || {
            let _ = tabverse_fs::state::delete(&dir, &scope);
        });
    }
    eprintln!("[userscripts] removed script={script_id}");
    Ok(())
}

#[tauri::command]
pub fn userscript_revoke_grant(
    app: AppHandle,
    script_id: String,
    host: String,
) -> Result<(), String> {
    ensure_grants_loaded(&app);
    {
        let mut g = grants().lock().unwrap();
        if let Some(t) = g.as_mut() {
            if let Some(hosts) = t.get_mut(&script_id) {
                hosts.retain(|h| h != &host);
                if hosts.is_empty() {
                    t.remove(&script_id);
                }
            }
        }
    }
    persist_grants(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "// ==UserScript==\n// @name T\n// @match https://example.com/*\n// ==/UserScript==\nbody();";

    #[test]
    fn parses_a_full_header() {
        let src = "\
// ==UserScript==
// @name      Immersive Probe
// @version   1.2.3
// @match     *://example.com/*
// @include   /github\\.com/
// @exclude   https://example.com/admin*
// @run-at    document-idle
// @grant     GM_setValue
// @grant     GM_xmlhttpRequest
// @grant     none
// ==/UserScript==
console.log('hi');";
        let m = parse_metadata(src).unwrap();
        assert_eq!(m.name, "Immersive Probe");
        assert_eq!(m.version, "1.2.3");
        assert_eq!(m.matches, vec!["*://example.com/*"]);
        assert_eq!(m.includes, vec!["/github\\.com/"]);
        assert_eq!(m.excludes, vec!["https://example.com/admin*"]);
        assert_eq!(m.run_at, "document-idle");
        // "none" is dropped; the two real grants stay.
        assert_eq!(m.grants, vec!["GM_setValue", "GM_xmlhttpRequest"]);
    }

    #[test]
    fn defaults_fill_in() {
        let m = parse_metadata(HEADER).unwrap();
        assert_eq!(m.version, "0");
        assert_eq!(m.run_at, "document-end");
        assert!(m.grants.is_empty());
    }

    #[test]
    fn rejects_without_header_fences() {
        assert!(parse_metadata("console.log('nope')").is_err());
        assert!(parse_metadata("// ==UserScript==\n// @name X\n// @match *://a/*").is_err());
    }

    #[test]
    fn rejects_without_name() {
        let src = "// ==UserScript==\n// @match https://a.com/*\n// ==/UserScript==";
        let err = parse_metadata(src).unwrap_err();
        assert!(err.contains("@name"), "{err}");
    }

    #[test]
    fn rejects_without_any_matcher() {
        let src = "// ==UserScript==\n// @name X\n// ==/UserScript==";
        let err = parse_metadata(src).unwrap_err();
        assert!(err.contains("@match"), "{err}");
    }

    #[test]
    fn rejects_bad_run_at() {
        let src = "// ==UserScript==\n// @name X\n// @match *://a.com/*\n// @run-at sometime\n// ==/UserScript==";
        assert!(parse_metadata(src).is_err());
    }

    #[test]
    fn rejects_malformed_match_patterns() {
        for bad in [
            "example.com/*",          // no scheme
            "ftp://example.com/*",    // scheme outside the grammar
            "https://example.com",    // no path
            "https://ex*ample.com/*", // wildcard not * or *.suffix
        ] {
            let src = format!("// ==UserScript==\n// @name X\n// @match {bad}\n// ==/UserScript==");
            assert!(parse_metadata(&src).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn rejects_bad_include_regex() {
        let src = "// ==UserScript==\n// @name X\n// @include /[unclosed/\n// ==/UserScript==";
        assert!(parse_metadata(src).is_err());
    }

    fn meta(matches: &[&str], includes: &[&str], excludes: &[&str]) -> ScriptMeta {
        ScriptMeta {
            name: "t".into(),
            version: "0".into(),
            matches: matches.iter().map(|s| s.to_string()).collect(),
            includes: includes.iter().map(|s| s.to_string()).collect(),
            excludes: excludes.iter().map(|s| s.to_string()).collect(),
            run_at: "document-end".into(),
            grants: vec![],
            update_url: None,
        }
    }

    #[test]
    fn match_pattern_matrix() {
        // Scheme: * means http or https, nothing else.
        let m = meta(&["*://example.com/*"], &[], &[]);
        assert!(url_matches(&m, "http://example.com/"));
        assert!(url_matches(&m, "https://example.com/a/b?c=d"));
        assert!(!url_matches(&m, "ftp://example.com/"));
        // Exact scheme.
        let m = meta(&["https://example.com/*"], &[], &[]);
        assert!(!url_matches(&m, "http://example.com/"));
        // Host: *.suffix covers the bare host and subdomains, nothing else.
        let m = meta(&["https://*.example.com/*"], &[], &[]);
        assert!(url_matches(&m, "https://example.com/"));
        assert!(url_matches(&m, "https://a.b.example.com/x"));
        assert!(!url_matches(&m, "https://notexample.com/"));
        // Host: * is any host.
        let m = meta(&["https://*/path"], &[], &[]);
        assert!(url_matches(&m, "https://anything.io/path"));
        assert!(!url_matches(&m, "https://anything.io/path/deeper"));
        // Path glob, including the query string.
        let m = meta(&["https://example.com/a/*"], &[], &[]);
        assert!(url_matches(&m, "https://example.com/a/"));
        assert!(url_matches(&m, "https://example.com/a/b?x=1"));
        assert!(!url_matches(&m, "https://example.com/b/a"));
        // Host with an explicit port: exact port required, others refused.
        let m = meta(&["http://127.0.0.1:18923/userscript-page*"], &[], &[]);
        assert!(url_matches(&m, "http://127.0.0.1:18923/userscript-page"));
        assert!(url_matches(
            &m,
            "http://127.0.0.1:18923/userscript-page?x=1"
        ));
        assert!(!url_matches(&m, "http://127.0.0.1:9999/userscript-page"));
        // Portless host: any port matches (Chrome semantics).
        let m = meta(&["http://127.0.0.1/*"], &[], &[]);
        assert!(url_matches(&m, "http://127.0.0.1:18923/anything"));
        assert!(url_matches(&m, "http://127.0.0.1/plain"));
    }

    #[test]
    fn include_glob_and_regex() {
        // Glob over the whole address.
        let m = meta(&[], &["http*://*/probe*"], &[]);
        assert!(url_matches(&m, "http://127.0.0.1:1234/probe"));
        assert!(url_matches(&m, "https://x.io/probe?q=1"));
        assert!(!url_matches(&m, "https://x.io/other"));
        // Regex form.
        let m = meta(&[], &["/git(hub|lab)\\.com/"], &[]);
        assert!(url_matches(&m, "https://github.com/a"));
        assert!(url_matches(&m, "https://gitlab.com/b"));
        assert!(!url_matches(&m, "https://bitbucket.org/c"));
    }

    #[test]
    fn exclude_wins_over_both() {
        let m = meta(
            &["https://example.com/*"],
            &["/example/"],
            &["https://example.com/private*"],
        );
        assert!(url_matches(&m, "https://example.com/public"));
        assert!(!url_matches(&m, "https://example.com/private/x"));
    }

    #[test]
    fn match_and_include_are_a_union() {
        let m = meta(&["https://a.com/*"], &["https://b.com/*"], &[]);
        assert!(url_matches(&m, "https://a.com/x"));
        assert!(url_matches(&m, "https://b.com/y"));
        assert!(!url_matches(&m, "https://c.com/z"));
    }

    #[test]
    fn glob_edge_cases() {
        assert!(glob_match("*", "anything at all"));
        assert!(glob_match("a*c", "abc"));
        assert!(glob_match("a*c", "ac"));
        assert!(!glob_match("a*c", "ab"));
        assert!(glob_match("*tail", "long tail"));
        assert!(glob_match("head*", "head start"));
        assert!(!glob_match("exact", "exactly"));
    }

    #[test]
    fn value_scopes_are_isolated_and_legal() {
        let a = values_scope("aaaa1111aaaa1111aaaa1111aaaa1111");
        let b = values_scope("bbbb2222bbbb2222bbbb2222bbbb2222");
        assert_ne!(a, b);
        // The state store's charset, mirrored: [A-Za-z0-9:_-].
        for scope in [&a, &b] {
            assert!(scope
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-')));
            // And never the ":<uuid>" tail the orphan sweep reclaims.
            assert!(!scope.contains(':'));
        }
    }

    #[test]
    fn grant_decision_is_per_script_and_per_host() {
        let mut table: HashMap<String, Vec<String>> = HashMap::new();
        assert!(!grant_decision(&table, "s1", "api.example.com"));
        table.insert("s1".into(), vec!["api.example.com".into()]);
        assert!(grant_decision(&table, "s1", "api.example.com"));
        // Another host of the same script: no.
        assert!(!grant_decision(&table, "s1", "other.example.com"));
        // The same host for another script: no.
        assert!(!grant_decision(&table, "s2", "api.example.com"));
        // Revocation empties the row.
        table
            .get_mut("s1")
            .unwrap()
            .retain(|h| h != "api.example.com");
        assert!(!grant_decision(&table, "s1", "api.example.com"));
    }

    fn src_v1() -> String {
        "// ==UserScript==\n// @name T\n// @version 1\n// @match https://a.com/*\n\
         // @updateURL https://evil.example.net/t.user.js\n// ==/UserScript==\nv1();\n"
            .into()
    }

    fn update_script() -> Script {
        Script {
            id: "abcd0000abcd0000abcd0000abcd0000".into(),
            enabled: false, // an update must not touch this either
            meta: parse_metadata(&src_v1()).unwrap(),
            body: src_v1(),
            install_url: Some("https://first.example.org/t.user.js".into()),
        }
    }

    #[test]
    fn parses_the_update_url_directive() {
        assert_eq!(
            parse_metadata(&src_v1()).unwrap().update_url.as_deref(),
            Some("https://evil.example.net/t.user.js")
        );
        assert_eq!(parse_metadata(HEADER).unwrap().update_url, None);
    }

    #[test]
    fn the_update_source_is_pinned_not_followed() {
        // The header may name anywhere; the install URL is the answer.
        assert_eq!(
            pinned_update_url(
                "https://first.example.org/t.user.js",
                Some("https://evil.example.net/t.user.js")
            ),
            "https://first.example.org/t.user.js"
        );
        // A header that says nothing changes nothing.
        assert_eq!(
            pinned_update_url("https://first.example.org/t.user.js", None),
            "https://first.example.org/t.user.js"
        );
    }

    #[test]
    fn apply_update_replaces_the_body_clears_grants_and_keeps_the_pin() {
        let new_source = "// ==UserScript==\n// @name T\n// @version 2\n\
                          // @match https://a.com/*\n// @updateURL https://evil.example.net/t.user.js\n\
                          // ==/UserScript==\nv2();\n";
        let mut scripts = vec![update_script()];
        let mut grants: HashMap<String, Vec<String>> = HashMap::new();
        grants.insert(
            "abcd0000abcd0000abcd0000abcd0000".into(),
            vec!["api.example.com".into()],
        );
        apply_update_core(
            &mut scripts,
            &mut grants,
            "abcd0000abcd0000abcd0000abcd0000",
            new_source,
        )
        .unwrap();
        let s = &scripts[0];
        assert_eq!(s.body, new_source);
        assert_eq!(s.meta.version, "2");
        // The identity the update must not disturb.
        assert_eq!(s.id, "abcd0000abcd0000abcd0000abcd0000");
        assert!(!s.enabled);
        // The pin: even a new version whose header names another
        // @updateURL cannot move the source the next check will fetch.
        assert_eq!(
            s.install_url.as_deref(),
            Some("https://first.example.org/t.user.js")
        );
        // The grant reset: the new version asks from scratch.
        assert!(
            !grants.contains_key("abcd0000abcd0000abcd0000abcd0000"),
            "an update must clear the script's granted hosts"
        );
    }

    #[test]
    fn apply_update_refuses_a_rename() {
        let renamed = "// ==UserScript==\n// @name Other\n// @match https://a.com/*\n\
                       // ==/UserScript==\nx();\n";
        let mut scripts = vec![update_script()];
        let mut grants = HashMap::new();
        let err = apply_update_core(
            &mut scripts,
            &mut grants,
            "abcd0000abcd0000abcd0000abcd0000",
            renamed,
        )
        .unwrap_err();
        assert!(err.contains("rename"), "{err}");
        assert_eq!(scripts[0].body, src_v1());
    }

    #[test]
    fn apply_update_refuses_an_unknown_script() {
        let mut scripts = vec![update_script()];
        let mut grants = HashMap::new();
        assert!(apply_update_core(&mut scripts, &mut grants, "nope", &src_v1()).is_err());
    }

    #[test]
    fn apply_update_refuses_a_source_without_a_header() {
        let mut scripts = vec![update_script()];
        let mut grants = HashMap::new();
        let err = apply_update_core(
            &mut scripts,
            &mut grants,
            "abcd0000abcd0000abcd0000abcd0000",
            "console.log('no header');",
        )
        .unwrap_err();
        assert!(err.contains("==UserScript=="), "{err}");
        assert_eq!(scripts[0].body, src_v1());
    }

    #[test]
    fn wrapper_shadows_privates_and_gates_grants() {
        let s = Script {
            id: "cafe0000cafe0000cafe0000cafe0000".into(),
            enabled: true,
            meta: ScriptMeta {
                name: "t".into(),
                version: "1".into(),
                matches: vec!["*://a.com/*".into()],
                includes: vec![],
                excludes: vec![],
                run_at: "document-end".into(),
                grants: vec!["GM_setValue".into()],
                update_url: None,
            },
            body: "GM_setValue('k', 1);".into(),
            install_url: None,
        };
        let w = build_wrapper(&s, &serde_json::Map::new(), "nonce123", "https://a.com/");
        // Granted: present. Not granted: absent.
        assert!(w.contains("function GM_setValue"));
        assert!(!w.contains("function GM_xmlhttpRequest"));
        assert!(!w.contains("function GM_registerMenuCommand"));
        assert!(w.contains("var __calT, __calN, __calS, __calPost, __calSend, __calVals,"));
    }
}
