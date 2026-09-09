//! Official Tauri/Wry Browser adapter and browser command surface.

#![allow(clippy::wildcard_imports)]
use crate::*;

/// Where a child webview goes, in *device* pixels.
///
/// Physical rather than logical because the UI measures in CSS pixels, and a
/// CSS pixel matches a logical one only when nothing scales the page. It does
/// not on Windows with a text-scale factor set. The UI multiplies by its own
/// `devicePixelRatio` before sending, which folds in display scale and page
/// zoom together, and these numbers then need no conversion here at all.
#[derive(serde::Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn position(self) -> tauri::PhysicalPosition<i32> {
        tauri::PhysicalPosition::new(self.x.round() as i32, self.y.round() as i32)
    }
    fn size(self) -> tauri::PhysicalSize<u32> {
        tauri::PhysicalSize::new(
            self.width.max(0.0).round() as u32,
            self.height.max(0.0).round() as u32,
        )
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserEvent {
    tab_id: String,
    url: String,
    title: String,
}

/// Standard Safari UA for the platform WebKit. The engine IS Safari's, but
/// WKWebView's default UA omits the Safari token — and sites like Google
/// treat an unrecognized UA as a legacy browser and serve their fallback
/// pages from a decade ago.
pub(crate) const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

pub(crate) fn dirs_next_download() -> std::path::PathBuf {
    #[cfg(test)]
    {
        // Unit tests redirect downloads into a sandbox. This branch is not
        // compiled into the application.
        if let Ok(dir) = std::env::var("TABVERSE_DOWNLOAD_DIR") {
            return std::path::PathBuf::from(dir);
        }
    }
    // Via home_path, not HOME directly: on Windows HOME is unset, and reading
    // only it put every download in the temp directory — somewhere the user's
    // file manager never looks and the OS eventually clears.
    home_path()
        .map(|h| h.join("Downloads"))
        .unwrap_or_else(std::env::temp_dir)
}

pub(crate) fn webview_label(tab_id: &str) -> String {
    // Labels must be unique and may not contain the characters uuid uses.
    format!("browser-{}", tab_id.replace('-', ""))
}

/// Secret this run's pages must quote to raise a shortcut.
///
/// It lives in a closure inside the injected script, where a page's own scripts
/// cannot read it, so a page cannot open or close the user's tabs by guessing
/// the scheme.
static CMD_TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub(crate) fn cmd_token() -> &'static str {
    CMD_TOKEN.get_or_init(uuid_like)
}

pub(crate) const CMD_SCHEME: &str = "tabverse-cmd:";

/// Give a web page's own keyboard handling first refusal, then take the app's
/// shortcuts back from it.
///
/// A menu key equivalent is supposed to be offered to the application before
/// any view, but a WKWebView claims command-key combinations for the web
/// content it hosts, and the menu never hears about them — so on a browser tab
/// ⌘T opened nothing. The page is the only place left that definitely sees the
/// key, so it reports the shortcut back by attempting a navigation the app
/// cancels; nothing about the page changes.
fn shortcut_script() -> String {
    shortcut_script_for(&keys::current())
}

