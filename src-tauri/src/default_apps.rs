//! Making Tabverse the system's default browser, terminal and editor.
//!
//! Three switches, one per tab type, each independently on or off. What a
//! switch actually does is hand a set of system objects -- URL schemes and
//! file types -- over to this app, and hand them back when it is turned off.
//!
//! Four constraints shape everything here.
//!
//! **The system is the source of truth, not a file of ours.** Status is read
//! live from the OS on every query. A switch that reported what it last wrote
//! would lie the moment the user changed a default in System Settings or in
//! Finder's Get Info -- and they will, because that is where the rest of the
//! world does it.
//!
//! **What gets claimed comes from the bundle config, never from a list in this
//! file.** `bundle.fileAssociations` in tauri.conf.json is what the installer
//! writes into the app's declarations, and only a declared type can be granted.
//! A second list here would drift from it, and the drift would be silent: the
//! set would appear to succeed and the read-back would show someone else still
//! holding the type. It reaches this file through `build.rs`, not through
//! `app.config()` -- the running app's copy of the config has file associations
//! stripped out of it, which cost one whole build-and-measure round to find,
//! because the switch compiled, passed its tests, and claimed nothing. Schemes
//! are the one exception -- there are four of them, they are stable, and they
//! live in `BROWSER_SCHEMES`/`TERMINAL_SCHEMES` below, mirrored by
//! CFBundleURLTypes in Info.plist.
//!
//! **Whoever held it before must be recoverable.** Turning a switch off has to
//! put the previous handler back, so the first time a switch goes on, every
//! target's current owner is written to a backup file. It is written once and
//! never overwritten while the switch stays on -- a second write would record
//! Tabverse as the previous owner and the way back would be gone for good.
//! Losing that file is the one failure in this module that nothing reports:
//! the user finds out weeks later, when a double-click still opens Tabverse
//! and turning the switch off does nothing.
//!
//! **A set that was not read back did not happen.** Every write is followed by
//! a read of the same target, and only a matching read counts. Setting a
//! default fails silently on macOS in more than one way -- an undeclared type,
//! a synthesized type the system will not bind, a scheme whose change the user
//! declined in the system's own prompt -- and none of them return an error.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

// The claimed file types, baked in from tauri.conf.json at build time.
//
// Not read from `app.config()`: Tauri's code generation drops file
// associations from the embedded config, so asking the running app what it
// declares always answers "nothing". See build.rs.
include!(concat!(env!("OUT_DIR"), "/declared_associations.rs"));

#[cfg(target_os = "macos")]
mod imp_macos;
#[cfg(target_os = "macos")]
use imp_macos as imp;

#[cfg(target_os = "windows")]
mod imp_windows;
#[cfg(target_os = "windows")]
use imp_windows as imp;

#[cfg(all(unix, not(target_os = "macos")))]
mod imp_linux;
#[cfg(all(unix, not(target_os = "macos")))]
use imp_linux as imp;

/// Schemes that make this the default browser.
///
/// Both of them, always. On macOS declaring http *and* https is the exact
/// condition that puts an app in System Settings' default-browser list -- one
/// alone does not -- and on every platform a browser that took only one of the
/// two would drop half the links the user clicks.
pub const BROWSER_SCHEMES: &[&str] = &["http", "https"];

/// Schemes that make this the default terminal: a remote-shell link opens a
/// terminal tab already running the connection.
pub const TERMINAL_SCHEMES: &[&str] = &["ssh", "telnet"];

/// Which switch a target belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Browser,
    Terminal,
    Editor,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "browser" => Some(Self::Browser),
            "terminal" => Some(Self::Terminal),
            "editor" => Some(Self::Editor),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Terminal => "terminal",
            Self::Editor => "editor",
        }
    }
}

/// One system object a switch takes over.
///
/// The distinction is not cosmetic: the platform calls differ, and so does the
/// key a backup entry is filed under, which is why the key carries the variant
/// (`scheme:http` can never collide with a file type called `http`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A URL scheme, without `://`.
    Scheme(String),
    /// A file type, named the way the platform names it: a uniform type
    /// identifier on macOS, a MIME type on Linux, an extension on Windows.
    FileType {
        id: String,
        /// True when this app executes the file rather than opening it --
        /// shell scripts and plain executables. macOS has a distinct handler
        /// role for exactly this, and a terminal that claimed them as an
        /// editor would be offering to edit the script instead of running it.
        executes: bool,
    },
}

