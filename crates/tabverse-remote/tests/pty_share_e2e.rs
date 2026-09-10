//! Headless end-to-end test of remote control over a real PTY and real iroh.
//!
//! Mirrors exactly what the desktop app does — real shell, ordered dispatch,
//! snapshot-at-join, viewer input — with a test double standing in for the
//! webview. This is the check that survives a locked screen or a CI box with
//! no display, where a GUI run cannot even execute JavaScript.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tabverse_proto::{Access, RemoteClientMsg, RemoteHostMsg, SharedTabType, REMOTE_ALPN};
use tabverse_remote::source::terminal::TerminalSource;
use tabverse_remote::{
    join, join_as, read_frame, write_frame, InputOutcome, InputPayload, LocalSink, RemoteHub,
    SessionBridge, ShareBinding, ShareOpts, ShareSource, ShareTicket, SourceRegistry, ViewerId,
    Viewport,
};
use tabverse_term::{SessionManager, SpawnOpts};

/// A shell this platform actually has. Hard-coding `/bin/sh` kept the whole
/// end-to-end check from running on Windows, where the app ships an installer.
fn probe_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        "/bin/sh".into()
    }
}

/// Carriage return is what a terminal sends for Return under ConPTY; a bare
/// newline leaves the line sitting unexecuted at the PowerShell prompt.
fn eol() -> &'static str {
    if cfg!(windows) {
        "\r\n"
    } else {
        "\n"
    }
}

/// `echo <label>_<a*b>`, spelled for this platform's shell.
///
/// The arithmetic carries the meaning: a viewer seeing `A_RESULT_15` proves a
/// real shell evaluated the line, where seeing `A_RESULT_$((3*5))` would only
/// prove bytes were echoed back. POSIX and PowerShell differ just in spelling.
fn echo_product(label: &str, a: u32, b: u32) -> Vec<u8> {
    if cfg!(windows) {
        format!("echo {label}_$({a}*{b}){}", eol()).into_bytes()
    } else {
        format!("echo {label}_$(({a}*{b})){}", eol()).into_bytes()
    }
}

/// `echo <text>` with the same line-ending rule.
fn echo_literal(text: &str) -> Vec<u8> {
    format!("echo {text}{}", eol()).into_bytes()
}

/// Stands in for the webview: accumulates output and answers snapshot requests
/// with everything seen so far (semantically what xterm's serialize gives us).
type PtyReply = Box<dyn Fn(&[u8]) + Send>;
type PtyWriter = Box<dyn Fn(&[u8]) + Send + Sync>;

struct FakeView {
    seen: Mutex<Vec<u8>>,
    share: Mutex<Option<Arc<tabverse_remote::Share>>>,
    /// Writes back into the PTY, the way a terminal answers the shell.
    reply: Mutex<Option<PtyReply>>,
}

impl FakeView {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            share: Mutex::new(None),
            reply: Mutex::new(None),
        })
    }
    fn set_share(&self, share: Arc<tabverse_remote::Share>) {
        *self.share.lock().unwrap() = Some(share);
    }
    fn set_reply(&self, reply: PtyReply) {
        *self.reply.lock().unwrap() = Some(reply);
    }
}

impl LocalSink for FakeView {
    fn data(&self, bytes: &[u8]) {
        self.seen.lock().unwrap().extend_from_slice(bytes);
        // Answer the shell's cursor-position report, which is a thing a
        // terminal does and this stand-in therefore has to do too.
        //
        // PowerShell asks (`ESC[6n`) before it draws anything and blocks until
        // something answers; xterm.js answers in the app. Unanswered, the
        // shell never reaches a prompt, never runs the command, and every
        // assertion below times out on output that was never going to come.
        // POSIX shells never ask, which is why this was invisible until the
        // suite first ran on Windows.
        if bytes.windows(4).any(|w| w == b"\x1b[6n") {
            if let Some(reply) = self.reply.lock().unwrap().as_ref() {
                reply(b"\x1b[1;1R");
            }
        }
    }
    fn exit(&self, _code: Option<i32>) {}
    fn snapshot_request(&self, viewer: u64) {
        // Snapshot is taken from state as of this call — the marker's position
        // in the stream is what makes it gapless.
        let snapshot = self.seen.lock().unwrap().clone();
        if let Some(share) = self.share.lock().unwrap().clone() {
            share.snapshot_ready(viewer, data_encoding::BASE64.encode(&snapshot), 80, 24);
        }
    }
}

/// The tests' `ShareSource`: forwards viewer bytes into the real PTY and
/// snapshot requests into the ordered dispatch bridge — the same wiring the
/// app's terminal source has, with the webview played by `FakeView`.
struct TestSource {
    bridge: Arc<SessionBridge>,
    write_pty: PtyWriter,
}

