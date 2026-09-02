use std::collections::BTreeMap;
use std::sync::OnceLock;

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
#[cfg(all(not(test), any(target_os = "macos", target_os = "windows")))]
const KEY_BUNDLE_SERVICE: &str = "Tabverse Key Bundle";
#[cfg(all(not(test), any(target_os = "macos", target_os = "windows")))]
const KEY_BUNDLE_ACCOUNT: &str = "key-bundle-v1";
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
const KEY_BUNDLE_MAGIC: &[u8] = b"TABVERSEKEYBUNDLE1";
const KEY_BYTES: usize = 32;
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
const KEY_BUNDLE_BYTES: usize = KEY_BUNDLE_MAGIC.len() + KEY_BYTES * 3;

/// The only secret stored in the platform credential store.
///
/// Each consumer still gets an independently random key. Packing them into
/// one versioned item means an ad-hoc-signed macOS update has one Keychain ACL
/// to authorize, rather than one ACL per consumer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct KeyBundle {
    terminal_helper: [u8; KEY_BYTES],
    login_vault: [u8; KEY_BYTES],
    cookie_snapshot: [u8; KEY_BYTES],
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
impl KeyBundle {
    fn generate() -> Self {
        Self {
            terminal_helper: rand::random(),
            login_vault: rand::random(),
            cookie_snapshot: rand::random(),
        }
    }

    fn encode(self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(KEY_BUNDLE_BYTES);
        bytes.extend_from_slice(KEY_BUNDLE_MAGIC);
        bytes.extend_from_slice(&self.terminal_helper);
        bytes.extend_from_slice(&self.login_vault);
        bytes.extend_from_slice(&self.cookie_snapshot);
        bytes
    }

    fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != KEY_BUNDLE_BYTES {
            return Err(format!(
                "key bundle has {} bytes, expected {KEY_BUNDLE_BYTES}",
                bytes.len()
            ));
        }
        if !bytes.starts_with(KEY_BUNDLE_MAGIC) {
            return Err("key bundle has an unknown format".into());
        }
        let mut offset = KEY_BUNDLE_MAGIC.len();
        let mut take_key = || {
            let mut key = [0u8; KEY_BYTES];
            key.copy_from_slice(&bytes[offset..offset + KEY_BYTES]);
            offset += KEY_BYTES;
            key
        };
        Ok(Self {
            terminal_helper: take_key(),
            login_vault: take_key(),
            cookie_snapshot: take_key(),
        })
    }
}

/// A process-wide single-flight. Both successful loads and user-visible
/// failures are cached so concurrent consumers cannot fan one authorization
/// decision out into repeated Keychain prompts.
struct KeyBundleCache {
    value: OnceLock<Result<KeyBundle, String>>,
}

impl KeyBundleCache {
    const fn new() -> Self {
        Self {
            value: OnceLock::new(),
        }
    }

    fn get_or_load(
        &self,
        loader: impl FnOnce() -> Result<KeyBundle, String>,
    ) -> Result<KeyBundle, String> {
        self.value.get_or_init(loader).clone()
    }
}

#[cfg(not(test))]
static KEY_BUNDLE: KeyBundleCache = KeyBundleCache::new();

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
/// one test storing a credential is enough to alter another test's path.
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

/// Stable 32-byte authentication key the GUI passes to the resident terminal
/// helper over an anonymous pipe. It is one field of the cached key bundle,
/// never an independent credential item, argv value, endpoint field, or log.
pub fn helper_token() -> Result<[u8; 32], String> {
    Ok(key_bundle()?.terminal_helper)
}

fn account(host: &str, username: &str) -> Result<String, String> {
    if host.contains(SEP) || username.contains(SEP) {
        return Err("host or username contains a control character".into());
    }
    Ok(format!("{host}{SEP}{username}"))
}

/// One bundle in the system store, everything else encrypted beside it.
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

    const MAGIC: &[u8] = b"TABVERSEVAULT2";
    const FILE: &str = "logins.v2.vault";

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
        Ok(key_bundle()?.login_vault)
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
/// bundle key that opens the store here belongs to the source install; the
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

#[cfg(test)]
fn key_bundle() -> Result<KeyBundle, String> {
    // Unit tests exercise sealing and unsealing without touching a real
    // credential store. The three values remain distinct so a wrong field
    // selection is observable.
    Ok(KeyBundle {
        terminal_helper: [0x11; KEY_BYTES],
        login_vault: [0x22; KEY_BYTES],
        cookie_snapshot: [0x33; KEY_BYTES],
    })
}