/// The script for a given composition — the whole of the function above, with
/// "which composition" as an argument.
///
/// Split so that "does the injected script follow a rebinding" is a question
/// a test can ask of an overlay it constructs, rather than one that could
/// only be asked of whatever this process happens to have loaded from disk.
pub(crate) fn shortcut_script_for(bindings: &keys::Bindings) -> String {
    let (plain, shifted) = bindings.page_tables();
    // The tab cycle, which `page_tables` cannot carry: it is a `local` row —
    // a view answers it — and every ⌃ chord is filtered out of those tables
    // anyway. It was therefore the ONE key in this script still written by
    // hand, and the hand-written copy was the seventh of its kind: the shape
    // that bound shift+D to a deleted command lived in this same string.
    let cycle = bindings.cycle_chord();
    let jump = match bindings.jump_range() {
        Some((lo, hi)) => format!(
            "{{lo:{},hi:{}}}",
            serde_json::to_string(&lo.to_string()).unwrap_or_default(),
            serde_json::to_string(&hi.to_string()).unwrap_or_default()
        ),
        None => "null".to_string(),
    };
    format!(
        r#"(function(){{
  var TOKEN = "{token}", SCHEME = "{scheme}";
  var loc = window.location;
  var PLAIN = {plain};
  var SHIFTED = {shifted};
  // The one way out of the page, tried in order of what it costs the page.
  // Both engines have a message channel that touches nothing; they simply
  // have different names for it. Returns whether anything took it.
  function post(msg) {{
    try {{
      window.webkit.messageHandlers.{handler}.postMessage(msg);
      return true;
    }} catch (_) {{}}
    try {{
      window.chrome.webview.postMessage(msg);
      return true;
    }} catch (_) {{}}
    return false;
  }}
  function raise(cmd) {{
    var msg = cmd.indexOf("?") < 0 ? cmd + "?t=" + TOKEN : cmd;
    if (post(msg)) return;
    // Last resort, reached only where neither channel exists: a top-level
    // navigation the app cancels costs an interrupted load, which is why it
    // is not tried first; doing nothing at all costs the shortcut.
    try {{
      loc.href = SCHEME + msg;
    }} catch (_) {{}}
  }}
  // Nine keys from one table row, whose ends come from that row rather than
  // from a digit test written down here. JUMP is null when the row is unbound.
  var JUMP = {jump};
  // The one chord this page answers outside the two tables above: the tab
  // cycle, whose row is handled by a view and whose modifier is not ⌘.
  // Serialized from the same composition; null when nothing is bound to it.
  var CYCLE = {cycle};
  function lookup(k, shifted) {{
    var cmd = shifted ? SHIFTED[k] : PLAIN[k];
    if (!cmd && !shifted && JUMP && k.length === 1 && k >= JUMP.lo && k <= JUMP.hi) {{
      cmd = "jump-" + k;
    }}
    return cmd;
  }}
  // cmd+click on a link opens it in a new tab — the muscle memory every
  // browser honors. Trusted events only: a synthetic cmd+click must not
  // let a page open tabs without a real user gesture (the native
  // new-window route is rate-limited for the same reason).
  window.addEventListener("click", function(e) {{
    if (!e.isTrusted || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    raise("open-tab?t=" + TOKEN + "&u=" + encodeURIComponent(a.href));
  }}, true);
  window.addEventListener("click", function(e) {{
    if (!e.isTrusted || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    raise("peek-link?t=" + TOKEN + "&u=" + encodeURIComponent(a.href));
  }}, true);
  // The page owns its pixels: a press or a pointer at its left edge is
  // invisible to the app, because a native view sits above the whole DOM.
  // Reported through a hidden frame rather than a top-level navigation,
  // which at this frequency would fight the page's own navigation.
  if (window.top === window) {{
    var edge = false;
    function tell(cmd, x) {{
      var msg = cmd + (cmd.indexOf("?") < 0 ? "?t=" + TOKEN : "");
      if (typeof x === "number") {{
        msg += "&x=" + Math.round(x);
      }}
      post(msg);
    }}
    document.addEventListener("mousedown", function(e) {{
      if (e.isTrusted) tell("page-press", e.clientX);
    }}, true);
    var corner = false;
    document.addEventListener("mousemove", function(e) {{
      if (!e.isTrusted) return;
      var now = e.clientX <= 10;
      // Only the crossing, never every pixel of travel.
      // Both crossings: entering summons the sidebar, leaving releases it.
      if (now !== edge) {{
        edge = now;
        // The exit carries WHERE the pointer went. Ten pixels is where the
        // sidebar is summoned from, but it is not where the sidebar ENDS —
        // reporting a bare exit made the sidebar vanish the moment the
        // pointer moved onto it (2026-08-12 feedback 1). The app knows its
        // own width and decides; this only supplies the fact.
        tell(now ? "page-left-edge" : "page-left-edge-exit", e.clientX);
      }}
      var w = document.documentElement.clientWidth || window.innerWidth || 0;
      var inCorner = (w - e.clientX) <= 170 && e.clientY <= 56;
      if (inCorner !== corner) {{
        corner = inCorner;
        if (inCorner) tell("page-corner", e.clientX);
      }}
    }}, true);

    // Where the tab actually is. A full page load reaches the app on its
    // own, but a page that changes its address without one — every modern
    // site's in-place navigation — leaves the app holding the address the
    // tab was opened with, which is what ⌘L, "copy link" and the saved
    // session all then show. Reading it off the webview is forbidden (an
    // uncommitted view has none, and the layer below unwraps that and takes
    // the process with it), so the page reports its own.
    var lastX = 0, lastY = 0;
    document.addEventListener("mousemove", function(e) {{
      lastX = e.clientX; lastY = e.clientY;
      // Published, because the app has to be able to say "the pointer left
      // THAT" after it takes the pointer away — and once the interface layer
      // is up the engine's own :hover is already empty, so it cannot answer.
      window.__tabversePointer = {{ x: lastX, y: lastY }};
    }}, true);
    // Why does this site look different here than in another browser? The
    // answer is always in computed style, and only the page can read it.
    // Bound to a key so the element in question can simply be pointed at.
    window.addEventListener("__tabverse_layout", function() {{
      try {{
        var el = document.elementFromPoint(lastX, lastY);
        var out = [];
        for (var i = 0; el && i < 5; i++, el = el.parentElement) {{
          var c = getComputedStyle(el);
          var r = el.getBoundingClientRect();
          out.push({{
            tag: el.tagName.toLowerCase(),
            cls: (el.className || "").toString().slice(0, 120),
            display: c.display,
            dir: c.flexDirection,
            wrap: c.flexWrap,
            align: c.alignItems,
            justify: c.justifyContent,
            w: Math.round(r.width),
            h: Math.round(r.height)
          }});
        }}
        tell("layout?t=" + TOKEN + "&d=" + encodeURIComponent(JSON.stringify(out)));
      }} catch (e) {{
        tell("layout?t=" + TOKEN + "&d=" + encodeURIComponent(String(e)));
      }}
    }});

    var lastIcon = "";
    function reportFavicon() {{
      try {{
        var l = document.querySelector(
          'link[rel~="icon" i], link[rel="apple-touch-icon" i]');
        var href = l && l.href ? l.href : (location.origin + "/favicon.ico");
        // http(s) is fetched by the app; a data: URI (a site drawing its icon,
        // e.g. a pipeline progress ring) is passed through and decoded there.
        if (!/^(https?|data):/i.test(href) || href === lastIcon) return;
        lastIcon = href;
        tell("favicon?t=" + TOKEN
          + "&h=" + encodeURIComponent(location.hostname)
          + "&u=" + encodeURIComponent(href));
      }} catch (_) {{}}
    }}
    var faviconTimer = 0;
    function scheduleFavicon() {{
      if (faviconTimer) return;
      faviconTimer = setTimeout(function () {{
        faviconTimer = 0;
        reportFavicon();
      }}, 250);
    }}
    function watchFavicon() {{
      try {{
        if (!document.head || typeof MutationObserver !== "function") return;
        new MutationObserver(scheduleFavicon).observe(document.head, {{
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["href", "rel"]
        }});
      }} catch (_) {{}}
    }}
    // After load, when the head is final; and immediately when this script
    // runs on an already-loaded document (a webview restored mid-life).
    if (document.readyState === "complete") {{
      setTimeout(reportFavicon, 0);
      watchFavicon();
    }}
    window.addEventListener("load", function () {{
      setTimeout(reportFavicon, 0);
      watchFavicon();
    }});

    var lastUrl = location.href;
    function reportUrl() {{
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      tell("url?t=" + TOKEN + "&u=" + encodeURIComponent(location.href));
      setTimeout(reportFavicon, 250);
    }}
    ["pushState", "replaceState"].forEach(function(name) {{
      var orig = history[name];
      if (typeof orig !== "function") return;
      history[name] = function() {{
        var r = orig.apply(this, arguments);
        setTimeout(reportUrl, 0);
        return r;
      }};
    }});
    window.addEventListener("popstate", function() {{ setTimeout(reportUrl, 0); }});
    window.addEventListener("hashchange", reportUrl);

    var muteOn = false, lastAudible = null, muteObserver = null;
    function elAudible(m) {{
      return !m.paused && !m.ended && !m.muted && m.volume > 0;
    }}
    function anyAudible() {{
      var list = document.querySelectorAll("audio,video");
      for (var i = 0; i < list.length; i++) if (elAudible(list[i])) return true;
      return false;
    }}
    function reportAudible() {{
      var a = anyAudible();
      if (a === lastAudible) return;
      lastAudible = a;
      tell("media-audible?t=" + TOKEN + "&a=" + (a ? "1" : "0"));
    }}
    function muteAll() {{
      var list = document.querySelectorAll("audio,video");
      for (var i = 0; i < list.length; i++) {{
        try {{ list[i].muted = true; }} catch (_) {{}}
      }}
    }}
    // Non-bubbling media events still travel the capture phase from window
    // down, so one capturing listener on the document catches every element,
    // present or added later — no per-element wiring, and dynamic media is
    // covered for free.
    ["play", "playing", "pause", "ended", "volumechange", "loadeddata", "emptied"]
      .forEach(function(ev) {{
        document.addEventListener(ev, function() {{
          if (muteOn) muteAll();
          reportAudible();
        }}, true);
      }});
    window.addEventListener("__tabverse_setmute", function(e) {{
      muteOn = !!(e && e.detail && e.detail.on);
      var list = document.querySelectorAll("audio,video");
      for (var i = 0; i < list.length; i++) {{
        try {{ list[i].muted = muteOn; }} catch (_) {{}}
      }}
      if (muteOn) {{
        if (!muteObserver) {{
          muteObserver = new MutationObserver(function() {{ if (muteOn) muteAll(); }});
          try {{
            muteObserver.observe(document.documentElement, {{ childList: true, subtree: true }});
          }} catch (_) {{}}
        }}
      }} else if (muteObserver) {{
        try {{ muteObserver.disconnect(); }} catch (_) {{}}
        muteObserver = null;
      }}
      reportAudible();
    }});

    (function() {{
      var perm = "default", askSeq = 0, waiting = {{}};
      window.addEventListener("__tabverse_notify_perm", function(e) {{
        var d = (e && e.detail) || {{}};
        if (d.perm) perm = d.perm;
        var w = waiting[d.id];
        if (w) {{ delete waiting[d.id]; w(d.perm); }}
      }});
      function request(cb) {{
        var p = new Promise(function(resolve) {{
          if (perm !== "default") {{ resolve(perm); return; }}
          var id = ++askSeq;
          waiting[id] = resolve;
          tell("notify-ask?t=" + TOKEN
            + "&h=" + encodeURIComponent(location.hostname) + "&id=" + id);
        }});
        if (typeof cb === "function") p.then(cb);
        return p;
      }}
      function N(title, opts) {{
        if (!(this instanceof N)) return new N(title, opts);
        opts = opts || {{}};
        this.title = String(title == null ? "" : title);
        this.body = String(opts.body == null ? "" : opts.body);
        this.icon = String(opts.icon == null ? "" : opts.icon);
        this.onclick = this.onclose = this.onerror = this.onshow = null;
        if (perm === "granted") {{
          var payload = {{ title: this.title, body: this.body, icon: this.icon }};
          tell("notify-show?t=" + TOKEN + "&d="
            + encodeURIComponent(JSON.stringify(payload)));
        }}
      }}
      N.requestPermission = request;
      N.prototype.close = function() {{}};
      N.prototype.addEventListener = function() {{}};
      N.prototype.removeEventListener = function() {{}};
      try {{
        Object.defineProperty(N, "permission", {{ get: function() {{ return perm; }} }});
      }} catch (_) {{}}
      try {{
        Object.defineProperty(window, "Notification",
          {{ value: N, writable: true, configurable: true }});
      }} catch (_) {{ try {{ window.Notification = N; }} catch (_) {{}} }}
    }})();
  }}
  window.addEventListener("keydown", function(e) {{
    // Only the OS makes trusted events. A page can dispatchEvent a synthetic
    // ⌘W all day; acting on it would let any site close the user's tabs.
    if (!e.isTrusted) return;
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {{
      post("peek-escape?t=" + TOKEN);
      return;
    }}
    // The tab cycle, from the composition like everything else on this page
    // (keys.rs `cycle_chord`). Shift is not compared: it picks the direction,
    // which is why the object carries the other three modifiers and not it.
    // The three ARE compared, where the hand-written line this replaced tested
    // only ctrl — so a chord that merely contained ctrl no longer cycles tabs
    // by accident.
    if (CYCLE
        && e.ctrlKey === CYCLE.ctrl
        && e.metaKey === CYCLE.cmd
        && e.altKey === CYCLE.alt
        && (e.key || "").toLowerCase() === CYCLE.key) {{
      e.preventDefault(); e.stopImmediatePropagation();
      raise(e.shiftKey ? "prev-tab" : "next-tab");
      return;
    }}
    if (!e.metaKey || e.ctrlKey || e.altKey) return;
    var cmd = lookup((e.key || "").toLowerCase(), e.shiftKey);
    if (!cmd) return;
    e.preventDefault(); e.stopImmediatePropagation();
    raise(cmd);
  }}, true);
  // A plain <a target=_blank> never calls window.open — it asks the engine
  // for a new window, and with no handler wry silently drops it. Modified
  // clicks are left alone so ⌘-click keeps its meaning.
  document.addEventListener("click", function(e) {{
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[target=_blank],a[target=_new]") : null;
    if (a && a.href) {{ e.preventDefault(); top.location.href = a.href; }}
  }}, true);
}})();"#,
        token = cmd_token(),
        scheme = CMD_SCHEME,
        handler = PAGE_CHANNEL,
        plain = plain,
        shifted = shifted,
        jump = jump,
        cycle = cycle,
    )
}

