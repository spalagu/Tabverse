//! macOS: Launch Services holds the answer to "who opens this".
//!
//! These are the deprecated C entry points rather than the NSWorkspace methods
//! that replaced them, for one reason that is not stylistic: **the replacement
//! dropped the handler role.** A terminal has to claim executables as `Shell`
//! -- "I run this" -- and `NSWorkspace.setDefaultApplication(at:toOpen:)` has
//! nowhere to say that. Apple's own answer to the gap is to keep using these,
//! and iTerm2 still does on current macOS. They also return bundle identifiers
//! directly, which is exactly what a backup of "who held this before" needs.
//!
//! Two behaviours to know before reading the calls:
//!
//! * **Setting http or https raises the system's own confirmation panel** and
//!   these functions return before the user answers it. So a successful return
//!   here means "asked", not "granted"; only the read-back in the caller says
//!   whether it took. Every other scheme and every file type is silent.
//! * **None of this works outside an installed bundle.** Launch Services binds
//!   handlers by bundle identifier, and a `tauri dev` process has no bundle, so
//!   `self_id` returns nothing and the switches report themselves unavailable
//!   rather than failing later with no explanation.

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::url::{CFURLRef, CFURL};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSBundle, NSString, NSURL};

use super::{Kind, Target};

// LSRolesMask. Only the two we use.
const K_LS_ROLES_SHELL: u32 = 4;
const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSSetDefaultRoleHandlerForContentType(
        content_type: CFStringRef,
        role: u32,
        handler_bundle_id: CFStringRef,
    ) -> i32;
    fn LSSetDefaultHandlerForURLScheme(scheme: CFStringRef, handler_bundle_id: CFStringRef) -> i32;
    fn LSCopyApplicationURLsForBundleIdentifier(
        bundle_id: CFStringRef,
        out_error: *mut core_foundation::base::CFTypeRef,
    ) -> core_foundation::array::CFArrayRef;
    fn LSRegisterURL(url: CFURLRef, update: u8) -> i32;

}

// Linked so that `class!(UTType)` resolves at runtime. A class lookup finds
// nothing if the framework that defines it was never loaded, and the failure
// looks exactly like "this suffix has no type" — every extension silently
// dropping out of the claim.
#[link(name = "UniformTypeIdentifiers", kind = "framework")]
extern "C" {}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFBundleGetMainBundle() -> *mut std::ffi::c_void;
    fn CFBundleGetIdentifier(bundle: *mut std::ffi::c_void) -> CFStringRef;
    fn CFBundleCopyBundleURL(bundle: *mut std::ffi::c_void) -> CFURLRef;
}

/// Wrap a `CFStringRef` this code owns (a `Copy`/`Create` result), or `None`
/// when the call returned null. Null is the normal answer for "nobody handles
/// this", not an error.
/// The identifier Launch Services knows this copy of the app by.
///
/// Empty outside a bundle — see the module doc. Callers compare against it, and
/// an empty string matches nothing, so an unbundled run reports every target as
/// held by someone else rather than pretending to own them.
pub fn self_id() -> String {
    unsafe {
        let bundle = CFBundleGetMainBundle();
        if bundle.is_null() {
            return String::new();
        }
        let raw = CFBundleGetIdentifier(bundle);
        if raw.is_null() {
            return String::new();
        }
        // Get rule, not create: this one is owned by the bundle.
        CFString::wrap_under_get_rule(raw).to_string()
    }
}

