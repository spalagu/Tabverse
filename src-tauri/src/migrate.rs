use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use zeroize::Zeroizing;

/// Format identifier. The trailing bytes of the header carry the numeric
/// version; this is the "is this even ours" gate.
const MAGIC: &[u8] = b"TABVERSEMIGRATE";
const FORMAT_VERSION: u8 = 1;

/// State-directory entries that never travel. Matched on the path relative to
/// the state dir, with `/` separators.
fn excluded_file(rel: &str) -> bool {
    // Login state: the engine's own website data, declared out of scope.
    rel == "browser-session-cookies.json"
        // The vault is not copied raw — its bytes are sealed under *this*
        // machine's key and would not open on another. Its contents ride in
        // the `passwords` section instead, re-sealed on arrival.
        || rel == "logins.vault"
        // A crash-time temp file is not state.
        || rel.ends_with(".tmp")
        // Favicon cache (cosmetic, re-fetched).
        || rel == "favicons"
        || rel.starts_with("favicons/")
}

/// Argon2id cost. OWASP's interactive recommendation: 19 MiB, two passes, one
/// lane. Recorded in every archive's header, so a file made with other costs
/// still opens — the reader always uses the file's own parameters.
const ARGON_M_COST: u32 = 19 * 1024;
const ARGON_T_COST: u32 = 2;
const ARGON_P_COST: u32 = 1;

/// The cleartext, tamper-evident preamble. Not secret — a salt and a nonce
/// never are — but bound into the GCM tag as associated data so it cannot be
/// altered without decryption failing.
#[derive(serde::Serialize, serde::Deserialize)]
struct Header {
    kdf: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    /// base64, 16 bytes.
    salt: String,
    /// base64, 12 bytes.
    nonce: String,
}

/// The encrypted body.
#[derive(serde::Serialize, serde::Deserialize)]
struct Payload {
    /// state-dir-relative path (`/`-separated) -> base64 of the file's bytes.
    /// Every scope is one of these, byte-for-byte, so the round trip is exact
    /// and a scope added later travels without this module being told about
    /// it.
    files: BTreeMap<String, String>,
    /// service -> "host\u{1}user" -> password. The vault, in the clear inside
    /// the seal, re-sealed under the destination's machine key on import.
    passwords: crate::credentials::VaultDump,
}

/// What a completed export or a validated import amounts to, for the message
/// the user sees. Counts only — never a name, never a value.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Top-level `.json` scope files carried.
    pub scopes: usize,
    /// Total logins carried, across every service.
    pub passwords: usize,
    pub version: u8,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub summary: Summary,
    /// Absolute path the destination's prior state was copied to before it
    /// was replaced. Named in the confirm box and the done message, because
    /// it is the only way back from an irreversible step.
    pub backup_path: String,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|_| "the archive header is not readable".to_string())
}