/// Turn a cancelled `tabverse-cmd:` navigation back into a shortcut.
///
/// Returns true when the url was one of ours, meaning the navigation must not
/// proceed.
/// A report from a page, however it travelled: `cmd?t=TOKEN&…`.
///
/// The transport is deliberately not this function's business — it used to
/// be a cancelled navigation, it is now a script message, and the parsing
/// and the token check are the same either way.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn handle_page_report(app: &AppHandle, tab_id: &str, payload: &str) -> bool {
    handle_command(app, tab_id, payload)
}

fn handle_shortcut_url(app: &AppHandle, tab_id: &str, url: &tauri::Url) -> bool {
    let raw = url.as_str();
    let Some(rest) = raw.strip_prefix(CMD_SCHEME) else {
        return false;
    };
    handle_command(app, tab_id, rest)
}

fn handle_command(app: &AppHandle, tab_id: &str, rest: &str) -> bool {
    let (cmd, query) = rest.split_once("?t=").unwrap_or((rest, ""));
    // The token may be followed by command arguments: `t=TOKEN&u=<url>`.
    let (token, extra) = query.split_once('&').unwrap_or((query, ""));
    if token != cmd_token() {
        eprintln!("[core] shortcut url with a bad token, ignored");
        return true;
    }
    let cmd = cmd.trim_matches('/').to_string();
    // Password-manager reports carry secrets or page state; they are
    // dispatched BEFORE the generic log line below on purpose — nothing
    // from their parameters may ever be printed.
    if cmd == "save-password" {
        if let Some(d) = extra.strip_prefix("d=") {
            let decoded = percent_encoding::percent_decode_str(d).decode_utf8_lossy();
            passwords::handle_capture(app, tab_id, &decoded);
        }
        return true;
    }
    if cmd == "pw-form" {
        if let Some(h) = extra.strip_prefix("h=") {
            let host = percent_encoding::percent_decode_str(h).decode_utf8_lossy();
            passwords::handle_form_present(app, tab_id, &host);
        }
        return true;
    }
    if cmd == "us-query" {
        if let Some(u) = extra.strip_prefix("u=") {
            let url = percent_encoding::percent_decode_str(u)
                .decode_utf8_lossy()
                .to_string();
            userscripts::handle_query(app, tab_id, &url);
        }
        return true;
    }
    if cmd == "us-set" || cmd == "us-menu" || cmd == "us-xhr" {
        if let Some(d) = extra.strip_prefix("d=") {
            let decoded = percent_encoding::percent_decode_str(d)
                .decode_utf8_lossy()
                .to_string();
            userscripts::handle_report(app, tab_id, &cmd, &decoded);
        }
        return true;
    }
    if cmd == "notify-ask" {
        let mut host = String::new();
        let mut ask_id: u64 = 0;
        for part in extra.split('&') {
            match part.split_once('=') {
                Some(("h", v)) => {
                    host = percent_encoding::percent_decode_str(v)
                        .decode_utf8_lossy()
                        .to_string();
                }
                Some(("id", v)) => ask_id = v.parse().unwrap_or(0),
                _ => {}
            }
        }
        page_notify::request_permission(app, tab_id, &host, ask_id);
        return true;
    }
    if cmd == "notify-show" {
        if let Some(d) = extra.strip_prefix("d=") {
            let decoded = percent_encoding::percent_decode_str(d)
                .decode_utf8_lossy()
                .to_string();
            page_notify::show(app, tab_id, &decoded);
        }
        return true;
    }
    if cmd == "media-audible" {
        let audible = extra.strip_prefix("a=").is_some_and(|v| v == "1");
        let _ = app.emit(
            "browser-media",
            serde_json::json!({ "tabId": tab_id, "audible": audible }),
        );
        return true;
    }
    if cmd == "page-press"
        || cmd == "page-left-edge"
        || cmd == "page-left-edge-exit"
        || cmd == "page-corner"
    {
        // The pointer's x, when the report carries one (the left-edge exit):
        // the interface compares it with its own sidebar width.
        let x = extra
            .split('&')
            .find_map(|part| part.strip_prefix("x="))
            .and_then(|v| v.parse::<f64>().ok());
        let _ = app.emit(
            "browser-pointer",
            serde_json::json!({ "kind": cmd, "tabId": tab_id, "x": x }),
        );
        return true;
    }
    if cmd == "peek-escape" {
        let _ = app.emit(
            "browser-peek-escape",
            serde_json::json!({ "tabId": tab_id }),
        );
        return true;
    }
    if cmd == "url" {
        if let Some(enc) = extra.strip_prefix("u=") {
            let url = percent_encoding::percent_decode_str(enc)
                .decode_utf8_lossy()
                .to_string();
            eprintln!("[core] in-page address change tab={tab_id} url={url}");
            let _ = app.emit(
                "browser-url",
                BrowserEvent {
                    tab_id: tab_id.to_string(),
                    url,
                    title: String::new(),
                },
            );
        }
        return true;
    }
    if cmd == "favicon" {
        let mut host = String::new();
        let mut icon = String::new();
        for part in extra.split('&') {
            match part.split_once('=') {
                Some(("h", v)) => {
                    host = percent_encoding::percent_decode_str(v)
                        .decode_utf8_lossy()
                        .to_string();
                }
                Some(("u", v)) => {
                    icon = percent_encoding::percent_decode_str(v)
                        .decode_utf8_lossy()
                        .to_string();
                }
                _ => {}
            }
        }
        favicon::report(app, tab_id, &host, &icon);
        return true;
    }
    if cmd == "unload-check" {
        let dirty = extra.strip_prefix("d=").is_some_and(|v| v == "1");
        let _ = app.emit(
            "browser-unload-answer",
            serde_json::json!({ "tabId": tab_id, "dirty": dirty }),
        );
        return true;
    }
    if cmd == "open-tab" {
        // cmd+click on a link, reported by the injected listener. The href
        // rides percent-encoded in `u=`; scheme and rate checks live in
        // open_tab_in_app, shared with the engine's new-window route.
        if let Some(enc) = extra.strip_prefix("u=") {
            let url = percent_encoding::percent_decode_str(enc)
                .decode_utf8_lossy()
                .to_string();
            open_tab_in_app(app, &url);
        }
        return true;
    }
    if cmd == "peek-link" {
        if let Some(enc) = extra.strip_prefix("u=") {
            let url = percent_encoding::percent_decode_str(enc)
                .decode_utf8_lossy()
                .to_string();
            let _ = app.emit(
                "browser-open-peek",
                serde_json::json!({ "tabId": tab_id, "url": url }),
            );
        }
        return true;
    }
    eprintln!("[core] shortcut from page: {cmd}");
    let _ = app.emit("app-command", AppCommandEvent { cmd, from: "page" });
    true
}

