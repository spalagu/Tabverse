//! Windows: register, then hand the decision to the user. There is no other
//! way, and that is the whole shape of this file.
//!
//! Microsoft's own documentation states that Windows does not allow
//! programmatic changes to default apps without user interaction in system UI,
//! that registry-based changes are not supported for applications, and that a
//! filter driver (`UCPD.sys`, shipping since February 2024) blocks writes to
//! the keys that hold the answer. The user's choice is additionally sealed with
//! a hash so a forged entry is rejected even if it could be written. The one
//! interface that used to do it, `IApplicationAssociationRegistration`, has had
//! everything but its query method unsupported since Windows 8.
//!
//! So the switches here are not switches. Turning one on does the three things
//! that *are* allowed and sanctioned:
//!
//! 1. register a private program identifier and a capability list, so Windows
//!    knows Tabverse exists and what it can open;
//! 2. announce the change so the shell re-reads it -- which is also what makes
//!    Windows offer its own "make this your default browser" notification;
//! 3. open the settings page for this app, where the user picks.
//!
//! Status is then read back from the user's own choice keys, so the UI shows
//! what the user actually decided rather than what we asked for.
//!
//! **The default-terminal slot is deliberately not touched.** Windows 11 keeps
//! it in `HKCU\Console\%%Startup`, which -- unlike everything above -- an
//! application really can write. Writing it is still wrong here: those two
//! values name a COM class expected to serve the console handoff interfaces,
//! and pointing them at a class this app does not serve would break every
//! console program on the machine, not just Tabverse. Implementing that server
//! is its own piece of work; until it exists these keys stay untouched and the
//! switch says so.

use std::process::Command;

use windows_registry::CURRENT_USER;

use super::{Kind, Target};

/// The name this app is filed under in the registry, in three places that must
/// agree: the value name under `RegisteredApplications`, `ApplicationName` in
/// the capability list, and the `registeredAppUser` parameter of the settings
/// deep link. Windows silently ignores the app if they disagree.
const APP_NAME: &str = "Tabverse";
const CAPABILITIES_PATH: &str = r"Software\Tabverse\Capabilities";

/// Program identifiers are per-application by rule: pointing a file type at a
/// shared identifier would make Tabverse's registration collide with whoever
/// else used it.
fn progid_for_file(kind: Kind) -> String {
    match kind {
        Kind::Terminal => "Tabverse.Script".into(),
        _ => "Tabverse.File".into(),
    }
}

fn progid_for_scheme(scheme: &str) -> String {
    format!("Tabverse.Url.{scheme}")
}

pub fn self_id() -> String {
    APP_NAME.to_string()
}

/// On Windows the thing a default is attached to is the extension itself,
/// not a separate type identifier.
pub fn file_targets(a: &super::DeclaredAssociation) -> Vec<String> {
    a.ext.iter().map(|e| format!(".{e}")).collect()
}

fn exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Who the user picked, read from the keys that record their choice.
///
/// An absent value means they have never chosen for this type, which is a
/// different state from "chose someone else" -- the caller shows it as "no
/// handler" rather than naming an app that was only ever a fallback.
pub fn current_handler(target: &Target) -> Option<String> {
    let path = match target {
        Target::Scheme(scheme) => format!(
            r"Software\Microsoft\Windows\CurrentVersion\Shell\Associations\UrlAssociations\{scheme}\UserChoice"
        ),
        Target::FileType { id, .. } => {
            format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{id}\UserChoice")
        }
    };
    let progid = CURRENT_USER.open(path).ok()?.get_string("ProgId").ok()?;
    // Report our own registrations under the one name the UI knows us by, so a
    // held target compares equal to `self_id()` the same way it does elsewhere.
    if progid.starts_with("Tabverse.") {
        Some(APP_NAME.to_string())
    } else {
        Some(progid)
    }
}

/// Nothing to do: an application may not assign a default on this platform.
/// Kept so the shared code has one shape, and returning an error here is what
/// makes a caller that ignores `settable` fail loudly instead of quietly.
pub fn set_handler(_target: &Target, _handler: super::Handler<'_>) -> Result<(), String> {
    Err(
        "Windows does not let an application assign a default; the user \
         chooses in Settings"
            .into(),
    )
}

