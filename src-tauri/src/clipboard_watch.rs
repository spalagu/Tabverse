use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// One clip frame's ceiling, bytes. Past this the change is skipped —
/// logged, remembered, never sent — so a board-sized "copy" cannot turn
/// the share into a file channel.
pub(crate) const MAX_CLIP_BYTES: usize = 256 * 1024;

/// What one poll of the board amounts to. Pure — the pasteboard reads
/// happen in the loop, so this table is testable without a board.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PollAction {
    /// The count has not moved: nothing to read, nothing to send.
    Quiet,
    /// The count moved and the board carries a sendable string: the
    /// count to remember, the text to broadcast.
    Broadcast { count: i64, text: String },
    /// The count moved but nothing sendable is on it — no string, or
    /// over the cap: the count to remember, and why it was skipped.
    Skip { count: i64, why: &'static str },
}

/// The decision for one poll: the count last seen, the count now, and
/// the string the board carries. `None` stands both for "the caller did
/// not read one" (the count had not moved) and "the board has no
/// string" — the same decision either way, and callers only pay for the
/// read on a move.
pub(crate) fn decide(last: i64, now: i64, text: Option<&str>) -> PollAction {
    if now == last {
        return PollAction::Quiet;
    }
    match text {
        Some(t) if t.len() <= MAX_CLIP_BYTES => PollAction::Broadcast {
            count: now,
            text: t.to_string(),
        },
        Some(_) => PollAction::Skip {
            count: now,
            why: "over the frame cap",
        },
        None => PollAction::Skip {
            count: now,
            why: "no string on the board",
        },
    }
}

/// The running watcher, the PageProxy stop shape: [`ClipboardWatch::stop`]
/// sets the flag and joins. The loop sleeps in half-second steps and is
/// never parked anywhere a flag cannot reach, so stop returns within one
/// interval. Idempotent.
pub(crate) struct ClipboardWatch {
    shutdown: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ClipboardWatch {
    /// Watch the general pasteboard; every sendable change calls
    /// `broadcast` with the board's string. The thread holds whatever the
    /// closure captures for as long as it runs — only [`ClipboardWatch::stop`]
    /// releases it, which is why every start pairs with a stop.
    pub(crate) fn start(broadcast: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        let shutdown = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&shutdown);
        let thread = std::thread::Builder::new()
            .name("tabverse-clipboard-watch".into())
            .spawn(move || watch_loop(flag, broadcast))
            .expect("spawning the clipboard watcher cannot fail for a reason the app could act on");
        Self {
            shutdown,
            thread: Some(thread),
        }
    }

    /// Ask the loop to stop and wait for it. A second stop is nothing.
    pub(crate) fn stop(&mut self) {
        let Some(thread) = self.thread.take() else {
            return;
        };
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = thread.join();
    }
}

/// The loop the thread runs: sleep, look, and on a count move let the
/// pure table decide. The first look only sets the baseline (see the
/// module doc); every later one compares against the last decision.
fn watch_loop(shutdown: Arc<AtomicBool>, broadcast: Arc<dyn Fn(&str) + Send + Sync>) {
    let board = pasteboard();
    let mut last = read_count(&board);
    loop {
        std::thread::sleep(POLL_INTERVAL);
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        let now = read_count(&board);
        if now == last {
            continue;
        }
        // The count moved, so reading the string is worth its cost.
        match decide(last, now, read_string(&board).as_deref()) {
            PollAction::Quiet => {}
            PollAction::Broadcast { count, text } => {
                last = count;
                broadcast(&text);
            }
            PollAction::Skip { count, why } => {
                last = count;
                eprintln!("[core] clipboard change skipped: {why}");
            }
        }
    }
}

/// Write one joiner-pushed string onto the board — the `WriteClipboard`
/// seam's body, what a ClipPush becomes on the host. The write bumps the
/// changeCount and the watcher echoes it out to every viewer; that is
/// the channel working, not a loop (the module doc says why).
pub(crate) fn put_string(text: &str) {
    if let Err(e) = write_string(&pasteboard(), text) {
        eprintln!("[core] clip push refused by the pasteboard: {e}");
    }
}

// ----------------------------------------------------------------- macOS

/// The pasteboard under watch: the general one, shared with every other
/// app — the whole point is that ANY app's copy reaches the joiner.
/// Tests pass a private name instead, so a test run never wipes whatever
/// the user is carrying.
#[cfg(target_os = "macos")]
fn pasteboard() -> objc2::rc::Retained<objc2_app_kit::NSPasteboard> {
    objc2_app_kit::NSPasteboard::generalPasteboard()
}

/// The board's change counter — the one fact a watcher needs, and the
/// one read that never touches contents.
#[cfg(target_os = "macos")]
fn read_count(board: &objc2_app_kit::NSPasteboard) -> i64 {
    board.changeCount() as i64
}