fn open_tab_in_app(app: &AppHandle, url: &str) {
    match url.parse::<tauri::Url>() {
        Ok(u) if matches!(u.scheme(), "http" | "https") => {}
        _ => {
            eprintln!("[core] open-tab refused non-http(s) url");
            return;
        }
    }
    static WINDOW: Mutex<Option<(std::time::Instant, u32)>> = Mutex::new(None);
    {
        let mut w = WINDOW.lock().unwrap();
        let now = std::time::Instant::now();
        let (start, count) = w.get_or_insert((now, 0));
        if now.duration_since(*start) > std::time::Duration::from_secs(1) {
            *start = now;
            *count = 0;
        }
        *count += 1;
        if *count > 5 {
            eprintln!("[core] open-tab rate limit hit, dropped");
            return;
        }
    }
    eprintln!("[core] open-tab -> new browser tab");
    let _ = app.emit("browser-open-tab", serde_json::json!({ "url": url }));
}

#[tauri::command]
pub(crate) fn browser_open_external(url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) pages can be opened externally".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(parsed.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open failed: {e}"))
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct AppCommandEvent {
    pub(crate) cmd: String,
    /// Which route delivered it. Both can fire for one press, and only the
    /// route tells them apart from the user pressing the key twice.
    pub(crate) from: &'static str,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FindResultEvent {
    tab_id: String,
    total: u32,
    current: u32,
    /// How many frames the report covered. The find bar shows the
    /// "main page and same-origin embeds" note off this, so a page with
    /// one frame stays unannotated and a multi-frame search says its
    /// scope instead of implying the whole web was counted.
    frames: u32,
}

pub(crate) fn parse_find_counts(query: &str) -> Option<(u32, u32, u32)> {
    let mut counts: Vec<u32> = Vec::new();
    let mut current: Option<u32> = None;
    let mut declared: Option<u32> = None;
    for part in query.split('&') {
        match part.split_once('=') {
            Some(("n", v)) => counts.push(v.parse().ok()?),
            Some(("i", v)) => current = v.parse().ok(),
            Some(("f", v)) => declared = v.parse().ok(),
            _ => {}
        }
    }
    let current = current?;
    if counts.is_empty() {
        // A report with no frame counts is no report: the finder always
        // sends one n per frame searched, top frame included.
        return None;
    }
    let frames = counts.len() as u32;
    if declared.is_some_and(|f| f != frames) {
        eprintln!("[core] find-result frame count {declared:?} disagrees with {frames} counts");
    }
    let total = counts.iter().sum::<u32>();
    Some((total, current, frames))
}

/// Turn a cancelled `tabverse-cmd:find-result?n=<count>&…&f=<frames>&i=<current>`
/// navigation into a find-result event for the UI's match counter.
///
/// Deliberately exempt from the token check that gates every other
/// `tabverse-cmd:` navigation: the finder runs as page-world code (see
/// `browser_find`), so handing it the token would hand it to the page too.
/// Forging this report gains a page nothing — it can only lie about its own
/// match count, which is display-only — while command forgery (close-tab and
/// friends) stays token-gated in `handle_shortcut_url`.
///
/// Returns true when the url was a find-result, meaning the navigation must
/// not proceed. Anything but parseable u32 counts is dropped (still
/// cancelled).
fn handle_find_result_url(app: &AppHandle, tab_id: &str, url: &tauri::Url) -> bool {
    let raw = url.as_str();
    let Some(rest) = raw.strip_prefix(CMD_SCHEME) else {
        return false;
    };
    let Some(query) = rest.strip_prefix("find-result?") else {
        return false;
    };
    if let Some((total, current, frames)) = parse_find_counts(query) {
        let _ = app.emit(
            "browser-find-result",
            FindResultEvent {
                tab_id: tab_id.to_string(),
                total,
                current,
                frames,
            },
        );
    } else {
        eprintln!("[core] find-result with malformed counts, dropped");
    }
    true
}

/// The loopback proxy's slot in [`AppState`], and what trying to start it
/// found.
#[derive(Default)]
pub(crate) enum PageProxySlot {
    /// Nobody has asked for coverage yet — the default, because the switch
    /// defaults to off and an app that never covers a page never runs the
    /// proxy's threads.
    #[default]
    Idle,
    /// Running, holding the port every covered webview is pointed at.
    Running(page_proxy::PageProxy),
    Failed,
}

pub(crate) fn page_proxy_url(
    cover_on: bool,
    policy: &http::DnsPolicy,
    coverable: bool,
    port: u16,
) -> Option<String> {
    (cover_on && matches!(policy, http::DnsPolicy::Doh(_)) && coverable)
        .then(|| format!("http://127.0.0.1:{port}"))
}