fn register_progid(progid: &str, description: &str) -> Result<(), String> {
    let exe = exe_path();
    let key = CURRENT_USER
        .create(format!(r"Software\Classes\{progid}"))
        .map_err(|e| e.to_string())?;
    key.set_string("", description).map_err(|e| e.to_string())?;
    CURRENT_USER
        .create(format!(r"Software\Classes\{progid}\DefaultIcon"))
        .and_then(|k| k.set_string("", format!("{exe},0")))
        .map_err(|e| e.to_string())?;
    CURRENT_USER
        .create(format!(r"Software\Classes\{progid}\shell\open\command"))
        .and_then(|k| k.set_string("", format!("\"{exe}\" \"%1\"")))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Everything Windows permits: make the app a candidate and say so.
fn register(kind: Kind, targets: &[Target]) -> Result<(), String> {
    let caps = CURRENT_USER
        .create(CAPABILITIES_PATH)
        .map_err(|e| e.to_string())?;
    caps.set_string("ApplicationName", APP_NAME)
        .map_err(|e| e.to_string())?;
    // Required, not optional: without a description Windows leaves the app out
    // of every list of candidate defaults, and the deep link below lands on a
    // page that does not mention it.
    caps.set_string(
        "ApplicationDescription",
        "A terminal that also opens your files and the web.",
    )
    .map_err(|e| e.to_string())?;

    let file_progid = progid_for_file(kind);
    register_progid(&file_progid, "Tabverse document")?;

    let files = CURRENT_USER
        .create(format!(r"{CAPABILITIES_PATH}\FileAssociations"))
        .map_err(|e| e.to_string())?;
    let urls = CURRENT_USER
        .create(format!(r"{CAPABILITIES_PATH}\UrlAssociations"))
        .map_err(|e| e.to_string())?;

    for t in targets {
        match t {
            Target::FileType { id, .. } => {
                let _ = files.set_string(id, &file_progid);
                // Also list the app as a way to open the type, which is what
                // puts it in the "Open with" menu even before it is default.
                let _ = CURRENT_USER
                    .create(format!(r"Software\Classes\{id}\OpenWithProgids"))
                    .and_then(|k| k.set_string(&file_progid, ""));
            }
            Target::Scheme(scheme) => {
                let progid = progid_for_scheme(scheme);
                register_progid(&progid, &format!("Tabverse {scheme} link"))?;
                let _ = urls.set_string(scheme, &progid);
            }
        }
    }

    // A browser is only offered as one if it is also registered under the
    // browser clients list; the capability list alone does not put it there.
    if kind == Kind::Browser {
        let exe = exe_path();
        let client = format!(r"Software\Clients\StartMenuInternet\{APP_NAME}");
        let _ = CURRENT_USER
            .create(&client)
            .and_then(|k| k.set_string("", APP_NAME));
        let _ = CURRENT_USER
            .create(format!(r"{client}\shell\open\command"))
            .and_then(|k| k.set_string("", format!("\"{exe}\"")));
        let _ = CURRENT_USER
            .create(format!(r"{client}\Capabilities"))
            .and_then(|k| k.set_string("ApplicationName", APP_NAME));
    }

    CURRENT_USER
        .create(r"Software\RegisteredApplications")
        .and_then(|k| k.set_string(APP_NAME, CAPABILITIES_PATH))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Tell the shell the associations changed.
///
/// This is also the trigger for Windows' own "do you want to make this your
/// default browser" notification, which is the only prompt an application is
/// allowed to cause on this platform. Without it the registration sits in the
/// registry unnoticed until the next sign-in.
///
/// Called directly rather than through `rundll32`: that shortcut does not work
/// here, because `rundll32` can only invoke exports written to its own entry
/// point signature and this is an ordinary shell function.
fn announce_change() {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
}

fn open_settings_page() {
    // Lands on Tabverse's own page in Settings, where the one-click button
    // assigns the links and file types together. The parameter name has to
    // match the value under RegisteredApplications exactly.
    let url = format!("ms-settings:defaultapps?registeredAppUser={APP_NAME}");
    let _ = Command::new("cmd").args(["/C", "start", "", &url]).spawn();
}

pub fn prepare(kind: Kind, enabled: bool, targets: &[Target]) {
    if !enabled {
        // Turning a switch off cannot un-choose the user's choice either; the
        // page is where that is undone too.
        open_settings_page();
        return;
    }
    if kind == Kind::Terminal {
        // See the module doc: the registry values that would make this the
        // default terminal name a COM class we do not serve yet.
        return;
    }
    // Registration is what earns a place in the list; without it the deep link
    // below opens a page that does not mention Tabverse at all.
    if let Err(e) = register(kind, targets) {
        eprintln!("[default-apps] registration failed: {e}");
        return;
    }
    announce_change();
    open_settings_page();
}

/// The shell already re-reads associations on `SHChangeNotify`, which
/// `prepare` sends; nothing further to flush.
pub fn refresh() {}

/// Never. Every one of these is the user's to set on this platform.
pub fn settable(_kind: Kind) -> bool {
    false
}

pub fn display_name(progid: &str) -> String {
    if progid == APP_NAME {
        return APP_NAME.to_string();
    }
    // The readable name lives on the program identifier itself; falling back
    // to the identifier is still useful, since it names the owning app.
    CURRENT_USER
        .open(format!(r"Software\Classes\{progid}"))
        .and_then(|k| k.get_string(""))
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| progid.to_string())
}

pub fn note(kind: Kind) -> Option<String> {
    Some(match kind {
        Kind::Terminal => "Windows keeps its default-terminal setting behind a console handoff \
             service Tabverse does not implement yet, so this switch does not \
             change it. Shell scripts and ssh:// links still open here once you \
             pick Tabverse for them in Settings."
            .into(),
        _ => "Windows only lets you choose this yourself. Tabverse registers \
             itself and opens the Settings page — pick it there and this will \
             show as on."
            .into(),
    })
}