/// The board's string, if it carries one. `NSPasteboardTypeString` is a
/// framework constant behind an extern static; the unsafe is that
/// one-line link-time constant, nothing runtime-conditioned.
#[cfg(target_os = "macos")]
fn read_string(board: &objc2_app_kit::NSPasteboard) -> Option<String> {
    use objc2_app_kit::NSPasteboardTypeString;
    board
        .stringForType(unsafe { NSPasteboardTypeString })
        .map(|s| s.to_string())
}

/// The write itself: `clearContents` then `setString:forType:` — the
/// text pair, the same clear-then-write shape file_clipboard's file
/// URLs take.
#[cfg(target_os = "macos")]
fn write_string(board: &objc2_app_kit::NSPasteboard, text: &str) -> Result<(), String> {
    use objc2_app_kit::NSPasteboardTypeString;
    use objc2_foundation::NSString;
    board.clearContents();
    if board.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }) {
        Ok(())
    } else {
        Err("the pasteboard refused the string".into())
    }
}

// ------------------------------------------------------ Windows and Linux

#[cfg(not(target_os = "macos"))]
struct UnsupportedPasteboard;

#[cfg(not(target_os = "macos"))]
fn pasteboard() -> UnsupportedPasteboard {
    UnsupportedPasteboard
}

#[cfg(not(target_os = "macos"))]
fn read_count(_board: &UnsupportedPasteboard) -> i64 {
    0
}

#[cfg(not(target_os = "macos"))]
fn read_string(_board: &UnsupportedPasteboard) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
fn write_string(_board: &UnsupportedPasteboard, _text: &str) -> Result<(), String> {
    Err("the clipboard channel is not built for this platform yet".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn a_quiet_board_sends_nothing_whatever_it_holds() {
        assert_eq!(decide(7, 7, None), PollAction::Quiet);
        // The caller never reads a string on a quiet poll; the table
        // must not care if one arrives anyway.
        assert_eq!(decide(7, 7, Some("text")), PollAction::Quiet);
    }

    #[test]
    fn a_moved_count_with_a_string_broadcasts_it() {
        assert_eq!(
            decide(7, 8, Some("copied")),
            PollAction::Broadcast {
                count: 8,
                text: "copied".into()
            }
        );
    }

    #[test]
    fn the_cap_bounds_a_frame_on_both_sides() {
        let at_cap = "x".repeat(MAX_CLIP_BYTES);
        assert_eq!(
            decide(0, 1, Some(&at_cap)),
            PollAction::Broadcast {
                count: 1,
                text: at_cap.clone()
            }
        );
        let over = format!("{at_cap}x");
        assert_eq!(
            decide(0, 2, Some(&over)),
            PollAction::Skip {
                count: 2,
                why: "over the frame cap"
            }
        );
    }

    #[test]
    fn a_moved_count_with_no_string_is_remembered_and_skipped() {
        assert_eq!(
            decide(7, 9, None),
            PollAction::Skip {
                count: 9,
                why: "no string on the board"
            }
        );
    }

    /// Lifecycle smoke on a real thread: stop joins (a stop that never
    /// reached the loop would hang the test), and the whole
    /// start/stop/restart cycle is repeatable. Nothing is asserted about
    /// broadcasts — the general board belongs to the user, and the two
    /// ignored tests below are where the real board speaks.
    #[test]
    fn the_watch_starts_stops_and_starts_again() {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let mut watch =
            ClipboardWatch::start(Arc::new(move |t| s.lock().unwrap().push(t.to_string())));
        watch.stop();
        // A second stop is nothing, and a fresh watch can follow.
        watch.stop();
        let s2 = seen.clone();
        let mut watch =
            ClipboardWatch::start(Arc::new(move |t| s2.lock().unwrap().push(t.to_string())));
        watch.stop();
    }

    /// The write half, on a private board: the string lands readable, and
    /// the count — the watcher's one trigger — moves with it.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_write_lands_a_readable_string_and_moves_the_count() {
        use objc2_app_kit::NSPasteboard;
        use objc2_foundation::NSString;
        let board = NSPasteboard::pasteboardWithName(&NSString::from_str("tabverse-test-clip"));
        let before = board.changeCount();
        write_string(&board, "hello clip").expect("write");
        assert_eq!(read_string(&board).as_deref(), Some("hello clip"));
        assert!(
            board.changeCount() > before,
            "the write must move the count the watcher walks"
        );
    }

    #[test]
    #[ignore = "writes the user's real clipboard; run with --ignored"]
    fn e2_a_write_round_trips_through_the_watch_within_a_second() {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let mut watch =
            ClipboardWatch::start(Arc::new(move |t| s.lock().unwrap().push(t.to_string())));
        std::thread::sleep(std::time::Duration::from_millis(250));
        put_string("tabverse clipboard watch e2e");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !seen
            .lock()
            .unwrap()
            .iter()
            .any(|t| t == "tabverse clipboard watch e2e")
        {
            assert!(
                std::time::Instant::now() < deadline,
                "the watcher never reported the write: {:?}",
                seen.lock().unwrap()
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        watch.stop();
    }
}