pub(crate) fn is_coverable_platform() -> bool {
    #[cfg(target_os = "macos")]
    {
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        macos_version_coverable(version.majorVersion as u64, version.minorVersion as u64)
    }
    #[cfg(target_os = "windows")]
    {
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// The macOS half of the gate, on the (major, minor) the probe reports, so
/// the boundary is testable without owning a machine on each side of it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn macos_version_coverable(major: u64, minor: u64) -> bool {
    (major, minor) >= (14, 0)
}

fn ensure_page_proxy(
    app: &AppHandle,
    state: &AppState,
    cover_on: bool,
    coverable: bool,
) -> Option<String> {
    let policy = http::policy();
    // Asked with port 0 because only the three conditions' answer matters
    // here — a tab the conditions do not cover is never the tab that starts
    // the proxy. The real port is named below.
    page_proxy_url(cover_on, &policy, coverable, 0)?;
    let mut slot = state.page_proxy.lock().unwrap_or_else(|e| e.into_inner());
    // The first ask starts the proxy; a start that already failed is not
    // retried. The proxy is handed a death notice to deliver — the event
    // the settings page's banner and the tab wiring both answer to.
    if matches!(&*slot, PageProxySlot::Idle) {
        let tell_app = app.clone();
        match page_proxy::PageProxy::start(move || {
            if let Some(window) = tell_app.get_window("main") {
                clear_shared_page_proxy(&window);
            }
            let _ = tell_app.emit("page-proxy-down", serde_json::json!({ "status": "down" }));
        }) {
            Ok(proxy) => {
                let port = proxy.port;
                *slot = PageProxySlot::Running(proxy);
                eprintln!("[core] page proxy covering page traffic on 127.0.0.1:{port}");
            }
            Err(e) => {
                *slot = PageProxySlot::Failed;
                eprintln!(
                    "[core] page traffic coverage is on but the loopback proxy could not \
                     start ({e}); page traffic resolves through the system for the rest \
                     of this run"
                );
            }
        }
    }
    slot_page_proxy_url(&slot, cover_on, &policy, coverable)
}

pub(crate) fn slot_page_proxy_url(
    slot: &PageProxySlot,
    cover_on: bool,
    policy: &http::DnsPolicy,
    coverable: bool,
) -> Option<String> {
    let PageProxySlot::Running(proxy) = slot else {
        return None; // never asked for, or a start that failed
    };
    if !proxy.is_alive() {
        eprintln!(
            "[core] the page proxy's listener is not alive; the new tab resolves \
             through the system, and already-open tabs fall back on reopen"
        );
        return None;
    }
    page_proxy_url(cover_on, policy, coverable, proxy.port)
}

/// Clear wry's proxy from the shared default WKWebsiteDataStore before a
/// direct page is born.
///
/// `proxy_url` looks per-builder, but wry implements it by setting the
/// private `proxyConfigurations` key on the website data store. Tabverse's
/// page webviews share the default store so their cookies remain one jar;
/// a later builder with no proxy does NOT clear the earlier value. Clearing
/// here makes the setting global — as the shared store actually is — while
/// preserving the cookie jar. Existing pages use the new route for their
/// next request; the Settings copy names that reality rather than promising
/// a per-tab configuration WebKit cannot provide.
#[cfg(target_os = "macos")]
fn clear_shared_page_proxy(window: &Window) {
    let Some(main) = window.get_webview("main") else {
        return;
    };
    let _ = main.with_webview(|pw| unsafe {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        let wk = pw.inner() as *mut AnyObject;
        let config: *mut AnyObject = msg_send![&*wk, configuration];
        let store: *mut AnyObject = msg_send![&*config, websiteDataStore];
        let array_class = AnyClass::get(&std::ffi::CString::new("NSArray").unwrap())
            .expect("Foundation always has NSArray");
        let empty: *mut AnyObject = msg_send![array_class, array];
        let key = objc2_foundation::NSString::from_str("proxyConfigurations");
        let _: () = msg_send![&*store, setValue: empty, forKey: &*key];
    });
}

#[cfg(not(target_os = "macos"))]
fn clear_shared_page_proxy(_window: &Window) {}

/// Embed a real web page as a child webview positioned over the tab area.
///
/// A child webview (rather than an iframe) is what makes this a browser tab
/// and not a framed page: no X-Frame-Options refusals, its own history, and
/// the platform's own rendering. The cost is that it floats above the DOM, so
/// the UI must keep telling us where to put it.
#[tauri::command]
pub(crate) async fn browser_create(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    use tauri::WebviewUrl;

    eprintln!("[core] browser_create enter tab={tab_id} url={url}");
    // A restored tab must not fire its first request before the saved
    // session cookies are back in the store — that request would go out
    // logged-out and could overwrite the very cookie about to be restored.
    let restore_app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        cookies::ensure_restored(&restore_app);
    })
    .await;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let label = webview_label(&tab_id);
    if window.get_webview(&label).is_some() {
        eprintln!("[core] browser_create already exists");
        return Ok(());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    #[cfg(target_os = "macos")]
    nav_failures::remember_request(&tab_id, &url);
    peek::command_stamp(&tab_id);

    // Page-load events come from the engine itself, so they report what the
    // page actually did rather than what we asked for. External pages get no
    // Tauri IPC injected, so this is also the only honest load signal we have.
    let load_app = app.clone();
    let load_tab = tab_id.clone();
    let title_app = app.clone();
    let title_tab = tab_id.clone();
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .auto_resize()
        .user_agent(BROWSER_UA)
        // Real page titles for the sidebar; external pages have no IPC, so
        // this engine callback is the only honest source.
        .on_document_title_changed(move |_wv, title| {
            eprintln!("[core] browser_title tab={title_tab} title={title:?}");
            let _ = title_app.emit(
                "browser-title",
                BrowserEvent {
                    tab_id: title_tab.clone(),
                    url: String::new(),
                    title,
                },
            );
        })
        .initialization_script_for_all_frames(shortcut_script())
        .initialization_script(passwords::capture_script())
        .on_navigation({
            let nav_app = app.clone();
            let nav_tab = tab_id.clone();
            move |url| {
                // Token-less find reports must be tried first: the token
                // check below would otherwise reject and swallow them.
                if handle_find_result_url(&nav_app, &nav_tab, url) {
                    return false;
                }
                if handle_shortcut_url(&nav_app, &nav_tab, url) {
                    return false;
                }
                if peek::intercept(&nav_app, &nav_tab, url) {
                    return false;
                }
                true
            }
        })
        .on_download({
            let dl_app = app.clone();
            let dl_tab = tab_id.clone();
            let last_destination: Arc<Mutex<Option<std::path::PathBuf>>> =
                Arc::new(Mutex::new(None));
            move |_wv, ev| {
                match ev {
                    tauri::webview::DownloadEvent::Requested { url, destination } => {
                        nav_watchdog::load_started(&dl_tab);
                        // The engine's suggested name (Content-Disposition
                        // aware) beats the URL's last path segment: a
                        // /get?file=report.pdf URL would otherwise be saved
                        // as an extensionless file called "get".
                        let name = destination
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| {
                                url.path_segments()
                                    .and_then(|mut s| s.next_back())
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or("download")
                                    .to_string()
                            });
                        let dir = dirs_next_download();
                        // Never overwrite: pick name, 1-name, 2-name, ...
                        let mut candidate = dir.join(&name);
                        let mut n = 1;
                        while candidate.exists() {
                            candidate = dir.join(format!("{n}-{name}"));
                            n += 1;
                        }
                        *destination = candidate.clone();
                        *last_destination.lock().unwrap() = Some(candidate.clone());
                        dl_app
                            .state::<AppState>()
                            .downloads
                            .lock()
                            .unwrap()
                            .insert(candidate.clone());
                        // The ledger's first half. Counts, not paths, in
                        // logs — a download is user data.
                        let file_name = candidate
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or(name);
                        let _ = dl_app.emit(
                            "download-started",
                            serde_json::json!({
                                "path": candidate.to_string_lossy(),
                                "name": file_name,
                            }),
                        );
                        eprintln!("[core] download started");
                    }
                    tauri::webview::DownloadEvent::Finished {
                        url: _,
                        path,
                        success,
                    } => {
                        use tauri_plugin_notification::NotificationExt;
                        let settled = path
                            .clone()
                            .or_else(|| last_destination.lock().unwrap().clone());
                        let body = settled
                            .as_ref()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default();
                        // The ledger's second half, matched by path.
                        if let Some(p) = &settled {
                            let _ = dl_app.emit(
                                "download-finished",
                                serde_json::json!({
                                    "path": p.to_string_lossy(),
                                    "success": success,
                                }),
                            );
                        }
                        eprintln!("[core] download finished success={success}");
                        let _ = dl_app
                            .notification()
                            .builder()
                            .title(if success {
                                "Download finished"
                            } else {
                                "Download failed"
                            })
                            .body(body)
                            .show();
                    }
                    _ => {}
                }
                true
            }
        })
        .on_page_load(move |wv, payload| {
            let url = payload.url().to_string();
            let phase = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
            };
            eprintln!("[core] browser_page_load tab={load_tab} {phase} url={url}");
            // A load began, so nothing is owed on this tab any more.
            nav_watchdog::load_started(&load_tab);
            #[cfg(target_os = "macos")]
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                nav_failures::report_blank_load(&load_app, &load_tab, &url);
            }
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                // A login lands right before a page load finishes (form POST,
                // redirect chain) — snapshot session cookies now rather than
                // betting the user keeps the app open until the next tick.
                cookies::request_snapshot();
                peek::load_finished(&load_tab);
                userscripts::on_page_finished(&load_app, &load_tab, &wv);
            }
            let _ = wv.window();
            let _ = load_app.emit(
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    "browser-loading"
                } else {
                    "browser-url"
                },
                BrowserEvent {
                    tab_id: load_tab.clone(),
                    url,
                    title: String::new(),
                },
            );
        });
    // A page asking for a new window gets a new browser TAB: Deny tells the
    // engine no native webview came to exist, and the app opens the URL
    // itself. This is the one route that sees both window.open and a plain
    // target=_blank click.
    let builder = builder.on_new_window({
        let nw_app = app.clone();
        move |url, _features| {
            open_tab_in_app(&nw_app, url.as_str());
            tauri::webview::NewWindowResponse::Deny
        }
    });
    let builder = if userscripts::any_enabled(&app) {
        userscripts::mark_bootstrapped(&label);
        builder.initialization_script(userscripts::bootstrap_script())
    } else {
        builder
    };
    let cover_on = config::load()
        .map(|loaded| loaded.config.network.cover_page_traffic)
        .unwrap_or(false);
    let proxy = ensure_page_proxy(&app, &state, cover_on, is_coverable_platform());
    if proxy.is_none() {
        clear_shared_page_proxy(&window);
    }
    let builder = match proxy {
        Some(proxy) => builder.proxy_url(
            proxy
                .parse()
                .expect("a loopback address this side just formatted"),
        ),
        None => builder,
    };
    window
        .add_child(builder, bounds.position(), bounds.size())
        .map_err(|e| format!("add_child failed: {e}"))?;

    eprintln!("[core] browser_create added child webview {label}");
    #[cfg(target_os = "macos")]
    if let Some(wv) = window.get_webview(&label) {
        let auth_app = app.clone();
        let nav_tab_id = tab_id.clone();
        let _ = wv.with_webview(move |pw| unsafe {
            let wk = pw.inner() as *mut objc2::runtime::AnyObject;
            let nav_delegate: *mut objc2::runtime::AnyObject =
                objc2::msg_send![&*wk, navigationDelegate];
            // Failure handlers go on before the auth module re-assigns the
            // delegate, so one re-assignment refreshes WebKit's cache of
            // which methods exist for both of them.
            nav_failures::register_tab(wk, &nav_tab_id);
            peek::install_frame_probe(nav_delegate);
            // The page's own way of talking back — installed before the
            // first script runs, since scripts post to it immediately.
            page_channel::install(&auth_app, wk);
            nav_failures::install(&auth_app, nav_delegate);
            basic_auth::install(&auth_app, wk, nav_delegate);
            let ui_delegate: *mut objc2::runtime::AnyObject = objc2::msg_send![&*wk, UIDelegate];
            dialogs::install(&auth_app, wk, ui_delegate);
        });
    }
    #[cfg(target_os = "windows")]
    if let Some(wv) = window.get_webview(&label) {
        let channel_app = app.clone();
        let channel_tab = tab_id.clone();
        let _ = wv.with_webview(move |pw| {
            let controller = pw.controller();
            page_channel_win::install(&channel_app, &controller, channel_tab.clone());
            // Why a page did not open, and the way past a certificate.
            nav_windows::install(&channel_app, &controller, channel_tab.clone());
            // A site behind Basic auth could not be opened here at all
            // before this: the engine ships no dialog of its own.
            basic_auth_win::install(&channel_app, &controller, channel_tab.clone());
            // The page's own questions, in the app's appearance, and with
            // the answer remembered per site.
            dialogs_win::install(&channel_app, &controller, channel_tab);
        });
    }
    state.browsers.lock().unwrap().insert(tab_id.clone(), label);
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_return)]
pub(crate) fn window_buttons(app: AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window is gone".to_string())?;
        // The pointer is fetched inside the closure: a raw pointer cannot
        // cross threads, and this is the thread that may touch it anyway.
        let for_main = window.clone();
        window
            .run_on_main_thread(move || unsafe {
                let Ok(ptr) = for_main.ns_window() else {
                    return;
                };
                let ns_window = ptr as *mut objc2::runtime::AnyObject;
                // NSWindowButton: 0 close, 1 miniaturize, 2 zoom.
                for which in 0..3isize {
                    let button: *mut objc2::runtime::AnyObject =
                        objc2::msg_send![&*ns_window, standardWindowButton: which];
                    if !button.is_null() {
                        let () = objc2::msg_send![&*button, setHidden: !visible];
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
        Ok(())
    }
}

#[tauri::command]
#[allow(clippy::needless_return)]
pub(crate) fn browser_plane_raise(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
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
        ui_plane::set_plane_on_top(&wv, true)?;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, tab_id);
        Ok(false)
    }
}

#[tauri::command]
#[allow(clippy::needless_return)]
pub(crate) fn ui_plane_set(app: AppHandle, on_top: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window is gone".to_string())?;
        let wv = window
            .get_webview("main")
            .ok_or_else(|| "the app webview is gone".to_string())?;
        ui_plane::set_plane_on_top(&wv, on_top)?;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, on_top);
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn browser_release_hover(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let labels: Vec<String> = state.browsers.lock().unwrap().values().cloned().collect();
    for label in labels {
        if let Some(wv) = window.get_webview(&label) {
            let _ = wv.eval(
                r#"(function(){
                  try {
                    // Two sources, because neither alone is enough. The engine's
                    // :hover chain is the truth while the page still has the
                    // pointer; the moment the interface layer takes it, that
                    // chain is empty and the only record of where the pointer
                    // was is the one the injected script keeps.
                    var seen = [];
                    var add = function(el){
                      while (el && seen.indexOf(el) < 0) { seen.push(el); el = el.parentElement; }
                    };
                    var hov = document.querySelectorAll(':hover');
                    for (var i = 0; i < hov.length; i++) add(hov[i]);
                    var p = window.__tabversePointer;
                    if (p) add(document.elementFromPoint(p.x, p.y));
                    for (var j = 0; j < seen.length; j++) {
                      seen[j].dispatchEvent(new MouseEvent('mouseleave',
                        {bubbles:false, cancelable:true, clientX:-1, clientY:-1}));
                      seen[j].dispatchEvent(new MouseEvent('mouseout',
                        {bubbles:true, cancelable:true, clientX:-1, clientY:-1}));
                    }
                  } catch (e) {}
                })()"#,
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn browser_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<String, String> {
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
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = wv;
        Err("page snapshots are not supported on this platform".into())
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        #[cfg(target_os = "macos")]
        snapshot::take(&wv, tx);
        #[cfg(target_os = "windows")]
        snapshot_win::take(&wv, tx);
        let _ = wv;
        // Off the async thread, so waiting never blocks the main thread the
        // completion handler needs. The interface gives up at ~300ms; this
        // longer stop only exists so an engine that never answers cannot
        // leak a blocked task.
        let got = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_millis(1500))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "the engine did not answer".to_string())?;
        // Outcome log carries the tab id only — never the page's address.
        match &got {
            Ok(data) => eprintln!("[snapshot] tab={tab_id} ok bytes={}", data.len()),
            Err(e) => eprintln!("[snapshot] tab={tab_id} failed: {e}"),
        }
        got
    }
}