#[cfg(not(test))]
fn key_bundle() -> Result<KeyBundle, String> {
    KEY_BUNDLE.get_or_load(load_key_bundle_from_system)
}

/// Apply the platform-independent read/create policy around a credential
/// store. `None` is the only state allowed to create; read errors and corrupt
/// bytes return without invoking `write`.
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn load_or_create_key_bundle(
    read: impl FnOnce() -> Result<Option<Vec<u8>>, String>,
    write: impl FnOnce(&mut [u8]) -> Result<(), String>,
) -> Result<KeyBundle, String> {
    use zeroize::Zeroizing;

    match read()? {
        Some(bytes) => KeyBundle::decode(&Zeroizing::new(bytes)),
        None => {
            let bundle = KeyBundle::generate();
            let mut bytes = Zeroizing::new(bundle.encode());
            write(bytes.as_mut_slice())?;
            Ok(bundle)
        }
    }
}

/// The machine-local key encrypting the cookie snapshot: created on first
/// use, then stable for the install. 32 bytes, never logged.
pub fn cookie_key() -> Result<[u8; 32], String> {
    Ok(key_bundle()?.cookie_snapshot)
}

/// Fetch the one versioned key bundle this app keeps in the login Keychain,
/// creating it only when Security.framework says it is absent.
#[cfg(all(not(test), target_os = "macos"))]
fn load_key_bundle_from_system() -> Result<KeyBundle, String> {
    use security_framework::passwords::{get_generic_password, set_generic_password};
    use security_framework_sys::base::errSecItemNotFound;

    load_or_create_key_bundle(
        || match get_generic_password(KEY_BUNDLE_SERVICE, KEY_BUNDLE_ACCOUNT) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.code() == errSecItemNotFound => Ok(None),
            Err(error) => Err(format!("read key bundle: {error}")),
        },
        |bytes| {
            set_generic_password(KEY_BUNDLE_SERVICE, KEY_BUNDLE_ACCOUNT, bytes)
                .map_err(|e| format!("create key bundle: {e}"))
        },
    )
}

/// The same, in the store this system keeps credentials in.
///
/// A generic credential under this app's own target name, persisted for the
/// machine. Nothing else about the arrangement changes: the logins are in
/// the same encrypted file, sealed by the key this returns.
#[cfg(all(not(test), target_os = "windows"))]
fn load_key_bundle_from_system() -> Result<KeyBundle, String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let target = wide(&format!("{KEY_BUNDLE_SERVICE}:{KEY_BUNDLE_ACCOUNT}"));

    load_or_create_key_bundle(
        || unsafe {
            let mut found: *mut CREDENTIALW = std::ptr::null_mut();
            match CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut found) {
                Ok(()) if !found.is_null() => {
                    let cred = &*found;
                    let size = cred.CredentialBlobSize as usize;
                    let stored = if !cred.CredentialBlob.is_null() {
                        Ok(Some(
                            std::slice::from_raw_parts(cred.CredentialBlob, size).to_vec(),
                        ))
                    } else {
                        Err("key bundle has a null credential blob".into())
                    };
                    CredFree(found as *const core::ffi::c_void);
                    stored
                }
                Ok(()) => Err("read key bundle returned no credential".into()),
                Err(error) if error.code() == ERROR_NOT_FOUND.to_hresult() => Ok(None),
                Err(error) => Err(format!("read key bundle: {error}")),
            }
        },
        |bytes| unsafe {
            let cred = CREDENTIALW {
                Type: CRED_TYPE_GENERIC,
                TargetName: PWSTR(target.as_ptr() as *mut u16),
                CredentialBlobSize: bytes.len() as u32,
                CredentialBlob: bytes.as_mut_ptr(),
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                ..Default::default()
            };
            CredWriteW(&cred, 0).map_err(|e| format!("create key bundle: {e}"))
        },
    )
}

/// Systems this app has not been taught to keep a secret on.
///
/// Deliberately an error rather than a file with the key next to the
/// ciphertext: that arrangement encrypts nothing, and pretending otherwise
/// is worse than saying the feature is not available here.
#[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
fn load_key_bundle_from_system() -> Result<KeyBundle, String> {
    Err("this system has no credential store this app can keep a key bundle in".into())
}

