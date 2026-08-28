#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows_core::{IInspectable, Interface, GUID, HRESULT, HSTRING};

/// `IUserConsentVerifierInterop`.
const IID_INTEROP: GUID = GUID::from_u128(0x39E050C3_4E74_441A_8DC0_B81104DF949C);

/// The layout of that interface: `IUnknown`, then `IInspectable`, then its
/// own single method. Order is the contract — a wrong slot calls the wrong
/// function — so every slot is named rather than padded over.
#[repr(C)]
struct InteropVtbl {
    query_interface:
        unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_iids: unsafe extern "system" fn(*mut c_void, *mut u32, *mut *mut GUID) -> HRESULT,
    get_runtime_class_name: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT,
    get_trust_level: unsafe extern "system" fn(*mut c_void, *mut i32) -> HRESULT,
    request_verification_for_window_async: unsafe extern "system" fn(
        *mut c_void,
        HWND,
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
}

/// When the last successful ask was. An action that asks and then does the
/// work in a second step (choose a file, then write it) must not become a
/// way to do the work without asking.
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
/// The window arrives as a plain number because a window handle is a raw
/// pointer and cannot cross a thread boundary as itself — and this has to
/// run off the thread that draws the window, since that is where the system
/// draws its prompt.
pub fn ask(window: isize, reason: &str) -> Result<(), String> {
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
    use windows_future::IAsyncOperation;

    let window = HWND(window as *mut c_void);

    // The class's activation factory, asked for the interop interface it
    // also implements.
    let factory: IInspectable = windows_core::factory::<UserConsentVerifier, IInspectable>()
        .map_err(|e| format!("this machine offers no identity check: {e}"))?;
    let mut interop: *mut c_void = std::ptr::null_mut();
    unsafe {
        factory
            .query(&IID_INTEROP, &mut interop)
            .ok()
            .map_err(|e| format!("this machine cannot ask over a window: {e}"))?;
    }
    if interop.is_null() {
        return Err("this machine cannot ask over a window".into());
    }

    let message = HSTRING::from(reason);
    let mut operation_raw: *mut c_void = std::ptr::null_mut();
    let started = unsafe {
        let vtbl = *(interop as *mut *const InteropVtbl);
        let hr = ((*vtbl).request_verification_for_window_async)(
            interop,
            window,
            std::mem::transmute_copy(&message),
            &IAsyncOperation::<UserConsentVerificationResult>::IID,
            &mut operation_raw,
        );
        // Released whichever way the call went: this reference is ours.
        ((*vtbl).release)(interop);
        hr
    };
    started
        .ok()
        .map_err(|e| format!("could not ask for confirmation: {e}"))?;
    if operation_raw.is_null() {
        return Err("the identity check did not start".into());
    }

    let operation: IAsyncOperation<UserConsentVerificationResult> =
        unsafe { IAsyncOperation::from_raw(operation_raw) };
    let verdict = operation
        .get()
        .map_err(|e| format!("the identity check did not answer: {e}"))?;

    if verdict == UserConsentVerificationResult::Verified {
        *LAST_OK.lock().unwrap() = Some(Instant::now());
        Ok(())
    } else {
        // Refused and cancelled are the same answer as far as this is
        // concerned, and neither is an error worth a stack trace.
        Err("not authorized".into())
    }
}