#[tauri::command]
pub(crate) fn browser_dialog_answer(
    app: AppHandle,
    dialog_id: u64,
    ok: bool,
    text: Option<String>,
    remember: bool,
    kind: Option<String>,
) -> Result<(), String> {
    if kind.as_deref() == Some("notifications") {
        return page_notify::answer(&app, dialog_id, ok, remember);
    }
    #[cfg(target_os = "macos")]
    return dialogs::answer(app, dialog_id, ok, text, remember, kind);
    #[cfg(target_os = "windows")]
    return dialogs_win::answer(app, dialog_id, ok, text, remember, kind);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, dialog_id, ok, text, remember, kind);
        Err("not implemented on this platform".into())
    }
}

#[tauri::command]
pub(crate) fn browser_ask_unload(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
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
    let script = format!(
        r#"(function() {{
  var dirty = false;
  try {{
    var e = new Event("beforeunload", {{ cancelable: true }});
    // Three idioms in the wild, and a page may use any of them:
    // preventDefault, assigning returnValue, or returning a string from
    // the onbeforeunload property. The last one is not delivered by a
    // synthetic dispatch, so it is called directly.
    window.dispatchEvent(e);
    if (e.defaultPrevented) dirty = true;
    if (typeof e.returnValue === "string" && e.returnValue !== "") dirty = true;
    if (e.returnValue === false) dirty = true;
    if (typeof window.onbeforeunload === "function") {{
      var r = window.onbeforeunload(e);
      if (r !== undefined && r !== null) dirty = true;
    }}
  }} catch (_) {{}}
  var msg = "unload-check?t={token}&d=" + (dirty ? "1" : "0");
  try {{
    window.webkit.messageHandlers.{handler}.postMessage(msg);
    return;
  }} catch (_) {{}}
  try {{ window.chrome.webview.postMessage(msg); }} catch (_) {{}}
}})();"#,
        handler = PAGE_CHANNEL,
        token = cmd_token(),
    );
    wv.eval(&script).map_err(|e| e.to_string())
}

