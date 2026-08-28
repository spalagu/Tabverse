use std::collections::BTreeMap;

/// One saved web login. The password is only ever materialized on an
/// explicit find — list operations return (host, username) pairs.
pub struct WebCredential {
    pub host: String,
    pub username: String,
    pub password: String,
}

/// Separator inside an account name: `host<SEP>username`. U+0001 cannot
/// appear in a registrable host, and a username containing it is refused on
/// save rather than silently mangled.
const SEP: char = '\u{1}';

const WEB_SERVICE: &str = "Tabverse Web Passwords";
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
const AUTH_SERVICE: &str = "Tabverse HTTP Auth";
#[cfg(not(test))]
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
const KEY_SERVICE: &str = "Tabverse Keys";

/// The system-store service name the 32-byte keys live under.
#[cfg(not(test))]
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
fn key_service() -> String {
    KEY_SERVICE.to_string()
}

/// Where the encrypted login store lives. Set once at startup, because
/// resolving it needs the app handle and this module deliberately has no
/// idea what a Tauri app is.
static VAULT_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

pub fn set_vault_dir(dir: std::path::PathBuf) {
    let _ = VAULT_DIR.set(dir);
}

/// Serialises the tests that use the vault, and hands each one an empty one.
///
/// `VAULT_DIR` is a `OnceLock`, so only the first `set_vault_dir` of a test
/// binary takes effect and every later test silently shares that first
/// directory. Sharing it is survivable; sharing it *concurrently* is not —
/// one test storing an agent token is enough to send another test's session
/// thread down the signed-in path and out to the real network, where it waits
/// out a connect timeout and then a minute of socket idle.
///
/// Hold the returned guard for the whole test.
#[cfg(test)]
pub(crate) fn test_vault_guard(
    preferred: std::path::PathBuf,
) -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    // A test that panicked while holding this poisoned it; the next test still
    // wants a clean directory, so take it anyway.
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _ = VAULT_DIR.set(preferred);
    if let Some(dir) = VAULT_DIR.get() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    guard
}

/// Stable 32-byte authentication key shared by the GUI and the resident
/// terminal helper. It lives in the same machine-key seam as the encrypted
/// browser vault, never in argv, endpoint metadata, or logs.
pub fn helper_token() -> Result<[u8; 32], String> {
    machine_key("terminal-helper")
}

fn account(host: &str, username: &str) -> Result<String, String> {
    if host.contains(SEP) || username.contains(SEP) {
        return Err("host or username contains a control character".into());
    }
    Ok(format!("{host}{SEP}{username}"))
}

/// One key in the system's own store, everything else encrypted beside it.
///
/// Logins used to be one system credential each, and that is what made
/// macOS ask for permission **once per password**: an item's access list
/// names the exact binary that created it, and this app is signed ad-hoc,
/// so every rebuild is a stranger to every item. Exporting forty logins
/// meant answering forty dialogs.
///
/// So the arrangement is the one browsers use: a single key lives where the
/// system keeps secrets — one item, one permission, once — and the logins
/// live next to it in a file that key seals.
mod vault {
    use super::*;

    const MAGIC: &[u8] = b"CALVAULT1";
    const FILE: &str = "logins.vault";

    /// service -> "host\u{1}username" -> password
    pub type Store = BTreeMap<String, BTreeMap<String, String>>;

    fn path() -> Result<std::path::PathBuf, String> {
        let dir = VAULT_DIR
            .get()
            .ok_or_else(|| "the login store has no directory yet".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| format!("login store dir: {e}"))?;
        Ok(dir.join(FILE))
    }

    fn key() -> Result<[u8; 32], String> {
        machine_key("login-vault")
    }