/// Stretch the passphrase into a 32-byte key. The output is wrapped so it is
/// wiped when it drops rather than lingering in freed memory.
fn derive_key(
    passphrase: &[u8],
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<Zeroizing<[u8; 32]>, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(m_cost, t_cost, p_cost, Some(32))
        .map_err(|e| format!("key-derivation parameters: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(passphrase, salt, key.as_mut())
        .map_err(|e| format!("deriving the key: {e}"))?;
    Ok(key)
}

/// Collect every state file that travels, keyed by state-dir-relative path.
fn collect_files(state_dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    if !state_dir.exists() {
        return Ok(out);
    }
    walk(state_dir, state_dir, &mut out)?;
    Ok(out)
}

fn rel_of(base: &Path, path: &Path) -> Result<String, String> {
    let rel = path
        .strip_prefix(base)
        .map_err(|_| "a state file escaped the state directory".to_string())?;
    // One separator on the wire, whatever the platform writes, so an archive
    // made on one OS restores on another.
    Ok(rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/"))
}

fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<(), String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("reading {}: {e}", dir.display()))?;
    for entry in rd {
        let entry = entry.map_err(|e| format!("reading a state entry: {e}"))?;
        let path = entry.path();
        let rel = rel_of(base, &path)?;
        if excluded_file(&rel) {
            continue;
        }
        let ft = entry
            .file_type()
            .map_err(|e| format!("stat {}: {e}", path.display()))?;
        if ft.is_dir() {
            walk(base, &path, out)?;
        } else if ft.is_file() {
            let bytes =
                std::fs::read(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
            out.insert(rel, b64(&bytes));
        }
        // Symlinks and anything else are skipped: the state dir holds regular
        // files only, and following a link out of it would be a way to pack
        // something that was never state.
    }
    Ok(())
}

fn count_scopes(files: &BTreeMap<String, String>) -> usize {
    files
        .keys()
        .filter(|k| k.ends_with(".json") && !k.contains('/'))
        .count()
}

/// Seal a payload into archive bytes. The crypto core, deliberately free of
/// the state directory and the credential store so it is testable on its own.
fn seal(
    files: BTreeMap<String, String>,
    passwords: crate::credentials::VaultDump,
    passphrase: &str,
) -> Result<(Vec<u8>, Summary), String> {
    if passphrase.is_empty() {
        return Err("choose a passphrase to protect the file".into());
    }
    let scopes = count_scopes(&files);
    let password_count = crate::credentials::vault_len(&passwords);

    let payload = Payload { files, passwords };
    // Serialize into a buffer we can wipe: it holds the vault and the history
    // in the clear until it is sealed.
    let plaintext = Zeroizing::new(
        serde_json::to_vec(&payload).map_err(|e| format!("packing the archive: {e}"))?,
    );

    let salt: [u8; 16] = rand::random();
    let nonce: [u8; 12] = rand::random();
    let key = derive_key(
        passphrase.as_bytes(),
        &salt,
        ARGON_M_COST,
        ARGON_T_COST,
        ARGON_P_COST,
    )?;

    let header = Header {
        kdf: "argon2id".into(),
        m_cost: ARGON_M_COST,
        t_cost: ARGON_T_COST,
        p_cost: ARGON_P_COST,
        salt: b64(&salt),
        nonce: b64(&nonce),
    };
    let header_json = serde_json::to_vec(&header).map_err(|e| format!("archive header: {e}"))?;

    let ciphertext = {
        use aes_gcm::aead::{Aead, Payload as AeadPayload};
        use aes_gcm::{Aes256Gcm, KeyInit};
        let cipher = Aes256Gcm::new((&*key).into());
        cipher
            .encrypt(
                (&nonce).into(),
                AeadPayload {
                    msg: &plaintext,
                    aad: &header_json,
                },
            )
            .map_err(|e| format!("sealing the archive: {e}"))?
    };

    let mut out = Vec::with_capacity(MAGIC.len() + 1 + 4 + header_json.len() + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.push(FORMAT_VERSION);
    out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_json);
    out.extend_from_slice(&ciphertext);

    Ok((
        out,
        Summary {
            scopes,
            passwords: password_count,
            version: FORMAT_VERSION,
        },
    ))
}

/// Gather the live state directory and the credential vault, seal them, and
/// write the archive to `path`. This is the one place export touches the
/// keychain (through `credentials::export_vault`).
pub fn export_to_path(state_dir: &Path, path: &Path, passphrase: &str) -> Result<Summary, String> {
    let files = collect_files(state_dir)?;
    let passwords = crate::credentials::export_vault()?;
    let (bytes, summary) = seal(files, passwords, passphrase)?;
    std::fs::write(path, &bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    eprintln!(
        "[migrate] exported {} scopes and {} passwords",
        summary.scopes, summary.passwords
    );
    Ok(summary)
}

/// Read, version-gate, decrypt and parse an archive — and touch nothing else.
///
/// This is where all three of the promised failures live (wrong passphrase,
/// truncation, unrecognized version), so that by the time an import proceeds
/// to back up and replace, none of them can still happen. It never writes.
fn decode(path: &Path, passphrase: &str) -> Result<(Payload, Summary), String> {
    let data = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;

    // --- structural gates: everything detectable before decryption ---
    let head_min = MAGIC.len() + 1 + 4;
    if data.len() < head_min {
        return Err("this file is too short to be a migration archive (truncated?)".into());
    }
    if &data[..MAGIC.len()] != MAGIC {
        return Err("this is not a Tabverse migration file".into());
    }
    let version = data[MAGIC.len()];
    if version != FORMAT_VERSION {
        return Err(format!(
            "this archive is format version {version}; this build reads version {FORMAT_VERSION}. \
             Migrate between installs of the same version."
        ));
    }
    let hl_at = MAGIC.len() + 1;
    let header_len = u32::from_le_bytes([
        data[hl_at],
        data[hl_at + 1],
        data[hl_at + 2],
        data[hl_at + 3],
    ]) as usize;
    let header_start = hl_at + 4;
    let header_end = header_start
        .checked_add(header_len)
        .ok_or("this migration file is corrupt (bad header length)")?;
    // Need the header and at least a GCM tag (16 bytes) after it.
    if data.len() < header_end + 16 {
        return Err("this migration file is truncated".into());
    }
    let header_bytes = &data[header_start..header_end];
    let header: Header = serde_json::from_slice(header_bytes)
        .map_err(|_| "this migration file is corrupt (unreadable header)".to_string())?;
    let ciphertext = &data[header_end..];

    let salt = unb64(&header.salt)?;
    let nonce = unb64(&header.nonce)?;
    if nonce.len() != 12 || salt.len() < 8 {
        return Err("this migration file is corrupt (bad salt or nonce)".into());
    }

    // --- decrypt: wrong passphrase and a mangled body both fail here ---
    let key = derive_key(
        passphrase.as_bytes(),
        &salt,
        header.m_cost,
        header.t_cost,
        header.p_cost,
    )?;
    let plaintext = {
        use aes_gcm::aead::{Aead, Payload as AeadPayload};
        use aes_gcm::{Aes256Gcm, KeyInit};
        let cipher = Aes256Gcm::new((&*key).into());
        Zeroizing::new(
            cipher
                .decrypt(
                    nonce.as_slice().into(),
                    AeadPayload {
                        msg: ciphertext,
                        aad: header_bytes,
                    },
                )
                .map_err(|_| {
                    "wrong passphrase, or this file has been damaged — nothing was changed"
                        .to_string()
                })?,
        )
    };

    let payload: Payload = serde_json::from_slice(&plaintext)
        .map_err(|_| "the archive opened but its contents are unreadable".to_string())?;
    let scopes = count_scopes(&payload.files);
    let passwords = crate::credentials::vault_len(&payload.passwords);
    Ok((
        payload,
        Summary {
            scopes,
            passwords,
            version,
        },
    ))
}

/// Validate an archive against a passphrase without importing it. Zero side
/// effects — the UI calls this to reject a wrong passphrase before it shows
/// the "this will replace everything" confirmation.
pub fn check_bundle(path: &Path, passphrase: &str) -> Result<Summary, String> {
    decode(path, passphrase).map(|(_, s)| s)
}

/// A time stamp becomes a directory name, so it may only be the safe
/// characters a stamp is made of. The value comes from the front end (this
/// side takes no clock, per the state-dir conventions); a bad one is a bug,
/// refused rather than sanitized.
fn valid_stamp(stamp: &str) -> bool {
    !stamp.is_empty()
        && stamp.len() <= 40
        && stamp
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && stamp != "."
        && stamp != ".."
}

/// Where the destination's prior state is copied before replacement:
/// `<state>/../backup-<stamp>/`.
pub fn backup_dir(state_dir: &Path, stamp: &str) -> Result<PathBuf, String> {
    if !valid_stamp(stamp) {
        return Err("the backup stamp is not a valid directory name".into());
    }
    let parent = state_dir
        .parent()
        .ok_or("the state directory has no parent to back up beside")?;
    Ok(parent.join(format!("backup-{stamp}")))
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("creating {}: {e}", to.display()))?;
    let rd = std::fs::read_dir(from).map_err(|e| format!("reading {}: {e}", from.display()))?;
    for entry in rd {
        let entry = entry.map_err(|e| format!("reading an entry: {e}"))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let ft = entry
            .file_type()
            .map_err(|e| format!("stat {}: {e}", src.display()))?;
        if ft.is_dir() {
            copy_tree(&src, &dst)?;
        } else if ft.is_file() {
            std::fs::copy(&src, &dst).map_err(|e| format!("copying {}: {e}", src.display()))?;
        }
    }
    Ok(())
}

/// Empty a directory's contents, keeping the directory itself.
fn clear_dir(dir: &Path) -> Result<(), String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("reading {}: {e}", dir.display()))?;
    for entry in rd {
        let entry = entry.map_err(|e| format!("reading an entry: {e}"))?;
        let path = entry.path();
        let ft = entry
            .file_type()
            .map_err(|e| format!("stat {}: {e}", path.display()))?;
        if ft.is_dir() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| format!("removing {}: {e}", path.display()))?;
        } else {
            std::fs::remove_file(&path).map_err(|e| format!("removing {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Back up the current state directory, then replace its files with the
/// archive's. Keychain-free: the vault is written separately by the caller,
/// which keeps this half testable without touching the credential store.
/// Returns the backup directory that now holds the prior state.
fn write_payload(state_dir: &Path, payload: &Payload, stamp: &str) -> Result<PathBuf, String> {
    let backup = backup_dir(state_dir, stamp)?;
    if backup.exists() {
        return Err(format!(
            "a backup already exists at {} — refusing to overwrite it",
            backup.display()
        ));
    }

    // Back up the destination's current state (whole directory). If there is
    // nothing there yet, still create the promised directory so the path in
    // the message is real.
    if state_dir.exists() {
        copy_tree(state_dir, &backup)?;
    } else {
        std::fs::create_dir_all(&backup)
            .map_err(|e| format!("creating {}: {e}", backup.display()))?;
    }

    // Replace. From here on the backup is the way back.
    std::fs::create_dir_all(state_dir)
        .map_err(|e| format!("creating {}: {e}", state_dir.display()))?;
    clear_dir(state_dir)?;
    for (rel, data) in &payload.files {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| format!("a file in the archive ({rel}) is corrupt"))?;
        // Rebuild the path from `/`-separated components under the state dir;
        // reject any that would climb out of it.
        let mut dest = state_dir.to_path_buf();
        for comp in rel.split('/') {
            if comp.is_empty() || comp == "." || comp == ".." {
                return Err(format!("the archive holds an unsafe path: {rel}"));
            }
            dest.push(comp);
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("creating {}: {e}", parent.display()))?;
        }
        std::fs::write(&dest, &bytes).map_err(|e| format!("writing {}: {e}", dest.display()))?;
    }
    Ok(backup)
}

/// Import an archive: validate it whole, back up what is there, replace it.
///
/// The order is the guarantee. Decoding comes first and writes nothing, so a
/// wrong passphrase, a truncated file or an unknown version leaves the disk
/// untouched. Only once the archive is proven good does the current state get
/// copied aside and then replaced. `stamp` names the backup directory and
/// comes from the caller — this side keeps no clock.
pub fn import_bundle(
    state_dir: &Path,
    path: &Path,
    passphrase: &str,
    stamp: &str,
) -> Result<ImportResult, String> {
    // Whole-archive validation, before a single byte of state is touched.
    let (payload, summary) = decode(path, passphrase)?;
    let backup = write_payload(state_dir, &payload, stamp)?;
    // The vault re-enters the local store under this machine's key.
    crate::credentials::replace_vault(&payload.passwords)?;

    eprintln!(
        "[migrate] imported {} scopes and {} passwords; prior state backed up",
        summary.scopes, summary.passwords
    );
    Ok(ImportResult {
        summary,
        backup_path: backup.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "tabverse-migrate-{tag}-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    /// A state directory with a couple of scopes and a nested userscript body,
    /// plus the files that must NOT travel.
    fn seed_state(dir: &Path) {
        std::fs::write(dir.join("session.json"), br#"{"tabs":["a","b"]}"#).unwrap();
        std::fs::write(dir.join("settings.json"), br#"{"engine":"kagi"}"#).unwrap();
        std::fs::write(dir.join("browser-visits.json"), br#"[{"url":"x"}]"#).unwrap();
        std::fs::create_dir_all(dir.join("userscripts")).unwrap();
        std::fs::write(dir.join("userscripts").join("abcd.js"), b"marker();").unwrap();
        // Excluded: login state and the raw vault, plus a favicon and a temp.
        std::fs::write(dir.join("browser-session-cookies.json"), b"SECRETCOOKIE").unwrap();
        std::fs::write(dir.join("logins.vault"), b"RAWVAULTBYTES").unwrap();
        std::fs::create_dir_all(dir.join("favicons")).unwrap();
        std::fs::write(dir.join("favicons").join("x.dataurl"), b"icon").unwrap();
        std::fs::write(dir.join("session.json.tmp"), b"half").unwrap();
    }

    /// A couple of vault entries to stand in for the keychain-backed store,
    /// so the crypto core can be exercised without a real Keychain.
    fn seed_vault() -> crate::credentials::VaultDump {
        let mut web = BTreeMap::new();
        web.insert(
            "gitlab.example\u{1}me".to_string(),
            "hunter2secret".to_string(),
        );
        web.insert(
            "news.example\u{1}reader".to_string(),
            "s3cr3tpw".to_string(),
        );
        let mut dump = BTreeMap::new();
        dump.insert("Tabverse Web Passwords".to_string(), web);
        dump
    }

    /// The walk carries every scope and the nested userscript body, and leaves
    /// login state, the raw vault, favicons and temp files behind.
    #[test]
    fn the_walk_carries_scopes_and_excludes_login_state() {
        let src = scratch("walk");
        seed_state(&src);
        let files = collect_files(&src).unwrap();
        assert_eq!(count_scopes(&files), 3, "session, settings, browser-visits");
        assert!(files.contains_key("session.json"));
        assert!(files.contains_key("userscripts/abcd.js"));
        assert!(!files.contains_key("browser-session-cookies.json"));
        assert!(!files.contains_key("logins.vault"));
        assert!(!files.contains_key("favicons/x.dataurl"));
        assert!(!files.keys().any(|k| k.ends_with(".tmp")));
    }

    /// Seal then decode then write into an empty destination: every scope and
    /// the nested body come back byte-for-byte, and the vault count survives.
    #[test]
    fn round_trips_byte_exact_through_seal_and_write() {
        let src = scratch("rt-src");
        seed_state(&src);
        let files = collect_files(&src).unwrap();
        let (bytes, summary) = seal(files, seed_vault(), "correct horse battery staple").unwrap();
        assert_eq!(summary.scopes, 3);
        assert_eq!(summary.passwords, 2);

        let file = scratch("rt-file").join("archive.tabverse");
        std::fs::write(&file, &bytes).unwrap();
        let (payload, s2) = decode(&file, "correct horse battery staple").unwrap();
        assert_eq!(s2.scopes, 3);
        assert_eq!(s2.passwords, 2);

        // Write into a fresh, empty destination (its parent holds the backup).
        let dst_state = scratch("rt-dst").join("state");
        write_payload(&dst_state, &payload, "20260811-000000").unwrap();
        assert_eq!(
            std::fs::read(dst_state.join("session.json")).unwrap(),
            br#"{"tabs":["a","b"]}"#
        );
        assert_eq!(
            std::fs::read(dst_state.join("userscripts").join("abcd.js")).unwrap(),
            b"marker();"
        );
        // The excluded things never arrive on the far side either.
        assert!(!dst_state.join("browser-session-cookies.json").exists());
        assert!(!dst_state.join("favicons").exists());
    }

    #[test]
    fn the_seal_hides_secrets_from_strings() {
        let src = scratch("seal-src");
        seed_state(&src);
        // A recognizable visited url in the history library.
        std::fs::write(
            src.join("browser-visits.json"),
            br#"{"version":1,"entries":[{"url":"https://secret.example/PLAINMARK","title":"MARKTITLE","at":1}]}"#,
        )
        .unwrap();
        let files = collect_files(&src).unwrap();
        let (bytes, _) = seal(files, seed_vault(), "correct horse battery staple").unwrap();
        for needle in [
            "hunter2secret",  // a vault password
            "s3cr3tpw",       // the other vault password
            "PLAINMARK",      // a visited url
            "MARKTITLE",      // a page title
            "gitlab.example", // a vault account host
        ] {
            assert!(
                !contains_bytes(&bytes, needle.as_bytes()),
                "archive leaked {needle:?} in the clear"
            );
        }
        // And it really does decode back — the secrets are sealed, not lost.
        let (payload, s) = decode(
            &{
                let f = scratch("seal-file").join("a.tabverse");
                std::fs::write(&f, &bytes).unwrap();
                f
            },
            "correct horse battery staple",
        )
        .unwrap();
        assert_eq!(s.passwords, 2);
        assert!(!payload.files.is_empty());
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    /// Build a valid archive on a file, hermetically. Import (and check) can
    /// then be exercised without the keychain, because the failure classes all
    /// resolve in `decode`, before the vault is ever touched.
    fn archive_file(tag: &str, passphrase: &str) -> PathBuf {
        let src = scratch(tag);
        seed_state(&src);
        let files = collect_files(&src).unwrap();
        let (bytes, _) = seal(files, seed_vault(), passphrase).unwrap();
        let file = scratch(&format!("{tag}-file")).join("a.tabverse");
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// A populated destination, and its fingerprint, to prove an untouched
    /// state after a refused import.
    fn populated_dst(tag: &str) -> (PathBuf, Vec<(String, Vec<u8>)>) {
        let dst = scratch(tag);
        std::fs::write(dst.join("session.json"), b"DESTINATION-STATE").unwrap();
        let fp = dir_fingerprint(&dst);
        (dst, fp)
    }

    #[test]
    fn wrong_passphrase_is_refused_with_zero_side_effects() {
        let file = archive_file("badpass", "the-right-one");
        let (dst_state, before) = populated_dst("badpass-dst");

        let err = import_bundle(&dst_state, &file, "the-WRONG-one", "20260811-010101").unwrap_err();
        assert!(
            err.contains("passphrase"),
            "message must name the cause: {err}"
        );
        // Nothing moved: the destination is byte-identical, and no backup dir
        // was created (the failure preceded any disk write).
        assert_eq!(
            before,
            dir_fingerprint(&dst_state),
            "state must be untouched"
        );
        assert!(
            !backup_dir(&dst_state, "20260811-010101").unwrap().exists(),
            "a refused import must not have started a backup"
        );
    }

    #[test]
    fn a_truncated_file_is_refused_with_zero_side_effects() {
        let file = archive_file("trunc", "pass");
        let whole = std::fs::read(&file).unwrap();
        // Cut the archive in half: enough header to look plausible, not enough
        // body to authenticate.
        std::fs::write(&file, &whole[..whole.len() / 2]).unwrap();
        let (dst_state, before) = populated_dst("trunc-dst");

        let err = import_bundle(&dst_state, &file, "pass", "20260811-020202").unwrap_err();
        assert!(
            err.contains("truncat") || err.contains("damaged") || err.contains("corrupt"),
            "truncation must be named: {err}"
        );
        assert_eq!(before, dir_fingerprint(&dst_state));
        assert!(!backup_dir(&dst_state, "20260811-020202").unwrap().exists());
    }

    #[test]
    fn an_unknown_version_is_refused_with_zero_side_effects() {
        let file = archive_file("ver", "pass");
        let mut whole = std::fs::read(&file).unwrap();
        // Bump the version byte to one this build does not read.
        whole[MAGIC.len()] = FORMAT_VERSION + 9;
        std::fs::write(&file, &whole).unwrap();
        let (dst_state, before) = populated_dst("ver-dst");

        let err = import_bundle(&dst_state, &file, "pass", "20260811-030303").unwrap_err();
        assert!(
            err.contains("version"),
            "the version gate must speak: {err}"
        );
        assert_eq!(before, dir_fingerprint(&dst_state));
        assert!(!backup_dir(&dst_state, "20260811-030303").unwrap().exists());
    }

    #[test]
    fn a_foreign_file_is_not_mistaken_for_an_archive() {
        let dst_state = scratch("foreign-dst");
        let file = scratch("foreign-file").join("notours.bin");
        std::fs::write(&file, b"this file belongs to some other program").unwrap();
        let err = check_bundle(&file, "whatever").unwrap_err();
        assert!(err.contains("not a Tabverse"), "{err}");
        // And import refuses the same way, touching nothing.
        assert!(import_bundle(&dst_state, &file, "whatever", "20260811-040404").is_err());
    }

    #[test]
    fn the_derived_key_is_deterministic_for_a_passphrase_and_salt() {
        let salt = [7u8; 16];
        let a = derive_key(b"hunter2", &salt, 8, 1, 1).unwrap();
        let b = derive_key(b"hunter2", &salt, 8, 1, 1).unwrap();
        assert_eq!(*a, *b, "same inputs, same key");
        let c = derive_key(b"hunter3", &salt, 8, 1, 1).unwrap();
        assert_ne!(*a, *c, "a different passphrase must not collide");
        let d = derive_key(b"hunter2", &[9u8; 16], 8, 1, 1).unwrap();
        assert_ne!(*a, *d, "a different salt must not collide");
    }

    /// The whole point of the seal: no secret survives as plaintext. A vault
    /// password, a history URL and the excluded cookie file's bytes are all
    /// present in the inputs — and none may appear anywhere in the export.
    #[test]
    fn no_secret_appears_in_the_export_as_plaintext() {
        let src = scratch("secrets-src");
        seed_state(&src);
        std::fs::write(
            src.join("browser-visits.json"),
            b"[{\"url\":\"https://secret-site.example/xyzzy\"}]",
        )
        .unwrap();
        let files = collect_files(&src).unwrap();
        let (bytes, _) = seal(files, seed_vault(), "pass").unwrap();

        for needle in [
            &b"secret-site.example"[..], // a history URL
            &b"hunter2secret"[..],       // a vault password value
            &b"s3cr3tpw"[..],            // another vault password value
            &b"SECRETCOOKIE"[..],        // the excluded cookie file's bytes
        ] {
            assert!(
                !contains(&bytes, needle),
                "a secret leaked into the export in the clear: {:?}",
                String::from_utf8_lossy(needle)
            );
        }
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    /// A cheap content fingerprint of a directory tree: relative path + bytes
    /// of every file, so any change to any file (or the set of files) shows.
    fn dir_fingerprint(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        fn go(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            let Ok(rd) = std::fs::read_dir(dir) else {
                return;
            };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    go(base, &p, out);
                } else if let Ok(b) = std::fs::read(&p) {
                    let rel = p.strip_prefix(base).unwrap().to_string_lossy().to_string();
                    out.push((rel, b));
                }
            }
        }
        go(dir, dir, &mut out);
        out.sort();
        out
    }
}