/// Everything one declared association maps to here: the type each of its
/// extensions actually resolves to on this machine, plus the types it names
/// outright. Named types matter because some have no extension at all --
/// `public.unix-executable` is the whole point of the terminal switch and no
/// suffix leads to it.
pub fn file_targets(a: &super::DeclaredAssociation) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for ext in a.ext {
        if let Some(id) = type_for_extension(ext) {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    for ct in a.content_types {
        let ct = (*ct).to_string();
        if !out.contains(&ct) {
            out.push(ct);
        }
    }
    out
}

/// The type an extension actually resolves to on this machine.
///
/// Uses the current API and not the Core Services function it replaced,
/// because the two do not agree. For a suffix with no declared type of its own
/// the old one synthesizes a *different* identifier — measured on `.fish`:
/// `dyn.age80q4pxra` from the old call against `dyn.ah62d4rv4ge80q4pxra` from
/// this one. Only the second is what a real file carries, and setting a
/// handler for the first is refused outright.
///
/// No conformance constraint is passed, and that is deliberate too: adding one
/// does not narrow the answer, it invents yet another synthesized type per
/// constraint, none of which any file on disk has.
fn type_for_extension(ext: &str) -> Option<String> {
    let ext = NSString::from_str(ext);
    unsafe {
        let cls = class!(UTType);
        let ty: *mut AnyObject = msg_send![cls, typeWithFilenameExtension: &*ext];
        if ty.is_null() {
            return None;
        }
        let id: Option<Retained<NSString>> = msg_send![ty, identifier];
        id.map(|s| s.to_string())
    }
}

/// The bundle identifier of the app at `url`, if there is one there.
unsafe fn bundle_id_at(url: *mut AnyObject) -> Option<String> {
    if url.is_null() {
        return None;
    }
    let url: &NSURL = &*(url as *const NSURL);
    let bundle = NSBundle::bundleWithURL(url)?;
    bundle.bundleIdentifier().map(|s| s.to_string())
}

fn role_for(executes: bool) -> u32 {
    if executes {
        K_LS_ROLES_SHELL
    } else {
        K_LS_ROLES_ALL
    }
}

/// Who opens this today.
///
/// **Reads use every role, never the declared one.** Asking with the `Shell`
/// mask does not answer "who opens a shell script" — it answers "who holds the
/// shell role for it", and the two differ: on the machine this was written on,
/// the first said iTerm and the second said VibeTerm. That distinction is not
/// academic, because this function is what fills the backup of previous
/// owners, and a backup built from the narrow answer hands the user's file
/// types to an app that never had them when the switch is turned off. Writes
/// still use the declared role — that part is about what this app is claiming
/// to be, which is a different question.
pub fn current_handler(target: &Target) -> Option<String> {
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        match target {
            Target::Scheme(scheme) => {
                let probe = NSString::from_str(&format!("{scheme}://example.invalid"));
                let url: Option<Retained<NSURL>> = NSURL::URLWithString(&probe);
                let url = url?;
                let app: *mut AnyObject = msg_send![workspace, URLForApplicationToOpenURL: &*url];
                bundle_id_at(app)
            }
            Target::FileType { id, .. } => {
                let ident = NSString::from_str(id);
                let ty: *mut AnyObject = msg_send![class!(UTType), typeWithIdentifier: &*ident];
                if ty.is_null() {
                    return None;
                }
                let app: *mut AnyObject =
                    msg_send![workspace, URLForApplicationToOpenContentType: ty];
                bundle_id_at(app)
            }
        }
    }
}

/// Point a target at `handler`.
///
/// A non-zero status is reported, but a zero status proves nothing on its own:
/// the browser prompt has not been answered yet when this returns, and Launch
/// Services accepts undeclared types without complaint. The caller reads back.
///
/// `Nobody` is the awkward one. Launch Services has no call for "let go of
/// this" — it can only be told who the owner is — so this passes an empty
/// identifier and lets the caller's read-back decide whether it took. What is
/// at stake is small and bounded: only the types that had no owner at all
/// before Tabverse claimed them, which on a developer's machine is a handful of
/// suffixes nothing else had ever registered for. If the system declines, those
/// stay with Tabverse after the switch goes off and show up in the count, which
/// is visible rather than hidden.
pub fn set_handler(target: &Target, handler: super::Handler<'_>) -> Result<(), String> {
    let me;
    let bundle_id = match handler {
        super::Handler::Other(h) => h,
        super::Handler::Nobody => "",
        super::Handler::This => {
            me = self_id();
            if me.is_empty() {
                return Err("not running from an installed app bundle".into());
            }
            &me
        }
    };
    let id = CFString::new(bundle_id);
    let status = unsafe {
        match target {
            Target::Scheme(scheme) => {
                let s = CFString::new(scheme);
                LSSetDefaultHandlerForURLScheme(s.as_concrete_TypeRef(), id.as_concrete_TypeRef())
            }
            Target::FileType {
                id: type_id,
                executes,
            } => {
                let t = CFString::new(type_id);
                LSSetDefaultRoleHandlerForContentType(
                    t.as_concrete_TypeRef(),
                    role_for(*executes),
                    id.as_concrete_TypeRef(),
                )
            }
        }
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{} refused: OSStatus {status}", target.label()))
    }
}