    fn seal(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
        use aes_gcm::aead::Aead;
        use aes_gcm::{Aes256Gcm, KeyInit};
        let cipher = Aes256Gcm::new(key.into());
        let nonce: [u8; 12] = rand::random();
        let ct = cipher
            .encrypt((&nonce).into(), plain)
            .map_err(|e| format!("seal login store: {e}"))?;
        let mut out = Vec::with_capacity(MAGIC.len() + 12 + ct.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    fn unseal(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
        use aes_gcm::aead::Aead;
        use aes_gcm::{Aes256Gcm, KeyInit};
        if data.len() < MAGIC.len() + 12 || &data[..MAGIC.len()] != MAGIC {
            return Err("the login store is not in a shape this app wrote".into());
        }
        let (nonce, ct) = data[MAGIC.len()..].split_at(12);
        let cipher = Aes256Gcm::new(key.into());
        cipher
            .decrypt(nonce.into(), ct)
            .map_err(|_| "the login store does not open with this machine's key".to_string())
    }

    pub fn read() -> Result<Store, String> {
        let p = path()?;
        if !p.exists() {
            // Nothing yet: an empty store, written so the next read has a
            // file to open. Nothing is carried in from anywhere — this app
            // keeps logins in exactly one place.
            let store = Store::new();
            write(&store)?;
            return Ok(store);
        }
        let data = std::fs::read(&p).map_err(|e| format!("read login store: {e}"))?;
        let plain = unseal(&key()?, &data)?;
        serde_json::from_slice(&plain).map_err(|e| format!("login store is damaged: {e}"))
    }

    pub fn write(store: &Store) -> Result<(), String> {
        let plain = serde_json::to_vec(store).map_err(|e| format!("login store: {e}"))?;
        let sealed = seal(&key()?, &plain)?;
        let p = path()?;
        // Written beside and renamed, so a crash mid-write cannot leave a
        // half file where every saved login used to be.
        let tmp = p.with_extension("vault.tmp");
        std::fs::write(&tmp, sealed).map_err(|e| format!("write login store: {e}"))?;
        std::fs::rename(&tmp, &p).map_err(|e| format!("replace login store: {e}"))
    }
}

fn save(service: &str, host: &str, username: &str, password: &str) -> Result<(), String> {
    let acct = account(host, username)?;
    let mut store = vault::read()?;
    store
        .entry(service.to_string())
        .or_default()
        .insert(acct, password.to_string());
    vault::write(&store)
}

fn accounts(service: &str) -> Result<Vec<(String, String)>, String> {
    let store = vault::read()?;
    Ok(store
        .get(service)
        .map(|m| {
            m.keys()
                .filter_map(|acct| acct.split_once(SEP))
                .map(|(h, u)| (h.to_string(), u.to_string()))
                .collect()
        })
        .unwrap_or_default())
}

fn find(service: &str, host: &str) -> Result<Vec<WebCredential>, String> {
    let store = vault::read()?;
    let Some(entries) = store.get(service) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (acct, password) in entries {
        let Some((h, user)) = acct.split_once(SEP) else {
            continue;
        };
        if h != host {
            continue;
        }
        out.push(WebCredential {
            host: h.to_string(),
            username: user.to_string(),
            password: password.clone(),
        });
    }
    Ok(out)
}

fn delete(service: &str, host: &str, username: &str) -> Result<(), String> {
    let acct = account(host, username)?;
    let mut store = vault::read()?;
    if let Some(entries) = store.get_mut(service) {
        entries.remove(&acct);
    }
    vault::write(&store)
}

/// Where the agent keeps its sign-in.
///
/// A service of its own rather than a row among the web logins: it is not a
/// site password, it is not shown in the passwords UI, and "forget every saved
/// web login" must not sign the agent out as a side effect.
const AGENT_SERVICE: &str = "tabverse.agent";

/// Store one secret for the agent under a name of its own.
///
/// Goes through the same sealed vault as everything else — one system
/// credential, one permission prompt, the rest encrypted beside it.
pub fn save_agent_secret(name: &str, value: &str) -> Result<(), String> {
    save(AGENT_SERVICE, name, "", value)
}

pub fn read_agent_secret(name: &str) -> Result<Option<String>, String> {
    let acct = account(name, "")?;
    Ok(vault::read()?
        .get(AGENT_SERVICE)
        .and_then(|entries| entries.get(&acct))
        .cloned())
}

pub fn delete_agent_secret(name: &str) -> Result<(), String> {
    delete(AGENT_SERVICE, name, "")
}

pub fn save_web(host: &str, username: &str, password: &str) -> Result<(), String> {
    save(WEB_SERVICE, host, username, password)
}
pub fn list_web() -> Result<Vec<(String, String)>, String> {
    accounts(WEB_SERVICE)
}
pub fn find_web(host: &str) -> Result<Vec<WebCredential>, String> {
    find(WEB_SERVICE, host)
}
pub fn delete_web(host: &str, username: &str) -> Result<(), String> {
    delete(WEB_SERVICE, host, username)
}

/// Forget every saved web login.
pub fn forget_all_web() -> Result<usize, String> {
    let mut store = vault::read()?;
    let gone = store.get(WEB_SERVICE).map(|m| m.len()).unwrap_or(0);
    store.remove(WEB_SERVICE);
    vault::write(&store)?;
    Ok(gone)
}

pub type VaultDump = BTreeMap<String, BTreeMap<String, String>>;

/// Read out the entire store, in the clear, for the migration exporter.
///
/// The plaintext this returns is handed straight into the passphrase-sealed
/// archive and nowhere else — never a file on its own, never a log line. The
/// machine key that opens the store here is the source machine's; the
/// destination re-seals under its own via [`replace_vault`].
pub fn export_vault() -> Result<VaultDump, String> {
    vault::read()
}

/// Replace the whole store with `dump`, sealed under THIS machine's key.
///
/// Used by the migration importer on the destination: the archive carried
/// the logins in the clear (under its own encryption), and here they re-enter
/// the local store the same way a freshly-saved login would — bound to this
/// machine's key, readable by nothing that lacks it.
pub fn replace_vault(dump: &VaultDump) -> Result<(), String> {
    vault::write(dump)
}

/// How many logins a dump carries, across every service.
pub fn vault_len(dump: &VaultDump) -> usize {
    dump.values().map(|m| m.len()).sum()
}

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub fn save_http_auth(key: &str, username: &str, password: &str) -> Result<(), String> {
    save(AUTH_SERVICE, key, username, password)
}
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub fn find_http_auth(key: &str) -> Result<Vec<WebCredential>, String> {
    find(AUTH_SERVICE, key)
}

/// The deterministic stand-in key: the name, cycled to 32 bytes.
///
/// What the vault exercises in an automated run is the sealing and
/// unsealing, and that only needs a key that is the same every time it
/// is asked for. Nothing sealed under these keys is a secret — the mode
/// encrypts reproducibility, not data — so it must never be used outside
/// an automated run.
#[cfg(test)]
fn fixed_key(name: &str) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    for (slot, byte) in key.iter_mut().zip(name.bytes().cycle()) {
        *slot = byte;
    }
    Ok(key)
}

/// The one doorway every machine key goes through. Test builds and
/// production builds use separate implementations: unit tests get a
/// deterministic stand-in, while the application always uses the platform
/// credential store.
fn machine_key(name: &str) -> Result<[u8; 32], String> {
    #[cfg(test)]
    {
        fixed_key(name)
    }
    #[cfg(not(test))]
    {
        machine_key_from_system(name)
    }
}

/// The machine-local key encrypting the cookie snapshot: created on first
/// use, then stable for the install. 32 bytes, never logged.
pub fn cookie_key() -> Result<[u8; 32], String> {
    machine_key("cookie-snapshot")
}

/// Fetch a 32-byte key the system keeps for this app, creating it the first
/// time. **The only part of this file that differs by platform.**
#[cfg(all(not(test), target_os = "macos"))]
fn machine_key_from_system(name: &str) -> Result<[u8; 32], String> {
    use security_framework::passwords::{get_generic_password, set_generic_password};
    let service = key_service();
    match get_generic_password(&service, name) {
        Ok(bytes) if bytes.len() == 32 => {
            let mut k = [0u8; 32];
            k.copy_from_slice(&bytes);
            Ok(k)
        }
        // Wrong length means a corrupt entry; regenerating would orphan the
        // ciphertext it belongs to, so surface it instead.
        Ok(bytes) => Err(format!("{name} key has {} bytes, expected 32", bytes.len())),
        Err(_) => {
            let key: [u8; 32] = rand::random();
            set_generic_password(&service, name, &key)
                .map_err(|e| format!("create {name} key: {e}"))?;
            Ok(key)
        }
    }
}

/// The same, in the store this system keeps credentials in.
///
/// A generic credential under this app's own target name, persisted for the
/// machine. Nothing else about the arrangement changes: the logins are in
/// the same encrypted file, sealed by the key this returns.
#[cfg(all(not(test), target_os = "windows"))]
fn machine_key_from_system(name: &str) -> Result<[u8; 32], String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Security::Credentials::{
        CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let target = wide(&format!("{}:{name}", key_service()));

    unsafe {
        let mut found: *mut CREDENTIALW = std::ptr::null_mut();
        if CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut found).is_ok()
            && !found.is_null()
        {
            let cred = &*found;
            let size = cred.CredentialBlobSize as usize;
            let stored = if size == 32 && !cred.CredentialBlob.is_null() {
                let mut k = [0u8; 32];
                k.copy_from_slice(std::slice::from_raw_parts(cred.CredentialBlob, size));
                Some(k)
            } else {
                None
            };
            CredFree(found as *const core::ffi::c_void);
            return match stored {
                Some(k) => Ok(k),
                None => Err(format!("{name} key has {size} bytes, expected 32")),
            };
        }

        let mut key: [u8; 32] = rand::random();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_ptr() as *mut u16),
            CredentialBlobSize: 32,
            CredentialBlob: key.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        CredWriteW(&cred, 0).map_err(|e| format!("create {name} key: {e}"))?;
        Ok(key)
    }
}

/// Systems this app has not been taught to keep a secret on.
///
/// Deliberately an error rather than a file with the key next to the
/// ciphertext: that arrangement encrypts nothing, and pretending otherwise
/// is worse than saying the feature is not available here.
#[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
fn machine_key_from_system(name: &str) -> Result<[u8; 32], String> {
    Err(format!(
        "this system has no credential store this app can keep the {name} key in"
    ))
}
