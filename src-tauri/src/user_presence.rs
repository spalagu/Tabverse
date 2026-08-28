#![cfg(target_os = "macos")]

use std::ffi::CString;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_foundation::NSString;

// The class is looked up at runtime, so the framework has to be linked or
// there would be nothing to find.
#[link(name = "LocalAuthentication", kind = "framework")]
extern "C" {}

/// Touch ID **or** the account password — what the system calls "device
/// owner authentication".
///
/// The neighbouring value, 1, means biometrics and nothing else: on a Mac
/// without Touch ID it cannot be satisfied at all, and where there is a
/// sensor a failed finger has nowhere to go. It was the value used here at
/// first, which would have made this unusable on half the Macs there are.
const POLICY_OWNER_AUTH: isize = 2;

/// When the last successful ask was. An action that asks and then does the
/// work in a second step (choose a file, then write it) must not be a way
/// to do the work without asking.
static LAST_OK: Mutex<Option<Instant>> = Mutex::new(None);

/// How long an authorization stays good for. Long enough to pick a
/// location, short enough that walking away closes the window.
const GOOD_FOR: Duration = Duration::from_secs(120);

pub fn authorized_recently() -> bool {
    LAST_OK
        .lock()
        .unwrap()
        .map(|t| t.elapsed() < GOOD_FOR)
        .unwrap_or(false)
}

/// Ask, and block until the person answers.
///
/// Must not be called on the main thread: the system draws its sheet
/// there, and waiting on the answer from the same thread would mean
/// waiting for a sheet that cannot appear.
pub fn ask(reason: &str) -> Result<(), String> {
    unsafe {
        let name = CString::new("LAContext").unwrap();
        let cls = AnyClass::get(&name)
            .ok_or_else(|| "this Mac offers no fingerprint or password check".to_string())?;
        let ctx: *mut AnyObject = msg_send![cls, new];
        if ctx.is_null() {
            return Err("could not start the authorization check".into());
        }
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let reply = RcBlock::new(move |ok: Bool, _err: *mut AnyObject| {
            let _ = tx.send(ok.as_bool());
        });
        let text = NSString::from_str(reason);
        let () = msg_send![
            &*ctx,
            evaluatePolicy: POLICY_OWNER_AUTH,
            localizedReason: &*text,
            reply: &*reply,
        ];
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(true) => {
                *LAST_OK.lock().unwrap() = Some(Instant::now());
                Ok(())
            }
            // Cancelled and refused are the same answer as far as this is
            // concerned, and neither is an error worth a stack trace.
            Ok(false) => Err("not authorized".into()),
            Err(_) => Err("the authorization check did not answer".into()),
        }
    }
}
