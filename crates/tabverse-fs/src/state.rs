use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

/// Hard ceiling for one scope's payload. A runaway serializer (a snapshot
/// accidentally embedding scrollback, a state loop appending forever) must
/// hit a clear error instead of quietly filling the disk on every save.
pub const MAX_STATE_BYTES: usize = 8 * 1024 * 1024;

/// Longest accepted scope name. Scopes are short structured ids the UI makes
/// up (`files:abc123`); anything longer is a caller bug, and the cap keeps
/// every encoded filename comfortably under platform name limits.
pub const MAX_SCOPE_LEN: usize = 120;

/// A scope must match `[A-Za-z0-9:_-]{1,120}`. Scopes become filenames, so
/// this is rejected loudly instead of sanitized: a scope with a `/` or `..`
/// in it is not a state key with an unfortunate spelling, it is a bug (or an
/// attempted traversal), and silently mangling it would let two different
/// buggy scopes collide on one file.
fn validate_scope(scope: &str) -> Result<()> {
    if scope.is_empty() || scope.len() > MAX_SCOPE_LEN {
        return Err(anyhow!(
            "scope must be 1..={MAX_SCOPE_LEN} chars, got {}",
            scope.len()
        ));
    }
    if let Some(bad) = scope
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-')))
    {
        return Err(anyhow!(
            "scope {scope:?} contains {bad:?}; allowed: A-Z a-z 0-9 : _ -"
        ));
    }
    Ok(())
}

const FILE_EXT: &str = ".json";
const TMP_EXT: &str = ".json.tmp";

/// Encode a scope name into a filename that round-trips exactly.
///
/// Scope names carry `:` by convention (`files:abc:123`), which is legal on
/// macOS/Linux but not in Windows filenames, so it must not reach the
/// filesystem literally. Percent-encoding every byte outside `[A-Za-z0-9._-]`
/// (including `%` itself, so encoding stays injective) keeps the name
/// readable for the common case, Windows-safe, and exactly reversible —
/// and stays correct even if the validated charset ever widens.
fn encode_scope(scope: &str) -> String {
    let mut out = String::with_capacity(scope.len());
    for b in scope.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Reverse [`encode_scope`]. `None` for names this module never produced
/// (stray `%` not followed by two hex digits, or bytes that are not UTF-8),
/// so foreign files in the state directory are skipped rather than invented
/// as scopes.
fn decode_scope(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn scope_file(base: &Path, scope: &str) -> PathBuf {
    base.join(format!("{}{FILE_EXT}", encode_scope(scope)))
}

fn tmp_file(base: &Path, scope: &str) -> PathBuf {
    // The scratch name carries this process id. Without it two processes
    // saving the same scope truncate and write over one scratch file, and
    // what gets renamed into place is neither payload. A configuration file
    // on a real machine was found in exactly that state — a line reading
    // ` 278` with the key name gone — which is what sent us looking here.
    base.join(format!(
        "{}.{}{TMP_EXT}",
        encode_scope(scope),
        std::process::id()
    ))
}

/// Persist one scope's JSON payload atomically.
///
/// The bytes go to `<file>.json.tmp` first and only a `rename` publishes
/// them: rename within one directory is atomic on every platform we ship,
/// so a crash mid-write leaves at worst a stale `.tmp` next to the previous
/// good file — never a truncated state file that a later load would parse as
/// garbage. The scratch name is per-process, so two windows saving at once
/// cannot write over each other's half-written bytes; a failed write removes
/// its own scratch rather than leaving one per crash.
pub fn save(base: &Path, scope: &str, json: &str) -> Result<()> {
    validate_scope(scope)?;
    if json.len() > MAX_STATE_BYTES {
        return Err(anyhow!(
            "state for scope \"{scope}\" is {} bytes, above the {} MiB limit",
            json.len(),
            MAX_STATE_BYTES / (1024 * 1024)
        ));
    }
    std::fs::create_dir_all(base)
        .with_context(|| format!("cannot create state dir {}", base.display()))?;
    let tmp = tmp_file(base, scope);
    let dest = scope_file(base, scope);
    if let Err(e) = std::fs::write(&tmp, json.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("cannot write {}", tmp.display()));
    }
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("cannot replace {}", dest.display()));
    }
    sweep_abandoned_scratch(base);
    Ok(())
}

