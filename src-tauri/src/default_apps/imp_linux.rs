//! Linux: the association database is a text file the user owns, so all three
//! switches really do work, and none of them needs elevated rights.
//!
//! Types are named by MIME type here, and a URL scheme is spelled as the
//! pseudo-type `x-scheme-handler/<scheme>` -- the same mechanism, so the shared
//! code above needs no special case for schemes on this platform.
//!
//! Reads go through `xdg-mime query default` because the answer depends on a
//! whole search path of files (per-desktop overrides, the user's own list,
//! system-wide lists, distribution defaults) and only the tool walks all of it.
//! Writes go straight into the user's own `mimeapps.list`, because the tool can
//! only add a default and this module also has to *remove* one -- restoring a
//! type that nobody owned before is a real case, and `xdg-mime` cannot express
//! it.
//!
//! The terminal switch needs one thing the others do not. "Default terminal"
//! is not a MIME type on Linux; it is four unrelated mechanisms, of which only
//! two can be written by a running application:
//!
//! * `xdg-terminals.list` -- the freedesktop proposal. Worth far more than its
//!   draft status suggests: GLib's list of known terminals puts
//!   `xdg-terminal-exec` first, so every "Open in Terminal" that goes through
//!   GIO -- GNOME's, the file manager's -- consults it before anything else.
//! * KDE's `kdeglobals`, which needs both of its keys written or the settings
//!   panel and the actual behaviour disagree.
//!
//! The other two are out of reach on purpose: Debian's alternatives system is
//! system-wide and needs root, so it belongs in a package's install script, not
//! here; and GNOME's old terminal setting has been deprecated and is ignored,
//! so writing it would do nothing at all.

use std::path::PathBuf;
use std::process::Command;

use super::{Kind, Target};

const MIME_SECTION: &str = "[Default Applications]";

fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from(".config"))
}

fn mimeapps_path() -> PathBuf {
    config_dir().join("mimeapps.list")
}

/// The desktop entry that names this app.
///
/// Found rather than assumed: the bundler derives the file name from the
/// product name, and a hard-coded guess that stopped matching would make every
/// write land on an entry the system does not have -- which fails silently,
/// because writing a default for an unknown desktop file is not an error.
fn desktop_id() -> String {
    let exe = std::env::current_exe().ok();
    let exe_name = exe
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(home).join("applications"));
    } else if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share/applications"));
    }
    dirs.push(PathBuf::from("/usr/share/applications"));
    dirs.push(PathBuf::from("/usr/local/share/applications"));

    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let Ok(body) = std::fs::read_to_string(&path) else {
                continue;
            };
            let names_us = body
                .lines()
                .any(|l| l.starts_with("Exec=") && !exe_name.is_empty() && l.contains(&exe_name));
            if names_us {
                if let Some(name) = path.file_name() {
                    return name.to_string_lossy().into_owned();
                }
            }
        }
    }
    // Last resort. Wrong here is visible immediately -- every switch reports
    // zero held -- rather than corrupting anything.
    "Tabverse.desktop".to_string()
}

pub fn self_id() -> String {
    desktop_id()
}

/// One MIME type per declared association. Extensions play no part on Linux:
/// the database keys on MIME types, and an association without one cannot be
/// claimed at all (it is also dropped from the generated desktop entry, so the
/// two absences agree).
pub fn file_targets(a: &super::DeclaredAssociation) -> Vec<String> {
    a.mime_type.map(str::to_string).into_iter().collect()
}

fn mime_for(target: &Target) -> String {
    match target {
        Target::Scheme(s) => format!("x-scheme-handler/{s}"),
        Target::FileType { id, .. } => id.clone(),
    }
}