#[cfg(test)]
mod key_bundle_tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    fn sample_bundle() -> KeyBundle {
        KeyBundle {
            terminal_helper: [0x41; KEY_BYTES],
            login_vault: [0x52; KEY_BYTES],
            cookie_snapshot: [0x63; KEY_BYTES],
        }
    }

    #[test]
    fn bundle_wire_format_is_strict_and_round_trips() {
        let bundle = sample_bundle();
        let bytes = bundle.encode();
        assert_eq!(bytes.len(), KEY_BUNDLE_BYTES);
        assert_eq!(KeyBundle::decode(&bytes).unwrap(), bundle);

        let mut wrong_magic = bytes.clone();
        wrong_magic[0] ^= 0xff;
        assert!(KeyBundle::decode(&wrong_magic).is_err());
        assert!(KeyBundle::decode(&bytes[..bytes.len() - 1]).is_err());
        let mut too_long = bytes;
        too_long.push(0);
        assert!(KeyBundle::decode(&too_long).is_err());
    }

    #[test]
    fn cache_single_flights_concurrent_consumers() {
        const THREADS: usize = 12;
        let cache = Arc::new(KeyBundleCache::new());
        let loads = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(THREADS));
        let mut workers = Vec::new();
        for _ in 0..THREADS {
            let cache = Arc::clone(&cache);
            let loads = Arc::clone(&loads);
            let barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                cache
                    .get_or_load(|| {
                        loads.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        Ok(sample_bundle())
                    })
                    .unwrap()
            }));
        }
        for worker in workers {
            assert_eq!(worker.join().unwrap(), sample_bundle());
        }
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cache_does_not_retry_a_rejected_authorization() {
        let cache = KeyBundleCache::new();
        let loads = AtomicUsize::new(0);
        let first = cache.get_or_load(|| {
            loads.fetch_add(1, Ordering::SeqCst);
            Err("authorization cancelled".into())
        });
        let second = cache.get_or_load(|| {
            loads.fetch_add(1, Ordering::SeqCst);
            Ok(sample_bundle())
        });
        assert_eq!(first.unwrap_err(), "authorization cancelled");
        assert_eq!(second.unwrap_err(), "authorization cancelled");
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn only_a_missing_item_is_created() {
        let writes = Cell::new(0);
        let created = load_or_create_key_bundle(
            || Ok(None),
            |bytes| {
                writes.set(writes.get() + 1);
                assert_eq!(bytes.len(), KEY_BUNDLE_BYTES);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(writes.get(), 1);
        assert_eq!(KeyBundle::decode(&created.encode()).unwrap(), created);
    }

    #[test]
    fn a_read_error_never_falls_through_to_create() {
        let writes = Cell::new(0);
        let result = load_or_create_key_bundle(
            || Err("authorization denied".into()),
            |_| {
                writes.set(writes.get() + 1);
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "authorization denied");
        assert_eq!(writes.get(), 0);
    }

    #[test]
    fn a_corrupt_existing_bundle_is_not_overwritten() {
        let writes = Cell::new(0);
        let result = load_or_create_key_bundle(
            || Ok(Some(b"not-a-key-bundle".to_vec())),
            |_| {
                writes.set(writes.get() + 1);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
    }

    #[test]
    fn test_consumers_receive_distinct_keys() {
        let bundle = key_bundle().unwrap();
        assert_eq!(helper_token().unwrap(), [0x11; KEY_BYTES]);
        assert_eq!(bundle.login_vault, [0x22; KEY_BYTES]);
        assert_eq!(cookie_key().unwrap(), [0x33; KEY_BYTES]);
    }

    #[test]
    fn legacy_vault_file_is_ignored_without_being_modified() {
        let preferred = tempfile::tempdir().unwrap();
        let _guard = test_vault_guard(preferred.path().to_path_buf());
        let dir = VAULT_DIR.get().unwrap();
        let legacy = dir.join("logins.vault");
        let marker = b"legacy-vault-must-remain-untouched";
        std::fs::write(&legacy, marker).unwrap();

        assert!(vault::read().unwrap().is_empty());
        assert_eq!(std::fs::read(&legacy).unwrap(), marker);
        assert!(dir.join("logins.v2.vault").exists());
    }
}