impl ShareSource for TestSource {
    fn kind(&self) -> SharedTabType {
        SharedTabType::Terminal
    }
    fn grid(&self) -> Option<Viewport> {
        Some(Viewport { cols: 80, rows: 24 })
    }
    fn request_snapshot(&self, viewer: ViewerId) {
        self.bridge.inject_snapshot_request(viewer);
    }
    fn inject_input(
        &self,
        _viewer: ViewerId,
        _access: Access,
        payload: InputPayload,
    ) -> anyhow::Result<InputOutcome> {
        if let InputPayload::Bytes(bytes) = payload {
            (self.write_pty)(&bytes);
        }
        Ok(InputOutcome::Applied)
    }
    fn bind(&self, binding: ShareBinding) {
        self.bridge.attach_share(binding);
    }
    fn unbind(&self) {
        let _ = self.bridge.detach_share();
    }
}

fn decode_outputs(events: &[RemoteHostMsg]) -> String {
    let mut s = String::new();
    for e in events {
        match e {
            RemoteHostMsg::Snapshot { b64, .. } | RemoteHostMsg::Output { b64 } => {
                let bytes = data_encoding::BASE64.decode(b64.as_bytes()).unwrap();
                s.push_str(&String::from_utf8_lossy(&bytes));
            }
            _ => {}
        }
    }
    s
}

async fn wait_for(events: &Arc<Mutex<Vec<RemoteHostMsg>>>, needle: &str, secs: u64) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if decode_outputs(&events.lock().unwrap()).contains(needle) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_msg(
    events: &Arc<Mutex<Vec<RemoteHostMsg>>>,
    pred: impl Fn(&RemoteHostMsg) -> bool,
    secs: u64,
) -> bool {
    wait_msg_count(events, pred, 1, secs).await
}