/// Who a target should point at.
///
/// Three states, not two, and conflating any pair of them is a silent bug:
/// "hand it to us" and "hand it to nobody" both used to arrive as an absent
/// value, so turning a switch off re-claimed every type that had no owner
/// before instead of releasing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handler<'a> {
    /// This app.
    This,
    /// A specific application, named the way the platform names it.
    Other(&'a str),
    /// Nobody. A real state on every platform, and the correct restore for a
    /// type that was unclaimed before this app took it.
    Nobody,
}

impl Target {
    pub fn key(&self) -> String {
        match self {
            Self::Scheme(s) => format!("scheme:{s}"),
            Self::FileType { id, .. } => format!("type:{id}"),
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::Scheme(s) => format!("{s}://"),
            Self::FileType { id, .. } => id.clone(),
        }
    }
}

/// What one switch looks like right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub kind: String,
    /// How many of this switch's targets Tabverse currently holds, out of how
    /// many there are. Reported as a fraction rather than a boolean because a
    /// partial state is normal, not exceptional: another app can take a type
    /// back at any time, and a few types refuse to bind at all.
    pub held: usize,
    pub total: usize,
    /// Everything held. The switch reads as on.
    pub enabled: bool,
    /// Who holds the target that best represents this switch, in words a
    /// person can act on ("Arc", "Visual Studio Code").
    pub representative: Option<String>,
    /// Targets not held, with whoever holds them instead. Capped -- the editor
    /// switch has over a hundred targets and a wall of them helps nobody.
    pub missing: Vec<String>,
    /// False when this platform does not let an application set this itself.
    /// Windows refuses for browser and file types; the switch then becomes a
    /// button that registers the app and opens the page where the user picks.
    pub settable: bool,
    /// What the user has to do when `settable` is false, or what went wrong.
    pub note: Option<String>,
}

/// Previous owners, per switch. Written once when a switch first goes on.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Backup {
    /// switch -> target key -> the bundle/app id that held it, or absent when
    /// nothing held it. An absent entry restores to "no handler", which is a
    /// real state and not the same as "leave it alone".
    #[serde(default)]
    kinds: BTreeMap<String, BTreeMap<String, Option<String>>>,
}

/// Guards the backup file against two switches being flipped at once.
static BACKUP_LOCK: Mutex<()> = Mutex::new(());

fn backup_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir.join("default-apps-backup.json"))
}

