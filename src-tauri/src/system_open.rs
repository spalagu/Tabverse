//! What happens when the system hands this app something to open.
//!
//! One entry point covers all of it. macOS delivers a double-clicked file and a
//! clicked link through the same callback, as `file://` and `https://` URLs
//! respectively, so the sorting has to happen here rather than in three
//! separate places.
//!
//! **Cold start is the part that breaks if you write the obvious thing.** The
//! callback fires before the app is ready and long before the interface has
//! attached a listener, so broadcasting straight away drops the very first
//! open -- the one that launched the app. Everything is therefore buffered
//! here as well as broadcast, and the interface asks for the buffer as soon as
//! it boots. Push and pull together; either alone loses a case.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, Url};

use crate::default_apps::{self, Kind};

/// Where one incoming object should land.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Opened {
    /// A web page. Goes to a browser tab.
    Browser { url: String },
    /// Something to run: a script, an executable, a remote-shell link. Goes to
    /// a terminal tab, which runs `command` in `cwd`.
    Terminal {
        command: String,
        cwd: Option<String>,
    },
    /// A document. Goes to a file tab rooted at its folder, with the file
    /// itself open -- not merely the folder, which is what "open this file"
    /// would degrade into otherwise.
    File { path: String },
    /// A folder. Goes to a file tab rooted there.
    Folder { path: String },
}

/// Opens that arrived before anything could receive them.
#[derive(Default)]
pub struct Pending {
    queue: Mutex<Vec<Opened>>,
    /// Set the first time the interface drains, and never cleared.
    ///
    /// This is what keeps the buffer from double-handling: before the flag is
    /// set nobody is listening, so an arrival has to be kept; after it, the
    /// broadcast reaches a live listener and keeping a copy would reopen the
    /// same tab the next time anything drains.
    live: AtomicBool,
}

/// Wrap a path for a shell that may see spaces, quotes or anything else a
/// filename is allowed to contain. Single quotes with the escape-by-closing
/// trick, because inside single quotes a shell interprets nothing at all.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Extensions the bundle declares as things this app *runs* rather than opens.
///
/// Read from the same declaration the terminal switch claims, so a script type
/// added to the config is routed to a terminal tab without a second edit here.
fn executable_extensions() -> Vec<String> {
    default_apps::DECLARED
        .iter()
        .filter(|a| a.executes)
        .flat_map(|a| a.ext.iter().map(|e| e.to_lowercase()))
        .collect()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    // No execute bit on Windows; the extension is the whole signal, and
    // `classify` has already consulted it.
    let _ = path;
    false
}

/// Sort one URL into the tab that should receive it.
///
/// Returns `None` for anything this app has no business opening, rather than
/// guessing: a scheme we never claimed arriving here means something else is
/// wrong, and opening a random tab would hide it.
pub fn classify(url: &Url) -> Option<Opened> {
    match url.scheme() {
        "http" | "https" => Some(Opened::Browser {
            url: url.to_string(),
        }),
        "ssh" | "telnet" => {
            let host = url.host_str()?;
            let mut command = url.scheme().to_string();
            let target = match url.username() {
                "" => host.to_string(),
                user => format!("{user}@{host}"),
            };
            // ssh spells the port -p, telnet takes it as a second word. Getting
            // this wrong produces a command that looks right and fails.
            match (url.scheme(), url.port()) {
                ("ssh", Some(p)) => {
                    command.push_str(&format!(" -p {p} {}", shell_quote(&target)));
                }
                ("telnet", Some(p)) => {
                    command.push_str(&format!(" {} {p}", shell_quote(&target)));
                }
                _ => command.push_str(&format!(" {}", shell_quote(&target))),
            }
            Some(Opened::Terminal { command, cwd: None })
        }
        "file" => {
            let path = url.to_file_path().ok()?;
            if path.is_dir() {
                let dir = path.to_string_lossy().into_owned();
                // The one object both switches could claim. The rule is fixed
                // rather than clever: with the terminal switch on, a folder is
                // somewhere to work; otherwise it is somewhere to look.
                return if default_apps::status(Kind::Terminal).enabled {
                    Some(Opened::Terminal {
                        command: String::new(),
                        cwd: Some(dir),
                    })
                } else {
                    Some(Opened::Folder { path: dir })
                };
            }
            if !path.exists() {
                return None;
            }
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let runnable = executable_extensions().contains(&ext) || is_executable(&path);
            if runnable {
                let quoted = shell_quote(&path.to_string_lossy());
                // An executable runs; a script without the execute bit has to
                // be handed to a shell, or the terminal reports "permission
                // denied" for a file the user just double-clicked.
                let command = if is_executable(&path) {
                    quoted
                } else {
                    format!("sh {quoted}")
                };
                return Some(Opened::Terminal {
                    command,
                    cwd: path.parent().map(|p| p.to_string_lossy().into_owned()),
                });
            }
            Some(Opened::File {
                path: path.to_string_lossy().into_owned(),
            })
        }
        _ => None,
    }
}

/// Take delivery of everything the system handed over in one callback.
pub fn receive<R: Runtime>(app: &AppHandle<R>, urls: &[Url]) {
    let sorted: Vec<Opened> = urls.iter().filter_map(classify).collect();
    if sorted.is_empty() {
        return;
    }
    // Kept only while nobody can hear the broadcast. Keeping it afterwards as
    // well is the bug this flag exists to prevent: the item would be handled
    // now and handed out again by the next drain.
    if let Some(pending) = app.try_state::<Pending>() {
        if !pending.live.load(Ordering::Acquire) {
            if let Ok(mut q) = pending.queue.lock() {
                q.extend(sorted.iter().cloned());
            }
        }
    }
    let _ = app.emit("system-open", &sorted);
}

/// Everything that arrived before the interface could listen, handed over once.
///
/// Draining is the point: a second call returns nothing, so a reload cannot
/// reopen tabs the user already has.
#[tauri::command]
pub fn system_open_drain(app: AppHandle) -> Vec<Opened> {
    let Some(pending) = app.try_state::<Pending>() else {
        return Vec::new();
    };
    let taken = pending
        .queue
        .lock()
        .ok()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default();
    // Only after taking what is there: setting it earlier would let an arrival
    // in between slip past both the buffer and the not-yet-attached listener.
    pending.live.store(true, Ordering::Release);
    taken
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_with_quotes_survives_the_shell() {
        // The name below is legal on every platform this runs on, and an
        // unescaped version of it would end the quoted string early and run
        // whatever follows.
        let quoted = shell_quote("/tmp/it's a script.sh");
        assert_eq!(quoted, r"'/tmp/it'\''s a script.sh'");
        // Every apostrophe in the result is either the pair that opens and
        // closes the whole word or part of the escape; none of them leaves the
        // shell reading the rest of the name as code.
        assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
    }

    #[test]
    fn a_plain_path_is_still_quoted() {
        assert_eq!(shell_quote("/tmp/x.sh"), "'/tmp/x.sh'");
    }
}