/// How long a scratch file must sit untouched before a later save removes it.
///
/// Per-process scratch names mean a crashed run's file is no longer renamed
/// away by the next save, so it needs collecting some other way. A day is far
/// longer than any write takes and far shorter than "forever": a file this old
/// belongs to a process that is not coming back, while one being written right
/// now is seconds old and never in danger.
const ABANDONED_SCRATCH: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Remove scratch files no live write could still be using. Failures are
/// ignored on purpose — tidying is not worth failing a save that succeeded.
fn sweep_abandoned_scratch(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.to_string_lossy().ends_with(TMP_EXT) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age > ABANDONED_SCRATCH {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Load one scope's payload. `None` when the scope was never saved (or was
/// deleted) — that is a normal first launch, not an error. A stale `.tmp`
/// from an interrupted write is never read: only the renamed-into-place file
/// counts.
pub fn load(base: &Path, scope: &str) -> Result<Option<String>> {
    // Same gate as save: an invalid scope can never have been saved, so
    // erroring here surfaces the caller bug instead of masquerading as a
    // normal "first launch" None.
    validate_scope(scope)?;
    match std::fs::read_to_string(scope_file(base, scope)) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow!("cannot read state for scope \"{scope}\": {e}")),
    }
}

/// Remove one scope's file; a scope that never existed is already deleted.
/// Any stale `.tmp` for the scope goes too, so delete really means gone.
pub fn delete(base: &Path, scope: &str) -> Result<()> {
    validate_scope(scope)?;
    let _ = std::fs::remove_file(tmp_file(base, scope));
    match std::fs::remove_file(scope_file(base, scope)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow!("cannot delete state for scope \"{scope}\": {e}")),
    }
}

