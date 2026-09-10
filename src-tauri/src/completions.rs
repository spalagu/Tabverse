use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::AppHandle;

/// The ceiling one fetched spec may carry. The bundled snapshot is a few
/// tens of kilobytes; a document worth calling a completion spec has no
/// business being a hundred times that, and the one that is has something
/// else inside it.
const MAX_SPEC_BYTES: usize = 2 * 1024 * 1024;

/// The fetch deadline, shared with the userscript installer's URL fetch.
const FETCH_TIMEOUT_SECS: u64 = 30;

/// Where the state directory holds the spec: `<state>/completions/spec.json`
/// (a directory of its own, the way userscripts' bodies have one).
fn spec_file(dir: &Path) -> PathBuf {
    dir.join("completions").join("spec.json")
}

/// Read the state-directory copy. `Ok(None)` is "never updated" — a normal
/// first launch, not an error. Exposed to the commands as a plain function
/// so the tests can point it at a temp dir.
fn read_spec(dir: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(spec_file(dir)) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read the completion spec: {e}")),
    }
}

/// Write the state-directory copy, staged through a `.tmp` and renamed into
/// place — the state doorway's own rule (crates/tabverse-fs/src/state.rs),
/// so a crash mid-write leaves the previous good spec, never a half of one.
fn write_spec(dir: &Path, text: &str) -> Result<(), String> {
    let dest = spec_file(dir);
    let parent = dest
        .parent()
        .ok_or_else(|| "the spec path has no directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let tmp = dest.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &dest).map_err(|e| format!("cannot replace {}: {e}", dest.display()))?;
    Ok(())
}

/// Judge a fetched document before it is allowed near the state directory.
///
/// The same bar the interface's `parseSpec` applies — shaped like a spec,
/// not complete: an object carrying a string `version` and an array
/// `commands`. Returns the version on success (it is what the caller
/// reports back), the reason on refusal. Nothing here validates the
/// document as JSON first: `serde_json::from_str` does, and the error it
/// gives is the honest one.
fn validate_spec(text: &str) -> Result<String, String> {
    if text.len() > MAX_SPEC_BYTES {
        return Err(format!(
            "the spec is {:.1} MB, over the {} MB an update may carry",
            text.len() as f64 / (1024.0 * 1024.0),
            MAX_SPEC_BYTES / (1024 * 1024)
        ));
    }
    let doc: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("the file is not JSON: {e}"))?;
    let obj = doc
        .as_object()
        .ok_or_else(|| "the spec is not a JSON object".to_string())?;
    let version = obj
        .get("version")
        .ok_or_else(|| "the spec carries no version".to_string())?
        .as_str()
        .ok_or_else(|| "the spec's version is not text".to_string())?
        .to_string();
    if version.is_empty() {
        return Err("the spec's version is empty".to_string());
    }
    obj.get("commands")
        .ok_or_else(|| "the spec carries no commands".to_string())?
        .as_array()
        .ok_or_else(|| "the spec's commands are not a list".to_string())?;
    Ok(version)
}

/// The HTTP client the fetch goes out on — the userscript installer's
/// builder, with the one difference that a spec fetch is a short document
/// retrieval and takes a deadline rather than holding a long poll open.
fn spec_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            crate::http::build(crate::http::Spec {
                user_agent: Some(crate::BROWSER_UA),
                timeout: None,
                connect_timeout: None,
            })
            .ok()
        })
        .as_ref()
}

/// The update command's answer: what the new spec calls itself.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CompletionUpdate {
    pub version: String,
}

/// The state-directory copy's text, or `None` when none was ever written.
///
#[tauri::command]
pub async fn completions_get(app: AppHandle) -> Result<Option<String>, String> {
    let dir = crate::state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_spec(&dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Fetch a spec from `url` and make it the active one.
///
/// The userscript URL installer's shape (30 s timeout, byte cap while
/// streaming, http(s) only, first-party fetch), then the shape gate
/// [`validate_spec`] before anything is stored in the state directory.
#[tauri::command]
pub async fn completions_update(app: AppHandle, url: String) -> Result<CompletionUpdate, String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) urls can update the completion spec".into());
    }
    let client = spec_client().ok_or("http client unavailable")?;
    let resp = client
        .get(parsed)
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the server answered {}", resp.status()));
    }
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if buf.len() > MAX_SPEC_BYTES {
                    return Err(format!(
                        "the spec is over {} MB, more than an update may carry",
                        MAX_SPEC_BYTES / (1024 * 1024)
                    ));
                }
            }
            Ok(None) => break,
            Err(e) => return Err(format!("read failed: {e}")),
        }
    }
    let text = String::from_utf8(buf).map_err(|_| "the file is not UTF-8 text".to_string())?;
    let version = validate_spec(&text)?;
    let dir = crate::state_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_spec(&dir, &text))
        .await
        .map_err(|e| e.to_string())??;
    eprintln!("[completions] updated to version {version}");
    Ok(CompletionUpdate { version })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tabverse-completions-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn spec(version: &str) -> String {
        format!(
            r#"{{"version": "{version}", "commands": [], "files": {{"patterns": [], "extensions": []}}}}"#
        )
    }

    /// The state-directory half: write, read, and the replace that never
    /// leaves a half-written spec behind (the .tmp is renamed, not edited
    /// in place — a crash between the two leaves the old copy).
    #[test]
    fn the_state_copy_roundtrips_and_overwrites_atomically() {
        let dir = temp_dir("roundtrip");
        assert_eq!(read_spec(&dir).unwrap(), None, "never updated is None");

        write_spec(&dir, &spec("2026-08-17")).unwrap();
        assert_eq!(
            read_spec(&dir).unwrap().as_deref(),
            Some(spec("2026-08-17").as_str())
        );

        write_spec(&dir, &spec("2026-09-01")).unwrap();
        assert_eq!(
            read_spec(&dir).unwrap().as_deref(),
            Some(spec("2026-09-01").as_str())
        );
        assert!(
            !spec_file(&dir).with_extension("json.tmp").exists(),
            "a finished write leaves no scratch behind"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The shape gate: each refusal names what was wrong, and only a
    /// document that can be asked something passes.
    #[test]
    fn the_shape_gate_refuses_documents_it_cannot_ask_anything_of() {
        assert!(validate_spec("not json at all").is_err());
        assert!(validate_spec("[1, 2, 3]").is_err());
        assert!(validate_spec(r#"{"commands": []}"#).is_err(), "no version");
        assert!(validate_spec(r#"{"version": 7, "commands": []}"#).is_err());
        assert!(
            validate_spec(r#"{"version": ""}"#).is_err(),
            "empty version"
        );
        assert!(
            validate_spec(r#"{"version": "2026-08-17"}"#).is_err(),
            "no commands"
        );
        assert_eq!(
            validate_spec(&spec("2026-08-17")).unwrap(),
            "2026-08-17",
            "the version comes back on success"
        );
    }

    /// The byte cap, judged on the same string the streamed fetch would
    /// have refused mid-download.
    #[test]
    fn an_oversized_document_is_refused_before_it_is_stored() {
        let mut big = r#"{"version": "2026-08-17", "commands": [], "pad": ""#.to_string();
        while big.len() <= MAX_SPEC_BYTES {
            big.push_str("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        }
        let err = validate_spec(&(big + "\"}")).unwrap_err().to_string();
        assert!(err.contains("MB"), "the refusal names the limit: {err}");
    }
}