/// Platform-independent command over the macOS-only implementation, so the
/// command table itself never varies by platform.
#[tauri::command]
pub(crate) fn browser_auth_answer(
    app: AppHandle,
    challenge_id: u64,
    username: Option<String>,
    password: Option<String>,
    save: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return basic_auth::answer(app, challenge_id, username, password, save);
    #[cfg(target_os = "windows")]
    return basic_auth_win::answer(app, challenge_id, username, password, save);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, challenge_id, username, password, save);
        Err("not implemented on this platform".into())
    }
}

#[tauri::command]
pub(crate) fn browser_set_bounds(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    bounds: Bounds,
    visible: bool,
) -> Result<(), String> {
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
    // Hiding by moving off-screen: child webviews have no visibility toggle,
    // and destroying one on every tab switch would lose page state.
    if visible {
        wv.set_position(bounds.position())
            .map_err(|e| e.to_string())?;
        wv.set_size(bounds.size()).map_err(|e| e.to_string())?;
    } else {
        wv.set_position(tauri::PhysicalPosition::new(-100_000, -100_000))
            .map_err(|e| e.to_string())?;
        // Moving a webview off-screen does not make it stop being the view the
        // keyboard talks to. Without this, leaving a browser tab would leave
        // the keystrokes behind with the parked page and the terminal you
        // switched to would silently receive nothing.
        //
        // Only reclaim focus when the hidden page owns it. During an unsplit,
        // another pane can remain visible; taking focus unconditionally would
        // remove it from that surviving pane and reset page focus on return.
        #[cfg(target_os = "macos")]
        let take_it = ui_plane::holds_keyboard(&wv).unwrap_or(true);
        #[cfg(not(target_os = "macos"))]
        let take_it = true;
        if take_it {
            if let Some(main) = window.get_webview("main") {
                let _ = main.set_focus();
            }
        }
    }
    Ok(())
}

/// Which child webview belongs to a tab. Shared with the navigation
/// watchdog, which has to ask the same question to try again.
pub(crate) fn browser_label(app: &AppHandle, tab_id: &str) -> Option<String> {
    app.try_state::<AppState>()?
        .browsers
        .lock()
        .ok()?
        .get(tab_id)
        .cloned()
}

#[tauri::command]
pub(crate) fn browser_navigate(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    action: String,
    url: Option<String>,
) -> Result<(), String> {
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
    peek::command_stamp(&tab_id);
    match action.as_str() {
        "go" => {
            let u = url.ok_or_else(|| "no url".to_string())?;
            let parsed: tauri::Url = u.parse().map_err(|e| format!("bad url: {e}"))?;
            #[cfg(target_os = "macos")]
            nav_failures::remember_request(&tab_id, &u);
            eprintln!("[core] browser_navigate go tab={tab_id} label={label} url={u}");
            let outcome = wv.navigate(parsed);
            eprintln!(
                "[core] browser_navigate returned ok={} tab={tab_id}",
                outcome.is_ok()
            );
            if outcome.is_ok() {
                nav_watchdog::watch(&app, &tab_id, &u);
            }
            outcome.map_err(|e| e.to_string())
        }
        "back" => wv.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => wv.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => wv.eval("location.reload()").map_err(|e| e.to_string()),
        other => Err(format!("unknown action {other}")),
    }
}

/// Read the child webview's current title and url back into the app.
#[tauri::command]
pub(crate) fn browser_probe(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
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
    // Deliberately does NOT read the webview's URL: WKWebView reports none
    // until a navigation commits (unreachable host, page still loading, blank
    // webview), and wry unwraps that internally — which ABORTS the whole
    // process, not just this call. That is a crash-on-launch for anyone whose
    // restored browser tab points somewhere unreachable. Page-load events
    // already carry the url, so this only needs to prove the webview is there.
    let _ = window
        .get_webview(&label)
        .ok_or_else(|| "webview is gone".to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn browser_zoom(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    scale: f64,
) -> Result<(), String> {
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
    wv.set_zoom(scale).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn browser_set_muted(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    muted: bool,
) -> Result<(), String> {
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
    let js = format!(
        "window.dispatchEvent(new CustomEvent('__tabverse_setmute',{{detail:{{on:{}}}}}))",
        if muted { "true" } else { "false" }
    );
    wv.eval(&js).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_return)]
pub(crate) fn browser_print(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
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

    #[cfg(target_os = "macos")]
    {
        wv.with_webview(|pw| unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            let wk = pw.inner() as *mut AnyObject;
            if wk.is_null() {
                eprintln!("[print] no webview object");
                return;
            }
            // The shared NSPrintInfo is the panel's default paper and
            // orientation; the user changes them in the panel itself.
            let info_cls =
                objc2::runtime::AnyClass::get(&std::ffi::CString::new("NSPrintInfo").unwrap());
            let Some(info_cls) = info_cls else {
                eprintln!("[print] NSPrintInfo is missing from this system");
                return;
            };
            let print_info: *mut AnyObject = msg_send![info_cls, sharedPrintInfo];
            let op: *mut AnyObject = msg_send![&*wk, printOperationWithPrintInfo: print_info];
            if op.is_null() {
                eprintln!("[print] the engine returned no print operation");
                return;
            }
            let () = msg_send![&*op, setShowsPrintPanel: true];
            let window: *mut AnyObject = msg_send![&*wk, window];
            if !window.is_null() {
                // delegate nil + a NULL callback: with no delegate the
                // did-run selector is never sent, so the selector value only
                // has to type-check, and the sheet drives itself to done.
                let delegate: *mut AnyObject = std::ptr::null_mut();
                let context: *mut std::ffi::c_void = std::ptr::null_mut();
                let sel = objc2::sel!(printOperationDidRun:success:contextInfo:);
                let () = msg_send![
                    &*op,
                    runOperationModalForWindow: window,
                    delegate: delegate,
                    didRunSelector: sel,
                    contextInfo: context,
                ];
                eprintln!("[print] print sheet presented on the window");
            } else {
                // No host window (should not happen for a live tab): fall back
                // to the app-modal run rather than silently printing nothing.
                let _ran: bool = msg_send![&*op, runOperation];
                eprintln!("[print] no host window; ran app-modal print operation");
            }
        })
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        wv.with_webview(|pw| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER,
            };
            use windows_core::Interface;
            let controller = pw.controller();
            unsafe {
                let core = match controller.CoreWebView2() {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[print] no CoreWebView2: {e}");
                        return;
                    }
                };
                match core.cast::<ICoreWebView2_16>() {
                    Ok(v16) => {
                        if let Err(e) = v16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER) {
                            eprintln!("[print] ShowPrintUI failed: {e}");
                        } else {
                            eprintln!("[print] print UI shown");
                        }
                    }
                    Err(e) => eprintln!("[print] this WebView2 runtime has no ShowPrintUI: {e}"),
                }
            }
        })
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = wv;
        Err("printing is not available on this platform".into())
    }
}