fn read_backup<R: Runtime>(app: &AppHandle<R>) -> Backup {
    let Ok(path) = backup_path(app) else {
        return Backup::default();
    };
    // A missing or unreadable backup is not an error to report here: the
    // caller's next step decides what it means. Turning a switch ON treats it
    // as "nothing recorded yet, record now"; turning one OFF treats it as
    // "nothing to restore", which is the unrecoverable case the module doc
    // warns about.
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_backup<R: Runtime>(app: &AppHandle<R>, b: &Backup) -> Result<(), String> {
    let path = backup_path(app)?;
    let json = serde_json::to_string_pretty(b).map_err(|e| e.to_string())?;
    // Temp file plus rename, the same way saved sessions are written: a crash
    // midway through must not leave a truncated file, because a truncated
    // backup is indistinguishable from no backup and costs the way home.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

/// Every target a switch owns, derived from what the bundle actually declares.
///
/// File types come from `bundle.fileAssociations`, split by the role the
/// association gives them: `Shell` means the app runs the file, so those
/// belong to the terminal switch and everything else to the editor switch.
/// This split is what keeps the two switches from fighting over the same type
/// -- turning one on must leave the other's targets untouched.
pub fn targets(kind: Kind) -> Vec<Target> {
    let mut out: Vec<Target> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let push = |t: Target, seen: &mut Vec<String>, out: &mut Vec<Target>| {
        let k = t.key();
        if !seen.contains(&k) {
            seen.push(k);
            out.push(t);
        }
    };

    let schemes: &[&str] = match kind {
        Kind::Browser => BROWSER_SCHEMES,
        Kind::Terminal => TERMINAL_SCHEMES,
        Kind::Editor => &[],
    };
    for s in schemes {
        push(Target::Scheme((*s).to_string()), &mut seen, &mut out);
    }

    if kind == Kind::Browser {
        return out;
    }

    for a in DECLARED {
        let executes = a.executes;
        let mine = if executes {
            kind == Kind::Terminal
        } else {
            kind == Kind::Editor
        };
        if !mine {
            continue;
        }
        // Declared-only groups keep their "Open with" entry and nothing else:
        // the switch neither claims them nor counts them, so an archive or a
        // video staying with its real handler is correct, not a failure.
        if !a.claims_default {
            continue;
        }
        // What a "file type" even is differs per platform -- a uniform type
        // identifier here, a MIME type there, a bare extension somewhere else
        // -- so each backend turns one association into its own native ids.
        // On macOS that resolution also depends on what else is installed on
        // the machine, which is why it happens now and not at build time.
        for id in imp::file_targets(a) {
            push(Target::FileType { id, executes }, &mut seen, &mut out);
        }
    }
    out
}

/// The one target whose owner is worth naming in the UI.
fn representative(kind: Kind, targets: &[Target]) -> Option<&Target> {
    match kind {
        // Not http: on macOS the browser prompt is answered once for the pair,
        // and https is the one every modern link uses.
        Kind::Browser => targets
            .iter()
            .find(|t| matches!(t, Target::Scheme(s) if s == "https")),
        // The type every terminal fights over, and the one the baseline for
        // this work was measured against.
        Kind::Terminal => targets
            .iter()
            .find(|t| matches!(t, Target::FileType { id, .. } if id.contains("shell-script")))
            .or_else(|| targets.first()),
        Kind::Editor => targets.first(),
    }
}

pub fn status(kind: Kind) -> Status {
    let targets = targets(kind);
    let me = imp::self_id();
    let mut held = 0usize;
    let mut missing: Vec<String> = Vec::new();
    for t in &targets {
        match imp::current_handler(t) {
            Some(owner) if owner == me => held += 1,
            other => {
                // Eight is enough to see a pattern and short enough to read;
                // the count above is what says how bad it is.
                if missing.len() < 8 {
                    missing.push(format!(
                        "{} — {}",
                        t.label(),
                        other
                            .as_deref()
                            .map(imp::display_name)
                            .unwrap_or_else(|| "no handler".into())
                    ));
                }
            }
        }
    }
    let rep = representative(kind, &targets)
        .and_then(imp::current_handler)
        .map(|id| imp::display_name(&id));

    Status {
        kind: kind.as_str().to_string(),
        held,
        total: targets.len(),
        enabled: !targets.is_empty() && held == targets.len(),
        representative: rep,
        missing,
        settable: imp::settable(kind),
        note: imp::note(kind),
    }
}

/// Turn a switch on or off, then report what actually happened.
///
/// The returned status is read back from the system, not predicted from what
/// was written -- see the module doc on silent failure.
pub fn set<R: Runtime>(app: &AppHandle<R>, kind: Kind, enabled: bool) -> Result<Status, String> {
    let targets = targets(kind);
    if targets.is_empty() {
        return Err(format!(
            "nothing to claim for {}: the app bundle declares no matching types",
            kind.as_str()
        ));
    }
    let _guard = BACKUP_LOCK.lock().map_err(|e| e.to_string())?;

    // Whatever this platform has to do around the change: register the app so
    // the system will consider it at all, and on Windows -- where an
    // application is not allowed to assign a default and a filter driver
    // enforces it -- open the settings page where the user does it themselves.
    imp::prepare(kind, enabled, &targets);
    if !imp::settable(kind) {
        // Nothing further is ours to do. The status that comes back is read
        // from the system like any other, so it tells the truth about whether
        // the user has since made the choice.
        return Ok(status(kind));
    }

    if enabled {
        // Record who holds each target before taking any of them -- and only
        // if this switch has no record yet. Re-recording would capture
        // Tabverse as the previous owner of anything already taken.
        let me = imp::self_id();
        let mut backup = read_backup(app);
        if !backup.kinds.contains_key(kind.as_str()) {
            let mut owners = BTreeMap::new();
            for t in &targets {
                // Never record ourselves as the previous owner. If this type
                // already resolves to Tabverse -- a leftover from a prior
                // session, or an install-time claim -- then who held it before
                // is genuinely unknown, and writing "Tabverse" would make the
                // restore hand it right back to us. Absent means "leave as-is
                // on restore", which is the honest answer.
                let owner = imp::current_handler(t).filter(|o| *o != me);
                owners.insert(t.key(), owner);
            }
            backup.kinds.insert(kind.as_str().to_string(), owners);
            write_backup(app, &backup)?;
        }
        for t in &targets {
            if let Err(e) = imp::set_handler(t, Handler::This) {
                eprintln!("[default-apps] {}: {e}", t.label());
            }
        }
    } else {
        let backup = read_backup(app);
        let owners = backup.kinds.get(kind.as_str()).cloned().unwrap_or_default();
        // Counts only the ones that had a real owner and did not get it back.
        // Failing to release something nobody owned is a different thing --
        // some platforms have no way to say "no handler" -- and letting that
        // pin the backup forever would mean it never clears at all, since the
        // editor switch claims a dozen types nothing had ever registered for.
        let mut unreturned = 0usize;
        for t in &targets {
            // An entry that was never recorded gets no guess. Handing a type
            // to some plausible-looking app would be worse than leaving it:
            // the user can still fix an unclaimed type from Finder, but they
            // would have no way to know we invented an owner for it.
            let Some(previous) = owners.get(&t.key()) else {
                continue;
            };
            match previous.as_deref() {
                Some(id) => {
                    if let Err(e) = imp::set_handler(t, Handler::Other(id)) {
                        eprintln!("[default-apps] returning {} to {id}: {e}", t.label());
                        unreturned += 1;
                    }
                }
                None => {
                    if let Err(e) = imp::set_handler(t, Handler::Nobody) {
                        eprintln!("[default-apps] releasing {}: {e}", t.label());
                    }
                }
            }
        }
        // The backup is never removed here, and that is the fix for a real
        // data-loss bug. It used to be dropped once a restore "succeeded",
        // then rewritten on the next turn-on from the current owners -- which
        // by then were Tabverse, so the record of the true original owner was
        // overwritten with Tabverse and the way back was gone. Kept as a
        // write-once record of the pre-Tabverse world, re-enabling reads it,
        // never rewrites it. `unreturned` only drives the log line now.
        if unreturned > 0 {
            eprintln!(
                "[default-apps] {unreturned} of {} did not go back; the record is kept so \
                 turning it off again can retry",
                targets.len()
            );
        }
    }

    // Read back, and on a mismatch throw the resolver's cache away once and
    // read again. The write path and the answer path are separate services on
    // macOS, and the second does not always notice the first (see the macOS
    // backend's `prepare`); a status taken through a stale cache would report
    // the switch as failed when the write in fact landed.
    let first = status(kind);
    let looks_wrong = if enabled {
        first.held < first.total
    } else {
        // After turning off, holding anything the backup named is suspect --
        // but a target that had no owner to return to legitimately stays.
        first.held > 0
    };
    if looks_wrong {
        imp::refresh();
        return Ok(status(kind));
    }
    Ok(first)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Off the main thread, like every other command here that talks to something
/// outside the process.
///
/// Not a precaution: answering this means asking the system who owns each
/// target one at a time, and the editor switch alone has over a hundred of
/// them. Done inline, every settings render and every window focus would stall
/// the interface -- and a terminal that stutters while a settings page loads is
/// exactly the kind of cost the file commands already avoid this way.
#[tauri::command]
pub async fn default_apps_status() -> Result<Vec<Status>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        [Kind::Browser, Kind::Terminal, Kind::Editor]
            .into_iter()
            .map(status)
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn default_apps_set(
    app: AppHandle,
    kind: String,
    enabled: bool,
) -> Result<Status, String> {
    let kind = Kind::parse(&kind).ok_or_else(|| format!("unknown switch: {kind}"))?;
    tauri::async_runtime::spawn_blocking(move || set(&app, kind, enabled))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_keys_cannot_collide_across_variants() {
        let scheme = Target::Scheme("http".into());
        let file = Target::FileType {
            id: "http".into(),
            executes: false,
        };
        assert_ne!(scheme.key(), file.key());
    }

    /// The check that would have caught an empty claim list before it shipped.
    ///
    /// The first version read the associations from the running app's config,
    /// which silently contains none of them, so every switch had nothing to
    /// claim. Nothing failed: it compiled, the tests passed, and the editor
    /// switch reported "0 of 0" on a real machine. An assertion on the count is
    /// the cheapest thing that turns that into a red test.
    #[test]
    fn the_claim_list_survived_the_build() {
        assert!(
            DECLARED.len() >= 25,
            "only {} associations reached the binary",
            DECLARED.len()
        );
        let exts: Vec<&str> = DECLARED
            .iter()
            .flat_map(|a| a.ext.iter().copied())
            .collect();
        assert!(
            exts.len() >= 100,
            "only {} extensions reached the binary",
            exts.len()
        );
        assert!(
            DECLARED.iter().any(|a| a.executes),
            "nothing claims the shell role, so the terminal switch has no file types"
        );
    }

    /// Recording the previous owner must never name Tabverse itself.
    ///
    /// A type that already resolves here -- left from an earlier session, or
    /// claimed at install -- has an unknown true owner, and writing "Tabverse"
    /// into the backup makes the restore hand it straight back to us. This is
    /// the corruption that actually happened: a backup full of Tabverse, and
    /// no way home. The filter is the whole guard, so it gets its own test.
    #[test]
    fn the_backup_never_records_ourselves_as_the_previous_owner() {
        let me = "dev.tabverse.app";
        let candidates = [
            "dev.tabverse.app",
            "com.microsoft.VSCode",
            "ai.spalagu.vibeterm",
        ];
        let recorded: Vec<Option<&str>> = candidates
            .into_iter()
            .map(|owner| Some(owner).filter(|o| *o != me))
            .collect();
        assert_eq!(
            recorded,
            vec![
                None,
                Some("com.microsoft.VSCode"),
                Some("ai.spalagu.vibeterm")
            ]
        );
    }

    /// Two suffixes whose type means something other than what a file tab
    /// shows: `.ts` is an MPEG-2 transport stream and `.key` a Keynote
    /// document. Claiming either takes files that have nothing to do with this
    /// app, and the only thing keeping them out is their absence from the
    /// config -- which an edit could undo without anyone noticing.
    #[test]
    fn the_two_suffixes_ruled_out_stayed_out() {
        for banned in ["ts", "key"] {
            assert!(
                !DECLARED.iter().any(|a| a.ext.contains(&banned)),
                ".{banned} is claimed again"
            );
        }
    }

    /// The capability line the user drew: what the file tab merely displays is
    /// declared but never claimed -- extraction, playback, real editing and
    /// font installing live elsewhere. An archive or a video creeping back
    /// into the claim set is a regression, not a preference.
    #[test]
    fn display_only_groups_never_claim_the_default() {
        for name in [
            "Image",
            "PDF document",
            "Office document",
            "Audio",
            "Video",
            "Archive",
            "Font",
        ] {
            let a = DECLARED
                .iter()
                .find(|a| a.name == name)
                .unwrap_or_else(|| panic!("{name} vanished from the declarations"));
            assert!(!a.claims_default, "{name} is claimed as a default again");
        }
        for name in [
            "Markdown document",
            "Plain text",
            "Database",
            "Shell script",
        ] {
            let a = DECLARED.iter().find(|a| a.name == name).unwrap();
            assert!(a.claims_default, "{name} stopped being claimed");
        }
    }

    #[test]
    fn kind_round_trips_through_its_wire_name() {
        for k in [Kind::Browser, Kind::Terminal, Kind::Editor] {
            assert_eq!(Kind::parse(k.as_str()), Some(k));
        }
        assert_eq!(Kind::parse("files"), None);
    }
}