/// Make sure Launch Services has read *this* copy's declarations.
///
/// A freshly built bundle that has never been launched from Finder may not be
/// registered yet, and an unregistered app cannot be granted anything — the
/// set calls return success and the read-back shows the old owner. Cheap and
/// idempotent, so it runs before every set rather than once at startup.
///
/// It also restarts the Launch Services daemon first, and the order is the
/// point. Measured on macOS 26.6: a long-running `lsd` accepts these writes
/// into the preference file but keeps answering from its in-memory cache --
/// duti fails the identical way, so this is the OS, not this code -- and a
/// write racing a restart can be dropped outright. Against a freshly started
/// daemon the same writes apply immediately and the read-back sees them. The
/// kill is user-scoped (a non-root `killall` only reaches the caller's own
/// processes) and launchd respawns the daemon on the next lookup.
pub fn prepare(_kind: Kind, _enabled: bool, _targets: &[Target]) {
    refresh();
    unsafe {
        let bundle = CFBundleGetMainBundle();
        if bundle.is_null() {
            return;
        }
        let raw = CFBundleCopyBundleURL(bundle);
        if raw.is_null() {
            return;
        }
        let url = CFURL::wrap_under_create_rule(raw);
        LSRegisterURL(url.as_concrete_TypeRef(), 1);
    }
}

/// Turn a bundle identifier into something worth showing a person.
///
/// Falls back to the identifier itself when the app cannot be located — which
/// is the honest answer for a handler that is registered but not installed.
pub fn display_name(bundle_id: &str) -> String {
    let id = CFString::new(bundle_id);
    unsafe {
        let mut err: core_foundation::base::CFTypeRef = std::ptr::null();
        let raw = LSCopyApplicationURLsForBundleIdentifier(id.as_concrete_TypeRef(), &mut err);
        if !err.is_null() {
            let _ = CFType::wrap_under_create_rule(err);
        }
        if raw.is_null() {
            return bundle_id.to_string();
        }
        let urls: CFArray<CFURL> = CFArray::wrap_under_create_rule(raw);
        let Some(first) = urls.iter().next() else {
            return bundle_id.to_string();
        };
        first
            .to_path()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
            .unwrap_or_else(|| bundle_id.to_string())
    }
}

/// Throw away the resolver's stale answers: restart the user's Launch
/// Services daemon and give it a moment to come back.
///
/// Used before a write batch (see `prepare`) and again by the caller when a
/// read-back still disagrees after writing.
pub fn refresh() {
    let _ = std::process::Command::new("/usr/bin/killall")
        .arg("lsd")
        .status();
    std::thread::sleep(std::time::Duration::from_millis(600));
}

/// macOS lets an app set every one of these itself. The only thing that stops
/// it is not being an installed bundle.
pub fn settable(_kind: Kind) -> bool {
    !self_id().is_empty()
}

pub fn note(kind: Kind) -> Option<String> {
    if self_id().is_empty() {
        return Some(
            "Only available in the installed app — a development build has no \
             bundle for the system to bind to."
                .into(),
        );
    }
    match kind {
        Kind::Browser => Some(
            "macOS asks you to confirm this one in a panel of its own; the \
             switch catches up once you answer."
                .into(),
        ),
        // Worth saying plainly, because a user looking for a "default terminal"
        // setting in System Settings will not find one and will assume this
        // switch did nothing.
        Kind::Terminal => Some(
            "macOS has no default-terminal setting. This claims executables, \
             shell scripts and ssh:// links, which is what every other terminal \
             means by the same words."
                .into(),
        ),
        Kind::Editor => None,
    }
}