const FIND_SCRIPT: &str = r#"(function () {
  var q = __TABVERSE_QUERY__, back = __TABVERSE_BACK__;
  // State carried across evals of this script: the query the matches belong
  // to, one array of match Ranges per frame searched (frames[0] is the top
  // document, then depth-first document order), the documents those frames
  // live in (for clearing per-document highlights), and the current
  // position in the flattened order of all frames' matches.
  var st = window.__tabverseFind;
  if (!st || !st.frames) { st = window.__tabverseFind = { query: "", frames: [], docs: [], index: -1 }; }
  // Reports ride a token-LESS tabverse-cmd: navigation on purpose: this code
  // is readable by the page, so a token here would be a token leaked. A page
  // forging the report can only lie about its own match count. The counts
  // arrive per frame (one n= each), so the sum the core displays is the
  // main page plus same-origin embeds — never a cross-origin frame, which
  // this script cannot read and so cannot count.
  function report(counts, i) {
    var url = "tabverse-cmd:find-result?";
    for (var k = 0; k < counts.length; k++) url += "n=" + counts[k] + "&";
    url += "f=" + counts.length + "&i=" + i;
    try { window.location.href = url; } catch (e) {}
  }
  function docWindow(doc) {
    try { return doc.defaultView; } catch (e) { return null; }
  }
  function ensureStyle(doc) {
    if (doc.getElementById("__tabverse-find-style")) return;
    var s = doc.createElement("style");
    s.id = "__tabverse-find-style";
    s.textContent =
      "::highlight(tabverse-find){background-color:__TABVERSE_FIND_BG__;color:__TABVERSE_FIND_FG__;}" +
      "::highlight(tabverse-find-current){background-color:__TABVERSE_FIND_CUR_BG__;color:__TABVERSE_FIND_CUR_FG__;}";
    (doc.head || doc.documentElement).appendChild(s);
  }
  // Highlights are registered per document (CSS.highlights belongs to each
  // document's own window), so a frame whose count dropped to zero on a new
  // query must have its old registration deleted, not just skipped.
  function clearHighlights() {
    for (var d = 0; d < st.docs.length; d++) {
      var w = docWindow(st.docs[d]);
      if (w && w.CSS && w.CSS.highlights) {
        w.CSS.highlights.delete("tabverse-find");
        w.CSS.highlights.delete("tabverse-find-current");
      }
    }
  }
  // Matches within one document, unchanged from the top-frame-only days:
  // text nodes walked, the script/style family rejected, every hit a Range
  // so it can be highlighted, and only kept when it renders boxes.
  function collectDoc(doc) {
    var out = [];
    var root = doc.body;
    if (!root) return out;
    var needle = q.toLowerCase();
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentElement;
        return !p || SKIP[p.tagName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var hay = (node.nodeValue || "").toLowerCase();
      var at = hay.indexOf(needle);
      while (at !== -1) {
        var r = doc.createRange();
        r.setStart(node, at);
        r.setEnd(node, at + needle.length);
        // Text inside a hidden container renders no boxes. Checking matches
        // only is far cheaper than computing style for every node walked.
        if (r.getClientRects().length) out.push(r);
        at = hay.indexOf(needle, at + needle.length);
      }
    }
    return out;
  }
  function rebuild() {
    clearHighlights();
    st.query = q; st.frames = []; st.docs = []; st.index = -1;
    if (!q) return;
    // Depth-first from the top document. A same-origin iframe hands over its
    // contentDocument and is searched like any other part of the page; a
    // cross-origin one answers null (or throws), and the honest move is to
    // leave it out of both the count and the walk — the UI note on the
    // counter says exactly that scope.
    (function walk(doc) {
      st.docs.push(doc);
      st.frames.push(collectDoc(doc));
      var kids = doc.querySelectorAll("iframe");
      for (var i = 0; i < kids.length; i++) {
        var cd = null;
        try { cd = kids[i].contentDocument; } catch (e) { cd = null; }
        if (cd) walk(cd);
      }
    })(document);
  }
  if (q !== st.query) rebuild();
  var counts = [], flat = [];
  for (var k = 0; k < st.frames.length; k++) {
    counts.push(st.frames[k].length);
    for (var m = 0; m < st.frames[k].length; m++) flat.push(st.frames[k][m]);
  }
  var n = flat.length;
  var hl = window.CSS && CSS.highlights && typeof Highlight === "function";
  if (!n) {
    if (hl) {
      CSS.highlights.delete("tabverse-find");
      CSS.highlights.delete("tabverse-find-current");
    }
    report(counts.length ? counts : [0], 0);
    return;
  }
  // Fresh query lands on the first match; a repeat advances and wraps. The
  // index runs over the flattened order — top document first — so stepping
  // crosses frame boundaries as if the page were one document.
  st.index = st.index < 0 ? 0 : (back ? st.index + n - 1 : st.index + 1) % n;
  var cur = flat[st.index];
  if (hl) {
    // Highlight objects are set-likes; add() avoids spreading thousands of
    // ranges through one call's argument list. Each frame registers in its
    // own document, and only the frame owning the current match carries the
    // current-highlight; the others have any stale one deleted.
    var base = 0;
    for (var d = 0; d < st.frames.length; d++) {
      var w = docWindow(st.docs[d]);
      var fr = st.frames[d];
      if (!w || !w.CSS || !w.CSS.highlights || typeof w.Highlight !== "function") { base += fr.length; continue; }
      if (!fr.length) {
        // This frame has nothing to show: whatever an earlier query left
        // registered here is deleted, not replaced with an empty highlight.
        w.CSS.highlights.delete("tabverse-find");
        w.CSS.highlights.delete("tabverse-find-current");
        continue;
      }
      var all = new w.Highlight();
      for (var a = 0; a < fr.length; a++) all.add(fr[a]);
      w.CSS.highlights.set("tabverse-find", all);
      if (st.index >= base && st.index < base + st.frames[d].length) {
        var one = new w.Highlight();
        one.add(cur);
        w.CSS.highlights.set("tabverse-find-current", one);
      } else {
        w.CSS.highlights.delete("tabverse-find-current");
      }
      ensureStyle(st.docs[d]);
      base += fr.length;
    }
  } else {
    // No Custom Highlight API: select the current match so it is at least
    // visible — through the selection of the document that owns the range,
    // since a selection will not take a range from another document. The
    // count above works either way.
    var ow = docWindow(cur.startContainer.ownerDocument);
    var sel = ow && ow.getSelection ? ow.getSelection() : window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(cur); }
  }
  var el = cur.startContainer.parentElement;
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
  report(counts, st.index + 1);
})();"#;

pub(crate) fn find_script_for(query: &str, backwards: bool) -> String {
    // JSON-encode so arbitrary text cannot escape the JS string literal.
    let q = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".to_string());
    FIND_SCRIPT
        .replace(
            "__TABVERSE_BACK__",
            if backwards { "true" } else { "false" },
        )
        .replace("__TABVERSE_FIND_BG__", theme_gen::FIND_HL_BG)
        .replace("__TABVERSE_FIND_FG__", theme_gen::FIND_HL_FG)
        .replace("__TABVERSE_FIND_CUR_BG__", theme_gen::FIND_HL_CUR_BG)
        .replace("__TABVERSE_FIND_CUR_FG__", theme_gen::FIND_HL_CUR_FG)
        .replace("__TABVERSE_QUERY__", &q)
}

#[tauri::command]
pub(crate) fn browser_find(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    query: String,
    backwards: bool,
) -> Result<(), String> {
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
    let js = find_script_for(&query, backwards);
    wv.eval(js).map_err(|e| e.to_string())
}

/// Closing the find bar leaves no stale highlight or selection behind on the
/// page. The injected <style> stays — inert without registered highlights —
/// and the finder state resets so the next query starts fresh.
#[tauri::command]
pub(crate) fn browser_clear_find(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
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
    wv.eval(
        r#"(function () {
  var st = window.__tabverseFind;
  if (st) { st.query = ""; st.ranges = []; st.index = -1; }
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete("tabverse-find");
    CSS.highlights.delete("tabverse-find-current");
  }
  var sel = window.getSelection();
  if (sel) sel.removeAllRanges();
})();"#,
    )
    .map_err(|e| e.to_string())
}

/// Hand the keyboard to the UI webview.
///
/// Needed whenever the UI opens an input while a page holds the keyboard —
/// the find bar summoned by ⌘F pressed *inside* the page, for instance.
#[tauri::command]
pub(crate) fn ui_focus(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is gone".to_string())?;
    let wv = window
        .get_webview("main")
        .ok_or_else(|| "ui webview is gone".to_string())?;
    wv.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn browser_close(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let label = state.browsers.lock().unwrap().remove(&tab_id);
    #[cfg(target_os = "macos")]
    nav_failures::forget_tab(&tab_id);
    peek::forget_tab(&tab_id);
    // Injection nonces and the bootstrap mark die with the webview.
    userscripts::forget_tab(&tab_id);
    page_notify::forget_tab(&tab_id);
    if let (Some(label), Some(window)) = (label, app.get_window("main")) {
        if let Some(wv) = window.get_webview(&label) {
            let _ = wv.close();
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn browser_set_peek_anchor(tab_id: String, host: Option<String>) -> Result<(), String> {
    peek::set_anchor(&tab_id, host);
    Ok(())
}