/// Wait until at least `n` received frames match. Needed where the frame
/// being waited for is shaped exactly like an earlier one — an upgrade's
/// Mode is byte-identical to the join-time Mode, so only the count proves
/// a SECOND frame was actually sent.
async fn wait_msg_count(
    events: &Arc<Mutex<Vec<RemoteHostMsg>>>,
    pred: impl Fn(&RemoteHostMsg) -> bool,
    n: usize,
    secs: u64,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if events.lock().unwrap().iter().filter(|e| pred(e)).count() >= n {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_viewers_drive_a_real_shell() -> anyhow::Result<()> {
    let terms = Arc::new(SessionManager::new());
    let hub = RemoteHub::new();
    let view = FakeView::new();
    let bridge = SessionBridge::new(view.clone());

    // Real PTY, output routed through the same ordered dispatch the app uses.
    let session_id = {
        let b = bridge.clone();
        let b2 = bridge.clone();
        terms.create(
            SpawnOpts {
                shell: Some(probe_shell()),
                cols: 80,
                rows: 24,
                ..Default::default()
            },
            Arc::new(move |bytes| b.dispatch_data(bytes)),
            Arc::new(move |code| b2.dispatch_exit(code.map(|c| c as i32))),
        )?
    };

    // Let the stand-in terminal answer the shell before anything is asked of
    // it — on Windows the very first bytes are a cursor-position report.
    {
        let rt = terms.clone();
        let rs = session_id.clone();
        view.set_reply(Box::new(move |b| {
            let _ = rt.write(&rs, b);
        }));
    }

    // Produce output *before* anyone joins: it must arrive via the snapshot.
    terms.write(&session_id, &echo_literal("BEFORE_JOIN_MARK"))?;
    let pre_deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < pre_deadline {
        if String::from_utf8_lossy(&view.seen.lock().unwrap()).contains("BEFORE_JOIN_MARK") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Start sharing this session. The source's bind() hooks the bridge up
    // during share_start, before the ticket exists.
    let input_terms = terms.clone();
    let input_session = session_id.clone();
    let (share, ticket) = hub
        .share_start(ShareOpts {
            title: "headless tab".into(),
            source: Arc::new(TestSource {
                bridge: bridge.clone(),
                write_pty: Box::new(move |bytes| {
                    let _ = input_terms.write(&input_session, bytes);
                }),
            }),
            on_presence: Arc::new(|_| {}),
            ttl: None,
            access: Access::Steer,
        })
        .await?;
    view.set_share(share.clone());

    // Viewer A joins, sees history via snapshot, then runs a command.
    let events_a: Arc<Mutex<Vec<RemoteHostMsg>>> = Arc::new(Mutex::new(Vec::new()));
    let handle_a = {
        let ev = events_a.clone();
        join(
            &ticket,
            "viewer-a",
            Arc::new(move |m| ev.lock().unwrap().push(m)),
        )
        .await?
    };
    assert!(
        wait_for(&events_a, "BEFORE_JOIN_MARK", 20).await,
        "snapshot should carry output produced before the viewer joined"
    );
    // Even a read-write share announces its mode, so clients can render the
    // capability badge from fact rather than assuming write access.
    assert!(
        wait_msg(
            &events_a,
            |e| matches!(
                e,
                RemoteHostMsg::Mode {
                    read_only: false,
                    ..
                }
            ),
            20
        )
        .await,
        "viewer must be told Mode {{ read_only: false }} on a writable share"
    );

    handle_a.send_input(&echo_product("A_RESULT", 3, 5));
    assert!(
        wait_for(&events_a, "A_RESULT_15", 20).await,
        "viewer A input must reach the real shell and its output come back"
    );

    // Viewer B joins later: its snapshot must already contain A's result, and
    // both viewers must then see the same live stream.
    let events_b: Arc<Mutex<Vec<RemoteHostMsg>>> = Arc::new(Mutex::new(Vec::new()));
    let handle_b = {
        let ev = events_b.clone();
        join(
            &ticket,
            "viewer-b",
            Arc::new(move |m| ev.lock().unwrap().push(m)),
        )
        .await?
    };
    assert!(
        wait_for(&events_b, "A_RESULT_15", 20).await,
        "late joiner's snapshot must include earlier remote activity"
    );

    handle_b.send_input(&echo_product("B_RESULT", 7, 7));
    assert!(
        wait_for(&events_b, "B_RESULT_49", 20).await,
        "viewer B input must reach the shell"
    );
    assert!(
        wait_for(&events_a, "B_RESULT_49", 20).await,
        "viewer A must observe what viewer B typed (multi-viewer sync)"
    );
    assert_eq!(share.viewer_count(), 2);

    // Stopping the share must tell viewers, not just drop them silently.
    hub.share_stop(&share.id);
    let ended = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let done = events_a
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RemoteHostMsg::End { .. }));
            if done {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    assert!(ended.is_ok(), "viewers must be told the share ended");

    handle_a.leave().await;
    handle_b.leave().await;
    terms.kill(&session_id)?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_registry_path_shares_a_real_shell_and_unregister_ends_the_share() -> anyhow::Result<()>
{
    let terms = Arc::new(SessionManager::new());
    let hub = RemoteHub::new();
    let view = FakeView::new();
    let bridge = SessionBridge::new(view.clone());

    let session_id = {
        let b = bridge.clone();
        let b2 = bridge.clone();
        terms.create(
            SpawnOpts {
                shell: Some(probe_shell()),
                cols: 80,
                rows: 24,
                ..Default::default()
            },
            Arc::new(move |bytes| b.dispatch_data(bytes)),
            Arc::new(move |code| b2.dispatch_exit(code.map(|c| c as i32))),
        )?
    };
    {
        let rt = terms.clone();
        let rs = session_id.clone();
        view.set_reply(Box::new(move |b| {
            let _ = rt.write(&rs, b);
        }));
    }

    // The real adapter, wired the way term_create wires it: PTY writes and
    // viewport announcements injected as closures, the bridge owned whole.
    let registry = SourceRegistry::default();
    let tab_id = "tab-under-test";
    let input_terms = terms.clone();
    let input_session = session_id.clone();
    registry.register(
        tab_id,
        Arc::new(TerminalSource::new(
            bridge.clone(),
            Arc::new(move |bytes| {
                let _ = input_terms.write(&input_session, bytes);
            }),
            Arc::new(|_| {}),
            Viewport { cols: 80, rows: 24 },
        )),
    );

    // Resolve by tab id — the same lookup the share_start command performs —
    // and share whatever comes back.
    let source = registry
        .get(tab_id)
        .expect("a registered tab must resolve by its id");
    let (share, ticket) = hub
        .share_start(ShareOpts {
            title: "registry tab".into(),
            source,
            on_presence: Arc::new(|_| {}),
            ttl: None,
            access: Access::Steer,
        })
        .await?;
    view.set_share(share.clone());

    let events: Arc<Mutex<Vec<RemoteHostMsg>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = {
        let ev = events.clone();
        join(
            &ticket,
            "registry viewer",
            Arc::new(move |m| ev.lock().unwrap().push(m)),
        )
        .await?
    };
    assert!(
        wait_msg(&events, |e| matches!(e, RemoteHostMsg::Snapshot { .. }), 20).await,
        "the snapshot request must travel adapter -> bridge -> local view and back"
    );

    handle.send_input(&echo_product("REGISTRY_RESULT", 3, 5));
    assert!(
        wait_for(&events, "REGISTRY_RESULT_15", 20).await,
        "viewer input must reach the real shell through the registered adapter"
    );

    // Tab death, as the glue performs it: unregister, unbind whatever came
    // out, stop the share it was bound to. The viewer is told with End.
    let removed = registry
        .unregister(tab_id)
        .expect("unregister must hand the tab's source back");
    removed.unbind();
    hub.share_stop(&share.id);
    assert!(
        wait_msg(&events, |e| matches!(e, RemoteHostMsg::End { .. }), 20).await,
        "unregistering the tab must end the share with an End frame"
    );
    assert!(
        registry.get(tab_id).is_none(),
        "an unregistered tab must not be resolvable for a new share"
    );

    handle.leave().await;
    terms.kill(&session_id)?;
    Ok(())
}

/// A read-only share must drop viewer keystrokes before the real PTY: the
/// shell never sees them, while host-driven output still reaches the viewer.
#[tokio::test(flavor = "multi_thread")]
async fn read_only_viewer_cannot_drive_the_shell() -> anyhow::Result<()> {
    let terms = Arc::new(SessionManager::new());
    let hub = RemoteHub::new();
    let view = FakeView::new();
    let bridge = SessionBridge::new(view.clone());

    let session_id = {
        let b = bridge.clone();
        let b2 = bridge.clone();
        terms.create(
            SpawnOpts {
                shell: Some(probe_shell()),
                cols: 80,
                rows: 24,
                ..Default::default()
            },
            Arc::new(move |bytes| b.dispatch_data(bytes)),
            Arc::new(move |code| b2.dispatch_exit(code.map(|c| c as i32))),
        )?
    };

    // As above: nothing this test asserts can happen until the shell's
    // cursor-position report is answered.
    {
        let rt = terms.clone();
        let rs = session_id.clone();
        view.set_reply(Box::new(move |b| {
            let _ = rt.write(&rs, b);
        }));
    }

    let input_terms = terms.clone();
    let input_session = session_id.clone();
    let (share, ticket) = hub
        .share_start(ShareOpts {
            title: "read-only tab".into(),
            source: Arc::new(TestSource {
                bridge: bridge.clone(),
                // Wired exactly like a writable share on purpose: if the
                // host-side gate failed, this sink WOULD drive the shell,
                // which is precisely what the assertions below detect. A
                // no-op sink here would mask a broken gate.
                write_pty: Box::new(move |bytes| {
                    let _ = input_terms.write(&input_session, bytes);
                }),
            }),
            on_presence: Arc::new(|_| {}),
            ttl: None,
            access: Access::View,
        })
        .await?;
    view.set_share(share.clone());

    let events: Arc<Mutex<Vec<RemoteHostMsg>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = {
        let ev = events.clone();
        join(
            &ticket,
            "watcher",
            Arc::new(move |m| ev.lock().unwrap().push(m)),
        )
        .await?
    };
    assert!(
        wait_msg(&events, |e| matches!(e, RemoteHostMsg::Snapshot { .. }), 20).await,
        "viewer must go live before we probe the input gate"
    );
    assert!(
        wait_msg(
            &events,
            |e| matches!(
                e,
                RemoteHostMsg::Mode {
                    read_only: true,
                    ..
                }
            ),
            20
        )
        .await,
        "viewer must be told the share is read-only"
    );

    // The viewer tries to run a command, then pings. Both ride one ordered
    // stream, so Pong proves the Input frame was already handled (dropped)
    // rather than still in flight.
    handle.send_input(&echo_literal("INJECTED_BY_VIEWER"));
    handle.ping();
    assert!(
        wait_msg(&events, |e| matches!(e, RemoteHostMsg::Pong), 20).await,
        "pong must come back after the input attempt"
    );

    // The host itself still drives the shell freely. Had the injected input
    // reached the PTY, its echo would precede this command's output.
    terms.write(&session_id, &echo_product("HOST_DRIVEN", 6, 7))?;
    assert!(
        wait_for(&events, "HOST_DRIVEN_42", 20).await,
        "host-driven output must still reach the read-only viewer"
    );
    assert!(
        !decode_outputs(&events.lock().unwrap()).contains("INJECTED_BY_VIEWER"),
        "viewer input must never surface in the shared stream"
    );
    assert!(
        !String::from_utf8_lossy(&view.seen.lock().unwrap()).contains("INJECTED_BY_VIEWER"),
        "viewer input must never reach the PTY at all"
    );

    handle.leave().await;
    hub.share_stop(&share.id);
    terms.kill(&session_id)?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn live_access_change_regates_a_connected_viewer() -> anyhow::Result<()> {
    let terms = Arc::new(SessionManager::new());
    let hub = RemoteHub::new();
    let view = FakeView::new();
    let bridge = SessionBridge::new(view.clone());

    let session_id = {
        let b = bridge.clone();
        let b2 = bridge.clone();
        terms.create(
            SpawnOpts {
                shell: Some(probe_shell()),
                cols: 80,
                rows: 24,
                ..Default::default()
            },
            Arc::new(move |bytes| b.dispatch_data(bytes)),
            Arc::new(move |code| b2.dispatch_exit(code.map(|c| c as i32))),
        )?
    };
    {
        let rt = terms.clone();
        let rs = session_id.clone();
        view.set_reply(Box::new(move |b| {
            let _ = rt.write(&rs, b);
        }));
    }

    // The host-side roster, as a host UI would see it after each presence
    // callback: (viewer id, current level) pairs.
    let roster: Arc<Mutex<Vec<(u64, Access)>>> = Arc::new(Mutex::new(Vec::new()));
    let input_terms = terms.clone();
    let input_session = session_id.clone();
    let (share, ticket) = hub
        .share_start(ShareOpts {
            title: "regated tab".into(),
            source: Arc::new(TestSource {
                bridge: bridge.clone(),
                // Wired exactly like a writable share on purpose: if the
                // host-side gate failed after the downgrade, this sink WOULD
                // drive the shell, which is what the anti-echo assertions
                // below detect.
                write_pty: Box::new(move |bytes| {
                    let _ = input_terms.write(&input_session, bytes);
                }),
            }),
            on_presence: {
                let roster = roster.clone();
                Arc::new(move |r| {
                    *roster.lock().unwrap() = r.iter().map(|v| (v.id, v.access)).collect();
                })
            },
            ttl: None,
            access: Access::Steer,
        })
        .await?;
    view.set_share(share.clone());

    let events: Arc<Mutex<Vec<RemoteHostMsg>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = {
        let ev = events.clone();
        join(
            &ticket,
            "colleague",
            Arc::new(move |m| ev.lock().unwrap().push(m)),
        )
        .await?
    };

    // At Steer the viewer drives the real shell — the arithmetic proves
    // evaluation, not byte echo.
    handle.send_input(&echo_product("WHILE_STEER", 3, 5));
    assert!(
        wait_for(&events, "WHILE_STEER_15", 20).await,
        "at Steer the viewer's input must reach the shell"
    );
    let viewer_id = roster
        .lock()
        .unwrap()
        .first()
        .map(|(id, _)| *id)
        .expect("a driving viewer must be on the roster");

    // Downgrade, live. set_viewer_access applies synchronously host-side, so
    // everything the viewer sends after seeing the new Mode is judged by the
    // new level. The resent Mode must carry BOTH fields coherently:
    // read_only: true is the bit a v1 client's gate runs on, access: View is
    // what a v2 client reads — dropping either would desync one generation.
    hub.set_viewer_access(&share.id, viewer_id, Access::View)?;
    assert!(
        wait_msg(
            &events,
            |e| matches!(
                e,
                RemoteHostMsg::Mode {
                    read_only: true,
                    access: Some(Access::View)
                }
            ),
            20
        )
        .await,
        "the downgraded viewer must receive Mode {{ read_only: true, access: view }}"
    );
    assert_eq!(
        roster.lock().unwrap().as_slice(),
        &[(viewer_id, Access::View)],
        "the host roster must carry the viewer's new level"
    );

    // Input now dies at the hub, before the PTY. Pong proves the doomed
    // frame was processed (same ordered stream); the host-driven echo then
    // brackets the transcript, and the PTY-side view is the anti-echo proof
    // that nothing the viewer typed ever reached the shell.
    handle.send_input(&echo_literal("INJECTED_WHILE_VIEW"));
    handle.ping();
    assert!(
        wait_msg(&events, |e| matches!(e, RemoteHostMsg::Pong), 20).await,
        "pong must come back after the input attempt"
    );
    terms.write(&session_id, &echo_product("HOST_STILL_DRIVES", 6, 7))?;
    assert!(
        wait_for(&events, "HOST_STILL_DRIVES_42", 20).await,
        "host-driven output must still reach the downgraded viewer"
    );
    assert!(
        !String::from_utf8_lossy(&view.seen.lock().unwrap()).contains("INJECTED_WHILE_VIEW"),
        "input sent after the downgrade must never reach the PTY"
    );

    // And back up: the same viewer, over the same connection, drives again.
    // The upgrade Mode is shaped exactly like the join-time one, so only the
    // count proves a second frame was sent.
    hub.set_viewer_access(&share.id, viewer_id, Access::Steer)?;
    assert!(
        wait_msg_count(
            &events,
            |e| matches!(
                e,
                RemoteHostMsg::Mode {
                    read_only: false,
                    access: Some(Access::Steer)
                }
            ),
            2,
            20
        )
        .await,
        "the upgraded viewer must receive a second Mode {{ read_only: false, access: steer }}"
    );
    handle.send_input(&echo_product("STEER_AGAIN", 7, 8));
    assert!(
        wait_for(&events, "STEER_AGAIN_56", 20).await,
        "after the upgrade the same viewer must drive the shell again"
    );
    assert_eq!(
        roster.lock().unwrap().as_slice(),
        &[(viewer_id, Access::Steer)],
        "the roster must follow the upgrade too"
    );

    handle.leave().await;
    hub.share_stop(&share.id);
    terms.kill(&session_id)?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_v1_viewer_is_regated_through_the_read_only_bit() -> anyhow::Result<()> {
    let terms = Arc::new(SessionManager::new());
    let hub = RemoteHub::new();
    let view = FakeView::new();
    let bridge = SessionBridge::new(view.clone());

    let session_id = {
        let b = bridge.clone();
        let b2 = bridge.clone();
        terms.create(
            SpawnOpts {
                shell: Some(probe_shell()),
                cols: 80,
                rows: 24,
                ..Default::default()
            },
            Arc::new(move |bytes| b.dispatch_data(bytes)),
            Arc::new(move |code| b2.dispatch_exit(code.map(|c| c as i32))),
        )?
    };
    {
        let rt = terms.clone();
        let rs = session_id.clone();
        view.set_reply(Box::new(move |b| {
            let _ = rt.write(&rs, b);
        }));
    }

    let roster: Arc<Mutex<Vec<(u64, Access)>>> = Arc::new(Mutex::new(Vec::new()));
    let input_terms = terms.clone();
    let input_session = session_id.clone();
    let (share, ticket) = hub
        .share_start(ShareOpts {
            title: "old client tab".into(),
            source: Arc::new(TestSource {
                bridge: bridge.clone(),
                write_pty: Box::new(move |bytes| {
                    let _ = input_terms.write(&input_session, bytes);
                }),
            }),
            on_presence: {
                let roster = roster.clone();
                Arc::new(move |r| {
                    *roster.lock().unwrap() = r.iter().map(|v| (v.id, v.access)).collect();
                })
            },
            ttl: None,
            access: Access::Steer,
        })
        .await?;
    view.set_share(share.clone());

    let events: Arc<Mutex<Vec<RemoteHostMsg>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = {
        let ev = events.clone();
        join_as(
            ShareTicket::decode(&ticket)?,
            "an-old-client",
            1,
            Arc::new(move |m| ev.lock().unwrap().push(m)),
        )
        .await?
    };

    handle.send_input(&echo_product("OLD_STEER", 3, 5));
    assert!(
        wait_for(&events, "OLD_STEER_15", 20).await,
        "the v1 viewer must drive the shell at Steer"
    );
    let viewer_id = roster
        .lock()
        .unwrap()
        .first()
        .map(|(id, _)| *id)
        .expect("the v1 viewer must be on the roster");

    // Downgrade: the v1 client is told through the only field it has.
    hub.set_viewer_access(&share.id, viewer_id, Access::View)?;
    assert!(
        wait_msg(
            &events,
            |e| matches!(
                e,
                RemoteHostMsg::Mode {
                    read_only: true,
                    access: None
                }
            ),
            20
        )
        .await,
        "the resent Mode must set read_only and carry no access field for v1"
    );

    handle.send_input(&echo_literal("V1_INJECTED_WHILE_VIEW"));
    handle.ping();
    assert!(
        wait_msg(&events, |e| matches!(e, RemoteHostMsg::Pong), 20).await,
        "pong must come back after the input attempt"
    );
    terms.write(&session_id, &echo_product("HOST_BRACKET", 6, 7))?;
    assert!(
        wait_for(&events, "HOST_BRACKET_42", 20).await,
        "host-driven output must still reach the v1 viewer"
    );
    assert!(
        !String::from_utf8_lossy(&view.seen.lock().unwrap()).contains("V1_INJECTED_WHILE_VIEW"),
        "a downgraded v1 viewer's input must never reach the PTY"
    );

    // Upgrade back. Join-time Mode was also { read_only: false, access: None },
    // so only the count proves the upgrade was actually resent.
    hub.set_viewer_access(&share.id, viewer_id, Access::Steer)?;
    assert!(
        wait_msg_count(
            &events,
            |e| matches!(
                e,
                RemoteHostMsg::Mode {
                    read_only: false,
                    access: None
                }
            ),
            2,
            20
        )
        .await,
        "the upgrade must reach the v1 viewer as a second read_only: false Mode"
    );
    handle.send_input(&echo_product("OLD_AGAIN", 7, 8));
    assert!(
        wait_for(&events, "OLD_AGAIN_56", 20).await,
        "after the upgrade the v1 viewer must drive the shell again"
    );

    handle.leave().await;
    hub.share_stop(&share.id);
    terms.kill(&session_id)?;
    Ok(())
}

/// A client built against v1 must keep working against a v2 host.
///
/// The whole point of negotiating rather than requiring a matching version.
/// This drives a real host over a real iroh connection while announcing
/// `proto: 1`, and checks both that it is let in and that everything it is
/// sent is a frame v1 knows how to parse.
#[tokio::test]
async fn a_client_speaking_v1_still_joins_and_drives_a_terminal() -> anyhow::Result<()> {
    let terms = Arc::new(SessionManager::new());
    let hub = RemoteHub::new();
    let view = FakeView::new();
    let bridge = SessionBridge::new(view.clone());

    let session_id = {
        let b = bridge.clone();
        let b2 = bridge.clone();
        terms.create(
            SpawnOpts {
                shell: Some(probe_shell()),
                cols: 80,
                rows: 24,
                ..Default::default()
            },
            Arc::new(move |bytes| b.dispatch_data(bytes)),
            Arc::new(move |code| b2.dispatch_exit(code.map(|c| c as i32))),
        )?
    };
    {
        let rt = terms.clone();
        let rs = session_id.clone();
        view.set_reply(Box::new(move |b| {
            let _ = rt.write(&rs, b);
        }));
    }

    let input_terms = terms.clone();
    let input_session = session_id.clone();
    let (share, ticket) = hub
        .share_start(ShareOpts {
            title: "headless tab".into(),
            source: Arc::new(TestSource {
                bridge: bridge.clone(),
                write_pty: Box::new(move |bytes| {
                    let _ = input_terms.write(&input_session, bytes);
                }),
            }),
            on_presence: Arc::new(|_| {}),
            ttl: None,
            access: Access::Steer,
        })
        .await?;
    view.set_share(share.clone());

    let events: Arc<Mutex<Vec<RemoteHostMsg>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = {
        let ev = events.clone();
        join_as(
            ShareTicket::decode(&ticket)?,
            "an-old-client",
            1,
            Arc::new(move |m| ev.lock().unwrap().push(m)),
        )
        .await?
    };

    // It gets in, and is answered in its own version.
    assert!(
        wait_msg(
            &events,
            |e| matches!(e, RemoteHostMsg::Welcome { proto: 1, .. }),
            20
        )
        .await,
        "a v1 client must be welcomed as v1, not refused for mismatching"
    );

    // And it is told its mode in the shape it understands, with nothing in the
    // frame it was not built to read.
    assert!(
        wait_msg(
            &events,
            |e| matches!(
                e,
                RemoteHostMsg::Mode {
                    read_only: false,
                    access: None
                }
            ),
            20
        )
        .await,
        "a v1 client must get the old two-state mode and no access level"
    );
    {
        let seen = events.lock().unwrap();
        let welcome = seen
            .iter()
            .find(|e| matches!(e, RemoteHostMsg::Welcome { .. }))
            .expect("a welcome must have arrived");
        match welcome {
            RemoteHostMsg::Welcome { tab_type, .. } => assert_eq!(
                *tab_type, None,
                "a v1 client must not be sent a field it has no place for"
            ),
            other => panic!("{other:?}"),
        }
        assert!(
            !seen.iter().any(|e| matches!(
                e,
                RemoteHostMsg::AgentEvent { .. }
                    | RemoteHostMsg::AgentSnapshot { .. }
                    | RemoteHostMsg::AgentDecisionTaken { .. }
            )),
            "no v2-only payload may reach a v1 client"
        );
    }

    // And it can actually work: the session is usable, not merely accepted.
    handle.send_input(&echo_product("OLD_CLIENT", 6, 7));
    assert!(
        wait_for(&events, "OLD_CLIENT_42", 20).await,
        "a v1 client's input must still reach the shell and its output come back"
    );

    handle.leave().await;
    hub.share_stop(&share.id);
    terms.kill(&session_id)?;
    Ok(())
}

/// A joiner from this build meeting a host from before the version field.
///
/// The released v0.0.1/v0.0.2 hosts have no negotiate(): a Hello with
/// `proto != 1` hits `bail!("protocol mismatch")` and the connection closes
/// without a single frame sent
/// (git show v0.0.2:crates/tabverse-remote/src/lib.rs:423). The ticket those
/// hosts hand out has no proto field, and that absence is the signal: the new
/// viewer must introduce itself at v1. The real hub always negotiates, so the
/// strict host here is a test double speaking the wire format — length-prefixed
/// JSON frames (the crate's own read_frame/write_frame) over an iroh accept —
/// enforcing exactly the released check.
///
/// Mutation check: making join() announce REMOTE_PROTO_VERSION unconditionally
/// turns this red on the Welcome assertion — the double closes at once, so the
/// joiner reads an error and folds it into `End { "connection lost: …" }`
/// rather than hanging.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_viewer_greets_a_v1_host_in_v1() -> anyhow::Result<()> {
    // The v1-strict host double: accept one bi stream, read the Hello, and
    // behave byte-for-byte like the released host — close on proto != 1,
    // Welcome{proto:1} + End on proto == 1.
    let ep = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
        .alpns(vec![REMOTE_ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| anyhow::anyhow!("iroh bind failed: {e}"))?;
    let _ = tokio::time::timeout(Duration::from_secs(5), ep.online()).await;
    let host_addr = ep.addr();

    let accept_ep = ep.clone();
    tokio::spawn(async move {
        while let Some(incoming) = accept_ep.accept().await {
            tokio::spawn(async move {
                let Ok(conn) = incoming.await else { return };
                let Ok((mut send, mut recv)) = conn.accept_bi().await else {
                    return;
                };
                let Ok(RemoteClientMsg::Hello { proto, .. }) =
                    read_frame::<RemoteClientMsg>(&mut recv).await
                else {
                    return;
                };
                if proto != 1 {
                    // v0.0.2 lib.rs:423: bail, connection dropped, no frame.
                    conn.close(0u32.into(), b"protocol mismatch");
                    return;
                }
                let _ = write_frame(
                    &mut send,
                    &RemoteHostMsg::Welcome {
                        proto: 1,
                        tab_title: "an old host".into(),
                        cols: 80,
                        rows: 24,
                        tab_type: None,
                    },
                )
                .await;
                let _ = write_frame(
                    &mut send,
                    &RemoteHostMsg::End {
                        reason: "the old host says goodbye".into(),
                    },
                )
                .await;
                let _ = send.finish();
                // Wait (bounded) for the peer's ack so closing the connection
                // cannot discard the frames just buffered.
                let _ = tokio::time::timeout(Duration::from_secs(5), send.stopped()).await;
                conn.close(0u32.into(), b"bye");
            });
        }
    });

    // The ticket exactly as v0.0.2 hands it out: three fields, no proto —
    // built by hand from the old shape rather than through ShareTicket, so
    // this cannot accidentally test our own serializer against itself.
    #[derive(serde::Serialize)]
    struct V1Ticket {
        addr: iroh::EndpointAddr,
        share: String,
        token: String,
    }
    let json = serde_json::to_vec(&V1Ticket {
        addr: host_addr,
        share: "s-1".into(),
        token: "t-1".into(),
    })?;
    let ticket = format!(
        "tabv{}",
        data_encoding::BASE32_NOPAD.encode(&json).to_lowercase()
    );

    // The real join(), fed the old ticket: it must read the absent field as
    // "this host speaks v1 only" and say Hello accordingly.
    let events: Arc<Mutex<Vec<RemoteHostMsg>>> = Arc::new(Mutex::new(Vec::new()));
    let handle = {
        let ev = events.clone();
        join(
            &ticket,
            "a-new-viewer",
            Arc::new(move |m| ev.lock().unwrap().push(m)),
        )
        .await?
    };

    // Welcomed in v1 — which can only have happened if the Hello declared 1:
    // the double closes on anything else, and the joiner would have logged
    // End{"connection lost: …"} instead of a Welcome.
    assert!(
        wait_msg(
            &events,
            |e| matches!(e, RemoteHostMsg::Welcome { proto: 1, .. }),
            20
        )
        .await,
        "a new viewer must be welcomed by a v1-strict host, not disconnected; got {:?}",
        events.lock().unwrap()
    );
    assert!(
        !events.lock().unwrap().iter().any(
            |e| matches!(e, RemoteHostMsg::End { reason } if reason.starts_with("connection lost"))
        ),
        "the v1-strict host must never have cut the connection"
    );

    handle.leave().await;
    ep.close().await;
    Ok(())
}