/// Every stored scope name, decoded back to the exact strings that were
/// saved — this is what startup orphan-GC diffs against the live tab list.
/// A base dir that does not exist yet simply has no scopes.
pub fn list(base: &Path) -> Result<Vec<String>> {
    let rd = match std::fs::read_dir(base) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(anyhow!("cannot list state dir {}: {e}", base.display())),
    };
    let mut out = Vec::new();
    for dent in rd.flatten() {
        let name = dent.file_name().to_string_lossy().to_string();
        // A stale `.tmp` from an interrupted write ends in ".tmp", so the
        // suffix check below skips it along with any foreign clutter.
        let Some(stem) = name.strip_suffix(FILE_EXT) else {
            continue;
        };
        // Only scopes the other entry points would accept: orphan-GC feeds
        // every listed name straight into delete(), so a foreign file that
        // decodes to an invalid scope (say `a.b.json`) must be skipped here,
        // not returned as a scope no call can ever act on.
        if let Some(scope) = decode_scope(stem) {
            if validate_scope(&scope).is_ok() {
                out.push(scope);
            }
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("tabverse-state-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        base
    }

    /// The scope shape the UI actually uses (`files:abc:123`) must round-trip
    /// byte-exact through save → load → list, with the `:` kept out of the
    /// on-disk filename (it is not legal in Windows names).
    #[test]
    fn valid_scope_roundtrips_and_colon_stays_out_of_filenames() {
        let base = temp_base("roundtrip");
        let scope = "files:abc:123";
        save(&base, scope, r#"{"v":1}"#).unwrap();

        assert_eq!(load(&base, scope).unwrap().as_deref(), Some(r#"{"v":1}"#));
        assert_eq!(list(&base).unwrap(), vec![scope.to_string()]);
        for dent in std::fs::read_dir(&base).unwrap().flatten() {
            let name = dent.file_name().to_string_lossy().to_string();
            assert!(!name.contains(':'), "{name:?} would be illegal on Windows");
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Scopes become filenames, so anything outside `[A-Za-z0-9:_-]{1,120}`
    /// is a caller bug (or a traversal attempt) and must be rejected loudly —
    /// by every scope-taking entry point, and without touching the disk.
    #[test]
    fn invalid_scopes_are_rejected_everywhere_and_write_nothing() {
        let base = temp_base("invalid");
        let bad = [
            "",
            "../escape",
            "a/b",
            "a\\b",
            "a.b",
            "sp ace",
            "percent%41",
            "emoji💥",
            &"x".repeat(MAX_SCOPE_LEN + 1),
        ];
        for scope in bad {
            assert!(save(&base, scope, "{}").is_err(), "save accepted {scope:?}");
            assert!(load(&base, scope).is_err(), "load accepted {scope:?}");
            assert!(delete(&base, scope).is_err(), "delete accepted {scope:?}");
        }
        assert!(
            !base.exists(),
            "a rejected save must not even create the dir"
        );

        // The full allowed alphabet and the full allowed length are fine.
        let edge = "AZaz09:_-";
        save(&base, edge, "{}").unwrap();
        assert_eq!(load(&base, edge).unwrap().as_deref(), Some("{}"));
        save(&base, &"x".repeat(MAX_SCOPE_LEN), "{}").unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn overwrite_replaces_and_missing_scope_is_none() {
        let base = temp_base("overwrite");
        assert_eq!(load(&base, "tabs").unwrap(), None, "unsaved scope is None");
        save(&base, "tabs", "old").unwrap();
        save(&base, "tabs", "new").unwrap();
        assert_eq!(load(&base, "tabs").unwrap().as_deref(), Some("new"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_removes_and_tolerates_absence() {
        let base = temp_base("delete");
        save(&base, "gone", "x").unwrap();
        delete(&base, "gone").unwrap();
        assert_eq!(load(&base, "gone").unwrap(), None);
        assert!(list(&base).unwrap().is_empty());
        // Deleting again (or a scope that never existed) is not an error.
        delete(&base, "gone").unwrap();
        delete(&base, "never-was").unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn list_returns_all_scopes_sorted_and_skips_foreign_files() {
        let base = temp_base("list");
        save(&base, "b:2", "x").unwrap();
        save(&base, "a:1", "x").unwrap();
        // Files this module never wrote must not be invented as scopes —
        // including a .json whose name decodes to a scope that save/delete
        // would reject (orphan-GC must never list what it cannot delete).
        std::fs::write(base.join("notes.txt"), "clutter").unwrap();
        std::fs::write(base.join("%zz-bad-encoding.json"), "clutter").unwrap();
        std::fs::write(base.join("a.b.json"), "clutter").unwrap();
        assert_eq!(
            list(&base).unwrap(),
            vec!["a:1".to_string(), "b:2".to_string()]
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn oversize_payload_is_rejected_and_writes_nothing() {
        let base = temp_base("oversize");
        let big = "x".repeat(MAX_STATE_BYTES + 1);
        let err = save(&base, "huge", &big).unwrap_err().to_string();
        assert!(err.contains("8 MiB"), "error must name the limit: {err}");
        assert_eq!(load(&base, "huge").unwrap(), None, "nothing may be written");
        // At the limit exactly is still fine.
        let ok = "x".repeat(MAX_STATE_BYTES);
        save(&base, "huge", &ok).unwrap();
        assert_eq!(
            load(&base, "huge").unwrap().map(|s| s.len()),
            Some(MAX_STATE_BYTES)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A crash between "write .tmp" and "rename" leaves a stale `.tmp` beside
    /// the previous good file. Load must keep returning the good value, list
    /// must not report a phantom scope, and the next save must leave no
    /// `.tmp` behind.
    #[test]
    fn a_scratch_file_old_enough_to_be_abandoned_is_collected() {
        // The other half of the trade: leftovers do get taken, just by age
        // rather than by the next save reusing the name. Backdating the file
        // is the only way to test this without waiting a day.
        let base = temp_base("abandoned");
        let scope = "session";
        save(&base, scope, "good").unwrap();
        let orphan = base.join(format!("{}.99999{}", super::encode_scope(scope), TMP_EXT));
        std::fs::write(&orphan, "from a run that died").unwrap();
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60);
        filetime::set_file_mtime(&orphan, filetime::FileTime::from_system_time(long_ago))
            .expect("backdate the orphan");

        save(&base, scope, "newer").unwrap();

        assert!(!orphan.exists(), "a day-old scratch file was not collected");
        assert_eq!(load(&base, scope).unwrap().as_deref(), Some("newer"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn interrupted_write_keeps_good_state_and_a_live_scratch_is_left_alone() {
        let base = temp_base("interrupted");
        let scope = "session";
        save(&base, scope, "good").unwrap();

        // Simulate the crash: a half-written temp file appears next to the
        // published state, exactly where save() stages its writes.
        let stale = base.join(format!("{}{}", super::encode_scope(scope), TMP_EXT));
        std::fs::write(&stale, "half-writ").unwrap();

        assert_eq!(load(&base, scope).unwrap().as_deref(), Some("good"));
        assert_eq!(list(&base).unwrap(), vec![scope.to_string()]);

        save(&base, scope, "newer").unwrap();
        assert_eq!(load(&base, scope).unwrap().as_deref(), Some("newer"));
        // The stale file is still there, and that is the trade this makes.
        // Scratch names carry the process id now, so a save no longer renames
        // another run's leftover away — the price of two windows not being
        // able to write over each other's half-written bytes. What collects it
        // instead is age: `sweep_abandoned_scratch` takes files a day old,
        // which no live write ever is. Correctness never depended on the
        // sweep, only tidiness: the two assertions above are the ones that
        // matter, and they hold with the file sitting right there.
        assert!(
            stale.exists(),
            "a fresh scratch file must survive — a live write is seconds old"
        );
        assert_eq!(load(&base, scope).unwrap().as_deref(), Some("newer"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
