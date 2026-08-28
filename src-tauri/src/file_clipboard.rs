#[tauri::command]
pub fn clipboard_write_files(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing was selected to copy".into());
    }
    put_file_urls(&paths)
}

// ----------------------------------------------------------------- macOS

#[cfg(target_os = "macos")]
fn put_file_urls(paths: &[String]) -> Result<(), String> {
    let board = pasteboard();
    write_file_urls(&board, paths)
}

/// The pasteboard the command writes: the general one, shared with every
/// other app. Tests pass a private name instead, so a test run never wipes
/// whatever the user is carrying.
#[cfg(target_os = "macos")]
fn pasteboard() -> objc2::rc::Retained<objc2_app_kit::NSPasteboard> {
    objc2_app_kit::NSPasteboard::generalPasteboard()
}

/// The write itself. `clearContents` then `writeObjects:` with NSURLs is
/// the modern pair; AppKit puts public.file-url (plus the file's own type)
/// on the board for each URL, which is what Finder's paste consumes.
#[cfg(target_os = "macos")]
fn write_file_urls(board: &objc2_app_kit::NSPasteboard, paths: &[String]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::NSPasteboardWriting;
    use objc2_foundation::{NSArray, NSString, NSURL};

    let urls: Vec<Retained<NSURL>> = paths
        .iter()
        .map(|p| NSURL::fileURLWithPath(&NSString::from_str(p)))
        .collect();
    let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = urls
        .into_iter()
        .map(ProtocolObject::from_retained)
        .collect();
    board.clearContents();
    if board.writeObjects(&NSArray::from_retained_slice(&objects)) {
        Ok(())
    } else {
        Err("the pasteboard refused the file URLs".into())
    }
}

// ------------------------------------------------------ Windows and Linux

#[cfg(windows)]
fn put_file_urls(paths: &[String]) -> Result<(), String> {
    let _ = paths;
    Err("copying files to the clipboard is not built for Windows yet".into())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn put_file_urls(paths: &[String]) -> Result<(), String> {
    let _ = paths;
    Err("copying files to the clipboard is not built for Linux yet".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString};

    /// The type a file URL carries — matched as a substring because the
    /// pasteboard reports each URL's type among several.
    const FILE_URL: &str = "public.file-url";

    fn private(name: &str) -> Retained<NSPasteboard> {
        NSPasteboard::pasteboardWithName(&NSString::from_str(name))
    }

    fn types_of(board: &NSPasteboard) -> Vec<String> {
        board
            .types()
            .map(|ts| ts.iter().map(|t| t.to_string()).collect())
            .unwrap_or_default()
    }

    #[test]
    fn the_pasteboard_carries_file_urls_not_text() {
        let board = private("tabverse-test-file-urls");
        write_file_urls(
            &board,
            &["/System/Library/CoreServices/SystemVersion.plist".into()],
        )
        .expect("write");
        let types = types_of(&board);
        assert!(
            types.iter().any(|t| t.contains(FILE_URL)),
            "no file-URL type after the write; board holds {types:?}"
        );
    }

    #[test]
    fn a_text_write_leaves_no_file_url_type() {
        // The control that makes the assertion above discriminating: the
        // same writeObjects call with an NSString (what a text-URL
        // implementation would put up) leaves NO file-URL type. Mutate
        // write_file_urls to write strings and the first test goes red
        // while this one stays green — the pair tells the shapes apart.
        let board = private("tabverse-test-text-control");
        let strings = vec![NSString::from_str("/tmp/not-a-file-url.txt")];
        let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = strings
            .into_iter()
            .map(ProtocolObject::from_retained)
            .collect();
        board.clearContents();
        board.writeObjects(&NSArray::from_retained_slice(&objects));
        let types = types_of(&board);
        assert!(
            !types.iter().any(|t| t.contains(FILE_URL)),
            "a string write somehow announced {FILE_URL}; board holds {types:?}"
        );
    }

    #[test]
    #[ignore = "writes the user's real clipboard; run with --ignored"]
    fn e1_the_general_pasteboard_reads_as_files_to_other_processes() {
        let tmp = std::env::temp_dir().join("tabverse-clipboard-e1.txt");
        std::fs::write(&tmp, "e1").expect("write the probe file");
        put_file_urls(&[tmp.to_string_lossy().to_string()]).expect("paste");

        let out = std::process::Command::new("osascript")
            .arg("-e")
            .arg("clipboard info")
            .output()
            .expect("run osascript");
        assert!(out.status.success(), "osascript failed: {out:?}");
        let info = String::from_utf8_lossy(&out.stdout);
        // «class furl» is how AppleScript reports the file-URL flavor.
        assert!(
            info.contains("«class furl»"),
            "the system clipboard did not report file URLs; it said: {info}"
        );
    }
}