pub fn current_handler(target: &Target) -> Option<String> {
    let out = Command::new("xdg-mime")
        .args(["query", "default", &mime_for(target)])
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // The tool prints nothing and still succeeds when no one owns the type.
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Rewrite one entry in the user's own association list.
///
/// `handler` of `None` deletes the line, which is what restoring an
/// unclaimed type means. Every other line in the file is copied through
/// untouched: this file belongs to the user and holds their choices for
/// applications that have nothing to do with Tabverse.
fn write_default(mime: &str, handler: Option<&str>) -> Result<(), String> {
    let path = mimeapps_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut wrote = false;
    let mut seen_section = false;

    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            // Leaving the section without having written the entry: put it at
            // the end of the section rather than dropping it.
            if in_section && !wrote {
                if let Some(h) = handler {
                    out.push(format!("{mime}={h}"));
                }
                wrote = true;
            }
            in_section = trimmed == MIME_SECTION;
            seen_section |= in_section;
            out.push(line.to_string());
            continue;
        }
        if in_section && trimmed.starts_with(mime) {
            if let Some(rest) = trimmed.strip_prefix(mime) {
                if rest.starts_with('=') {
                    if let Some(h) = handler {
                        out.push(format!("{mime}={h}"));
                    }
                    wrote = true;
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }

    if !wrote {
        if !seen_section {
            out.push(MIME_SECTION.to_string());
        }
        if let Some(h) = handler {
            out.push(format!("{mime}={h}"));
        }
    }

    let mut body = out.join("\n");
    body.push('\n');
    let tmp = path.with_extension("list.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn set_handler(target: &Target, handler: super::Handler<'_>) -> Result<(), String> {
    let me;
    let desktop = match handler {
        super::Handler::Other(h) => Some(h),
        super::Handler::This => {
            me = self_id();
            Some(me.as_str())
        }
        // The line goes away entirely. Setting it to something plausible-looking
        // would invent a choice the user never made.
        super::Handler::Nobody => None,
    };
    write_default(&mime_for(target), desktop)
}

/// Register as a terminal emulator, or stop being one.
///
/// Only the mechanisms a running application may write; see the module doc for
/// the two that are deliberately out of reach.
fn set_terminal_registration(enabled: bool) {
    let id = desktop_id();
    let list = config_dir().join("xdg-terminals.list");
    let existing = std::fs::read_to_string(&list).unwrap_or_default();
    let mut lines: Vec<String> = existing
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != id)
        .map(str::to_string)
        .collect();
    if enabled {
        // First line wins, so preference is expressed by position.
        lines.insert(0, id.clone());
    }
    let mut body = lines.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    let _ = std::fs::write(&list, body);

    // KDE reads a command from one key and shows a desktop entry from another.
    // Writing only one leaves its settings panel disagreeing with what
    // actually opens.
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    for (key, value) in [
        (
            "TerminalApplication",
            if enabled { exe.as_str() } else { "" },
        ),
        ("TerminalService", if enabled { id.as_str() } else { "" }),
    ] {
        let mut cmd = Command::new("kwriteconfig6");
        cmd.args(["--file", "kdeglobals", "--group", "General", "--key", key]);
        if value.is_empty() {
            cmd.arg("--delete");
        } else {
            cmd.arg(value);
        }
        if cmd.status().is_err() {
            // Plasma 5 spells it differently, and neither being present just
            // means this is not a KDE session.
            let mut older = Command::new("kwriteconfig5");
            older.args(["--file", "kdeglobals", "--group", "General", "--key", key]);
            if value.is_empty() {
                older.arg("--delete");
            } else {
                older.arg(value);
            }
            let _ = older.status();
        }
    }
}

pub fn prepare(kind: Kind, enabled: bool, _targets: &[Target]) {
    if kind == Kind::Terminal {
        set_terminal_registration(enabled);
    }
    // Desktop environments cache the association database; without this the
    // change is on disk but the running session keeps the old answer. Pointed
    // at the data directory, which is a different root from the config one --
    // reaching it by climbing out of the config path happens to work with the
    // defaults and breaks the moment either is set explicitly.
    let apps = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .map(|d| d.join("applications"));
    if let Some(apps) = apps {
        let _ = Command::new("update-desktop-database").arg(apps).status();
    }
}

/// The association list is consulted on every lookup; there is no resolver
/// cache to throw away.
pub fn refresh() {}

pub fn settable(_kind: Kind) -> bool {
    true
}

pub fn display_name(desktop_id: &str) -> String {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share/applications"));
    }
    dirs.push(PathBuf::from("/usr/share/applications"));
    dirs.push(PathBuf::from("/usr/local/share/applications"));
    for dir in dirs {
        let path = dir.join(desktop_id);
        let Ok(body) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in body.lines() {
            if let Some(name) = line.strip_prefix("Name=") {
                return name.trim().to_string();
            }
        }
    }
    // Still useful: the file name names the application.
    desktop_id.trim_end_matches(".desktop").to_string()
}

pub fn note(kind: Kind) -> Option<String> {
    match kind {
        Kind::Terminal => Some(
            "Linux has no single default-terminal setting. This registers \
             Tabverse where a running application is allowed to — the \
             freedesktop terminal list and KDE's settings. Debian's \
             system-wide alternative needs root and belongs to the package."
                .into(),
        ),
        _ => None,
    }
}
