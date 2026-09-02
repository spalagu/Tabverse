//! Shared protocol types.
//!
//! These types cross three boundaries and must stay serde-stable:
//!   1. Rust core -> webview (Tauri IPC channel events)
//!   2. remote host <-> remote client (iroh streams, length-prefixed JSON frames)
//!   3. Rust core -> browser wasm client (same frames as 2)

use serde::{Deserialize, Serialize};

/// Events emitted by a local PTY session towards any attached view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    /// Raw output bytes, base64-encoded (UTF-8 decoding happens in xterm.js).
    #[serde(rename_all = "camelCase")]
    Data { b64: String },
    /// The shell process exited.
    #[serde(rename_all = "camelCase")]
    Exit { code: Option<i32> },
    /// (Host webview only) A remote viewer needs a state snapshot. Delivered
    /// in-order within the output stream so the webview serializes at exactly
    /// this point; output after this marker is buffered for the viewer.
    #[serde(rename_all = "camelCase")]
    SnapshotRequest { viewer: u64 },
}

/// What a tab being shared is, so a client knows which payloads to expect.
///
/// Sent in `Welcome` from v2 onwards. A v1 client never sees it and never
/// needs to: v1 only ever shared terminals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SharedTabType {
    Terminal,
    /// v3: the whole app, not one tab. A v2 client has no renderer for this
    /// and must be told "cannot display" rather than shown a blank grid;
    /// the hub rejects the join before any app frame is sent.
    App,
    /// v4: one non-terminal tab transported through its plugin-owned
    /// `RemoteContribution`. The Join client renders the app shell with a
    /// one-tab mirror, but older app-share clients must be refused because
    /// the semantic snapshot/frame family did not exist before v4.
    Contribution,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    /// Watch only.
    View,
    /// Watch and send interaction input. Cannot authorise privileged work.
    Steer,
    /// Everything Steer can do, plus deciding permission requests.
    Approve,
}

impl Access {
    /// How v1 clients see this. They have one bit, so anything short of Steer
    /// reads as read-only — the conservative direction, since the mistake that
    /// matters is a viewer believing it may act when it may not.
    pub fn read_only(self) -> bool {
        matches!(self, Access::View)
    }

    pub fn may_steer(self) -> bool {
        matches!(self, Access::Steer | Access::Approve)
    }

    pub fn may_approve(self) -> bool {
        matches!(self, Access::Approve)
    }
}

/// Client -> host messages for a shared terminal session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RemoteClientMsg {
    /// Introduce ourselves right after connecting.
    #[serde(rename_all = "camelCase")]
    Hello {
        name: String,
        proto: u32,
        share: String,
        token: String,
    },
    /// Keyboard/paste input for the PTY (base64 of UTF-8 bytes).
    #[serde(rename_all = "camelCase")]
    Input { b64: String },
    /// The client's viewport size changed.
    #[serde(rename_all = "camelCase")]
    Resize { cols: u16, rows: u16 },
    /// Liveness probe.
    Ping,

    // Read-only compatibility decoder for requests emitted by the retired
    // v2 tab type. The host answers these with a structured End frame.
    #[serde(rename = "agentPrompt", rename_all = "camelCase")]
    RetiredPrompt { text: String },
    #[serde(rename = "agentAnswer", rename_all = "camelCase")]
    RetiredAnswer {
        call_id: String,
        allow: bool,
        reason: Option<String>,
    },
    #[serde(rename = "agentCancel")]
    RetiredCancel,

    // ── v3: app-level shares ────────────────────────────────────────────
    /// Invoke a host command over the app share. Requires Steer.
    #[serde(rename_all = "camelCase")]
    Rpc {
        id: u64,
        cmd: String,
        args: serde_json::Value,
    },
    /// A UI action for the host's store to execute. Requires Steer.
    #[serde(rename_all = "camelCase")]
    Action {
        name: String,
        args: serde_json::Value,
    },
    /// Clipboard text produced inside the join page. Requires Steer.
    #[serde(rename_all = "camelCase")]
    ClipPush { text: String },
    /// An HTTP request for the remote proxy (browser-tab routing).
    #[serde(rename_all = "camelCase")]
    ProxyReq {
        id: u64,
        head: String,
        body: Option<String>,
    },

    // ── v4: Browser http-stream-v2 ───────────────────────────────────
    /// Open a requester-private HTTP(S) stream. The host derives shareId and
    /// viewerId from the authenticated connection; neither is accepted from
    /// client data.
    #[serde(rename_all = "camelCase")]
    BrowserOpen {
        stream_id: u64,
        tab_id: String,
        /// Correlation only, never bearer authority. The host re-derives it
        /// from the authenticated attachment and compares the full grant owner.
        grant_id: String,
        attachment_id: String,
        attachment_generation: u64,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body_len: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    BrowserRequestChunk {
        stream_id: u64,
        seq: u64,
        b64: String,
    },
    #[serde(rename_all = "camelCase")]
    BrowserRequestEnd { stream_id: u64 },
    /// Add bytes to the response window. The host sends no response chunk
    /// unless this requester has granted enough credit.
    #[serde(rename_all = "camelCase")]
    BrowserCredit { stream_id: u64, bytes: u64 },
    #[serde(rename_all = "camelCase")]
    BrowserCancel {
        stream_id: u64,
        reason: Option<String>,
    },

    // ── v4: contribution-owned ordered semantic streams ───────────────
    #[serde(rename_all = "camelCase")]
    RemoteAck {
        tab_id: String,
        epoch: String,
        frame_seq: u64,
    },
    #[serde(rename_all = "camelCase")]
    RemoteResnapshot {
        tab_id: String,
        epoch: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RemoteIntent {
        tab_id: String,
        attachment_id: String,
        attachment_generation: u64,
        intent_id: String,
        name: String,
        args: serde_json::Value,
    },
}

/// Host -> client messages for a shared terminal session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RemoteHostMsg {
    /// Accepted; carries session metadata.
    #[serde(rename_all = "camelCase")]
    Welcome {
        proto: u32,
        tab_title: String,
        cols: u16,
        rows: u16,
        /// v2 onwards. Absent for a v1 client, which only ever sees terminals.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_type: Option<SharedTabType>,
        /// v4 server-issued identity; clients must echo both fields on intents.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attachment_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attachment_generation: Option<u64>,
    },
    /// What this viewer may do. Sent exactly once per viewer, right after its
    /// join is accepted and always before the snapshot, so clients can render
    /// capability state (e.g. a read-only badge) from fact instead of
    /// assumption — a read-write share still sends `read_only: false`.
    ///
    /// `read_only` stays for v1 clients, which have no other way to ask; v2
    /// clients read `access`. Both are always sent and always agree — dropping
    /// the old field would have made every existing client fail to parse the
    /// frame, and that is the regression the version negotiation exists to
    /// prevent.
    #[serde(rename_all = "camelCase")]
    Mode {
        read_only: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        access: Option<Access>,
    },
    /// Full terminal state snapshot (xterm serialize output, base64) to catch up.
    #[serde(rename_all = "camelCase")]
    Snapshot {
        b64: String,
        cols: u16,
        rows: u16,
    },
    /// Incremental PTY output (base64).
    #[serde(rename_all = "camelCase")]
    Output {
        b64: String,
    },
    /// Authoritative PTY size changed (host fits all viewers to this grid).
    #[serde(rename_all = "camelCase")]
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Number of connected viewers changed.
    #[serde(rename_all = "camelCase")]
    Presence {
        viewers: u32,
    },
    /// The shared session ended (tab closed / sharing stopped / shell exit).
    #[serde(rename_all = "camelCase")]
    End {
        reason: String,
    },
    Pong,

    // ── v3: app-level shares ────────────────────────────────────────────
    /// Answer to a client Rpc: the command's result, or its error text.
    #[serde(rename_all = "camelCase")]
    RpcResult {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        ok: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        err: Option<String>,
    },
    /// A store action the host executed; viewers replay it into their
    /// mirrored store. The host is the single writer — a viewer's own UI
    /// events travel as Rpc/Action up, never as this frame down.
    #[serde(rename_all = "camelCase")]
    ActionApplied {
        name: String,
        args: serde_json::Value,
    },
    /// Full mirrored-store state (the session-snapshot shape), sent on join
    /// and on reconnect reconciliation.
    #[serde(rename_all = "camelCase")]
    AppSnapshot {
        state: serde_json::Value,
    },
    /// Host clipboard contents changed (NSPasteboard changeCount).
    #[serde(rename_all = "camelCase")]
    ClipSync {
        seq: u64,
        text: String,
    },
    /// Remote-proxy answer: the origin's response head and body.
    #[serde(rename_all = "camelCase")]
    ProxyRes {
        id: u64,
        head: String,
        body: Option<String>,
    },

    // ── v4: Browser http-stream-v2 ───────────────────────────────────
    #[serde(rename_all = "camelCase")]
    BrowserResponseHead {
        stream_id: u64,
        status: u16,
        headers: Vec<(String, String)>,
        final_url: String,
    },
    #[serde(rename_all = "camelCase")]
    BrowserResponseChunk {
        stream_id: u64,
        seq: u64,
        b64: String,
    },
    #[serde(rename_all = "camelCase")]
    BrowserResponseEnd {
        stream_id: u64,
    },
    #[serde(rename_all = "camelCase")]
    BrowserResponseError {
        stream_id: u64,
        code: String,
        message: String,
    },

    // ── v4: contribution-owned ordered semantic streams ───────────────
    #[serde(rename_all = "camelCase")]
    ContributionSnapshot {
        tab_id: String,
        kind: String,
        epoch: String,
        snapshot_revision: u64,
        last_frame_seq: u64,
        state: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    ContributionFrame {
        tab_id: String,
        kind: String,
        epoch: String,
        frame_seq: u64,
        payload: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    IntentResult {
        attachment_id: String,
        attachment_generation: u64,
        intent_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ok: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        err: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PrivateStream {
        attachment_id: String,
        attachment_generation: u64,
        stream_id: String,
        seq: u64,
        fin: bool,
        payload_b64: String,
    },
}

/// Highest protocol version this build speaks.
pub const REMOTE_PROTO_VERSION: u32 = 4;

/// The version that only knew how to share a terminal. Still spoken, because
/// clients in the wild are built against it.
pub const REMOTE_PROTO_V1: u32 = 1;

/// Settle on a version both ends can speak.
///
/// The host answers in the client's version when it can, and never above its
/// own. A client from the future gets this build's best rather than a refusal:
/// the frames it does not recognise are ones it was told not to expect, since
/// the `Welcome` it receives names the version actually in force.
pub fn negotiate(client_proto: u32) -> u32 {
    client_proto.clamp(REMOTE_PROTO_V1, REMOTE_PROTO_VERSION)
}

/// The version a joiner announces in its Hello: min(own best, what the ticket
/// says its creator speaks). A ticket without the field predates it —
/// v0.0.1/v0.0.2 — and those hosts speak v1 only; worse, they answer a
/// `proto != 1` Hello by closing the connection without a frame, so
/// announcing anything higher would read as a dead link, not a downgrade.
/// The single implementation shared by the desktop joiner and the wasm one.
pub fn announce_proto(ticket_proto: Option<u32>) -> u32 {
    ticket_proto
        .unwrap_or(REMOTE_PROTO_V1)
        .min(REMOTE_PROTO_VERSION)
}

/// Can a payload of this kind be sent to a client speaking `proto`?
///
/// The rule the compatibility guarantee rests on: a v1 client is never sent a
/// frame it was not built to parse. Its decoder fails the whole connection on
/// an unknown variant, so this is the difference between an old client working
/// and an old client dropping.
/// Can the app-level payload family be sent to a client speaking `proto`?
/// An older client's decoder fails the whole connection on an unknown variant.
pub fn app_payloads_allowed(proto: u32) -> bool {
    proto >= 3
}

/// ALPN identifying the Tabverse remote-control protocol on an iroh endpoint.
pub const REMOTE_ALPN: &[u8] = b"tabverse/remote/1";

#[cfg(test)]
mod tests {
    use super::*;

    /// Frames captured from the v1 wire format, as literals.
    ///
    /// The point of writing them out rather than generating them: a v1 client
    /// already built and running somewhere parses exactly these bytes. If a
    /// change here alters them, that client breaks, and no amount of
    /// round-tripping current code against itself would notice.
    mod v1_wire {
        pub const HELLO: &str =
            r#"{"type":"hello","name":"Ada","proto":1,"share":"s-1","token":"t-1"}"#;
        pub const WELCOME: &str =
            r#"{"type":"welcome","proto":1,"tabTitle":"zsh","cols":80,"rows":24}"#;
        pub const MODE_RO: &str = r#"{"type":"mode","readOnly":true}"#;
        pub const OUTPUT: &str = r#"{"type":"output","b64":"aGk="}"#;
        pub const INPUT: &str = r#"{"type":"input","b64":"bHM="}"#;
        pub const PRESENCE: &str = r#"{"type":"presence","viewers":2}"#;
        pub const END: &str = r#"{"type":"end","reason":"tab closed"}"#;
    }

    #[test]
    fn every_v1_frame_still_parses() {
        // The regression the whole version scheme exists to prevent.
        assert!(matches!(
            serde_json::from_str::<RemoteClientMsg>(v1_wire::HELLO).unwrap(),
            RemoteClientMsg::Hello { proto: 1, .. }
        ));
        assert!(matches!(
            serde_json::from_str::<RemoteClientMsg>(v1_wire::INPUT).unwrap(),
            RemoteClientMsg::Input { .. }
        ));
        let welcome: RemoteHostMsg = serde_json::from_str(v1_wire::WELCOME).unwrap();
        match welcome {
            RemoteHostMsg::Welcome {
                proto, tab_type, ..
            } => {
                assert_eq!(proto, 1);
                assert_eq!(tab_type, None, "a v1 welcome names no tab type");
            }
            other => panic!("{other:?}"),
        }
        let mode: RemoteHostMsg = serde_json::from_str(v1_wire::MODE_RO).unwrap();
        match mode {
            RemoteHostMsg::Mode { read_only, access } => {
                assert!(read_only);
                assert_eq!(access, None);
            }
            other => panic!("{other:?}"),
        }
        for frame in [v1_wire::OUTPUT, v1_wire::PRESENCE, v1_wire::END] {
            serde_json::from_str::<RemoteHostMsg>(frame)
                .unwrap_or_else(|e| panic!("{frame} failed: {e}"));
        }
    }

    #[test]
    fn a_v1_shaped_frame_is_still_produced_byte_for_byte() {
        // Parsing old frames is half of it; the other half is that what we send
        // to a v1 client is what it was built to read.
        let welcome = RemoteHostMsg::Welcome {
            proto: 1,
            tab_title: "zsh".into(),
            cols: 80,
            rows: 24,
            tab_type: None,
            attachment_id: None,
            attachment_generation: None,
        };
        assert_eq!(serde_json::to_string(&welcome).unwrap(), v1_wire::WELCOME);

        let mode = RemoteHostMsg::Mode {
            read_only: true,
            access: None,
        };
        assert_eq!(serde_json::to_string(&mode).unwrap(), v1_wire::MODE_RO);
    }

    #[test]
    fn a_v2_mode_carries_both_the_old_bit_and_the_new_one() {
        // Both always sent, and always agreeing: a v1 client reads the bit, a
        // v2 client reads the level, and neither can be told a different story.
        for access in [Access::View, Access::Steer, Access::Approve] {
            let frame = RemoteHostMsg::Mode {
                read_only: access.read_only(),
                access: Some(access),
            };
            let json = serde_json::to_string(&frame).unwrap();
            assert!(json.contains("\"readOnly\""), "{json}");
            assert!(json.contains("\"access\""), "{json}");
            match serde_json::from_str::<RemoteHostMsg>(&json).unwrap() {
                RemoteHostMsg::Mode {
                    read_only,
                    access: got,
                } => {
                    assert_eq!(got, Some(access));
                    assert_eq!(read_only, access.read_only());
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn view_is_the_only_level_a_v1_client_sees_as_read_only() {
        // Steer must not read as read-only to an old client, or it would refuse
        // to send the input its user is entitled to send.
        assert!(Access::View.read_only());
        assert!(!Access::Steer.read_only());
        assert!(!Access::Approve.read_only());
    }

    #[test]
    fn steering_and_approving_are_separate_powers() {
        assert!(!Access::View.may_steer());
        assert!(!Access::View.may_approve());
        assert!(Access::Steer.may_steer());
        assert!(
            !Access::Steer.may_approve(),
            "steering does not grant approval authority"
        );
        assert!(Access::Approve.may_steer());
        assert!(Access::Approve.may_approve());
    }

    #[test]
    fn negotiation_answers_in_the_clients_version_but_never_above_our_own() {
        assert_eq!(negotiate(1), 1, "an old client keeps the old protocol");
        assert_eq!(negotiate(2), 2);
        assert_eq!(
            negotiate(99),
            REMOTE_PROTO_VERSION,
            "a newer client gets our best"
        );
        assert_eq!(
            negotiate(0),
            1,
            "a nonsense version floors at the oldest we speak"
        );
    }

    #[test]
    fn announce_proto_floors_at_the_ticket() {
        // A ticket without the field is from v0.0.1/v0.0.2, whose host closes
        // the connection on any Hello above 1 — so absence must mean 1, not
        // "assume our own best". (Mutation check: unwrap_or(2) fails here.)
        assert_eq!(announce_proto(None), 1, "no field means a v1-only host");
        assert_eq!(announce_proto(Some(1)), 1);
        assert_eq!(announce_proto(Some(2)), 2);
        assert_eq!(
            announce_proto(Some(99)),
            REMOTE_PROTO_VERSION,
            "a ticket from the future caps at what this build speaks"
        );
    }

    #[test]
    fn retired_v2_requests_decode_into_unsupported_only_variants() {
        let cases = [
            (r#"{"type":"agentPrompt","text":"hello"}"#, "prompt"),
            (
                r#"{"type":"agentAnswer","callId":"c1","allow":false,"reason":"no"}"#,
                "answer",
            ),
            (r#"{"type":"agentCancel"}"#, "cancel"),
        ];
        for (json, expected) in cases {
            let decoded: RemoteClientMsg = serde_json::from_str(json).unwrap();
            let actual = match decoded {
                RemoteClientMsg::RetiredPrompt { .. } => "prompt",
                RemoteClientMsg::RetiredAnswer { .. } => "answer",
                RemoteClientMsg::RetiredCancel => "cancel",
                other => panic!("unexpected compatibility decode: {other:?}"),
            };
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn v3_frames_round_trip_and_withhold_from_older_clients() {
        // The app payload family: round-trips intact, and is never sent to a
        // client below v3, whose decoder fails the connection on an unknown
        // variant.
        assert!(!app_payloads_allowed(2));
        assert!(!app_payloads_allowed(1));
        assert!(app_payloads_allowed(3));
        assert_eq!(negotiate(3), 3);
        assert_eq!(announce_proto(Some(3)), 3);

        let up = RemoteClientMsg::Rpc {
            id: 7,
            cmd: "fs_list".into(),
            args: serde_json::json!({"path": "/tmp"}),
        };
        let json = serde_json::to_string(&up).unwrap();
        assert!(json.contains("\"cmd\""), "camelCase on the wire: {json}");
        match serde_json::from_str::<RemoteClientMsg>(&json).unwrap() {
            RemoteClientMsg::Rpc { id, cmd, args } => {
                assert_eq!((id, cmd.as_str()), (7, "fs_list"));
                assert_eq!(args, serde_json::json!({"path": "/tmp"}));
            }
            other => panic!("{other:?}"),
        }

        let down = RemoteHostMsg::RpcResult {
            id: 7,
            ok: Some(serde_json::json!([{"name": "a"}])),
            err: None,
        };
        let json = serde_json::to_string(&down).unwrap();
        // An ok result carries no err field at all — the client's decoder
        // keys on which one is present, not on null-vs-value.
        assert!(!json.contains("\"err\""), "{json}");
        match serde_json::from_str::<RemoteHostMsg>(&json).unwrap() {
            RemoteHostMsg::RpcResult { id, ok, err } => {
                assert_eq!(id, 7);
                assert!(err.is_none());
                assert!(ok.is_some());
            }
            other => panic!("{other:?}"),
        }

        let snap = RemoteHostMsg::AppSnapshot {
            state: serde_json::json!({"tabs": []}),
        };
        let json = serde_json::to_string(&snap).unwrap();
        match serde_json::from_str::<RemoteHostMsg>(&json).unwrap() {
            RemoteHostMsg::AppSnapshot { state } => {
                assert_eq!(state, serde_json::json!({"tabs": []}));
            }
            other => panic!("{other:?}"),
        }

        let clip = RemoteHostMsg::ClipSync {
            seq: 4,
            text: "hi".into(),
        };
        let json = serde_json::to_string(&clip).unwrap();
        assert!(json.contains("\"clipSync\""), "{json}");
    }

    #[test]
    fn an_app_share_announces_itself_and_v2_wire_is_untouched() {
        let frame = RemoteHostMsg::Welcome {
            proto: 3,
            tab_title: "Tabverse".into(),
            cols: 0,
            rows: 0,
            tab_type: Some(SharedTabType::App),
            attachment_id: None,
            attachment_generation: None,
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"tabType\":\"app\""), "{json}");

        // A v2 terminal welcome keeps its established wire shape.
        let v2 = RemoteHostMsg::Welcome {
            proto: 2,
            tab_title: "zsh".into(),
            cols: 80,
            rows: 24,
            tab_type: Some(SharedTabType::Terminal),
            attachment_id: None,
            attachment_generation: None,
        };
        let json = serde_json::to_string(&v2).unwrap();
        assert!(json.contains("\"tabType\":\"terminal\""), "{json}");
        assert_eq!(negotiate(2), 2, "a v2 client stays on v2");
    }

    #[test]
    fn v4_contribution_frames_and_attachment_identity_round_trip() {
        assert_eq!(negotiate(4), 4);
        assert_eq!(announce_proto(Some(4)), 4);

        let welcome = RemoteHostMsg::Welcome {
            proto: 4,
            tab_title: "Tabverse".into(),
            cols: 0,
            rows: 0,
            tab_type: Some(SharedTabType::App),
            attachment_id: Some("attachment-7".into()),
            attachment_generation: Some(1),
        };
        let json = serde_json::to_string(&welcome).unwrap();
        assert!(json.contains(r#""attachmentId":"attachment-7""#), "{json}");
        assert!(json.contains(r#""attachmentGeneration":1"#), "{json}");

        let one_tab = RemoteHostMsg::Welcome {
            proto: 4,
            tab_title: "Files".into(),
            cols: 0,
            rows: 0,
            tab_type: Some(SharedTabType::Contribution),
            attachment_id: Some("attachment-8".into()),
            attachment_generation: Some(1),
        };
        let json = serde_json::to_string(&one_tab).unwrap();
        assert!(json.contains(r#""tabType":"contribution""#), "{json}");

        let snapshot = RemoteHostMsg::ContributionSnapshot {
            tab_id: "browser-1".into(),
            kind: "browser".into(),
            epoch: "epoch-1".into(),
            snapshot_revision: 8,
            last_frame_seq: 13,
            state: serde_json::json!({"url": "http://intranet/"}),
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        match serde_json::from_str::<RemoteHostMsg>(&json).unwrap() {
            RemoteHostMsg::ContributionSnapshot {
                tab_id,
                kind,
                snapshot_revision,
                last_frame_seq,
                ..
            } => {
                assert_eq!(tab_id, "browser-1");
                assert_eq!(kind, "browser");
                assert_eq!((snapshot_revision, last_frame_seq), (8, 13));
            }
            other => panic!("{other:?}"),
        }

        let intent = RemoteClientMsg::RemoteIntent {
            tab_id: "browser-1".into(),
            attachment_id: "attachment-7".into(),
            attachment_generation: 1,
            intent_id: "intent-1".into(),
            name: "browser.navigate".into(),
            args: serde_json::json!({"url": "http://intranet/"}),
        };
        let json = serde_json::to_string(&intent).unwrap();
        assert!(matches!(
            serde_json::from_str::<RemoteClientMsg>(&json).unwrap(),
            RemoteClientMsg::RemoteIntent {
                attachment_generation: 1,
                ..
            }
        ));
    }

    #[test]
    fn browser_http_stream_v2_frames_preserve_binary_and_flow_control_fields() {
        let open = RemoteClientMsg::BrowserOpen {
            stream_id: 9,
            tab_id: "browser-1".into(),
            grant_id: "browser-grant-v1:attachment-7:3:browser-1".into(),
            attachment_id: "attachment-7".into(),
            attachment_generation: 3,
            method: "POST".into(),
            url: "https://intranet/upload".into(),
            headers: vec![("content-type".into(), "application/octet-stream".into())],
            body_len: Some(5),
        };
        let json = serde_json::to_string(&open).unwrap();
        assert!(json.contains(r#""type":"browserOpen""#), "{json}");
        assert!(matches!(
            serde_json::from_str::<RemoteClientMsg>(&json).unwrap(),
            RemoteClientMsg::BrowserOpen {
                stream_id: 9,
                grant_id,
                attachment_generation: 3,
                body_len: Some(5),
                ..
            } if grant_id == "browser-grant-v1:attachment-7:3:browser-1"
        ));

        for frame in [
            RemoteHostMsg::BrowserResponseHead {
                stream_id: 9,
                status: 200,
                headers: vec![("content-type".into(), "application/octet-stream".into())],
                final_url: "https://intranet/final".into(),
            },
            RemoteHostMsg::BrowserResponseChunk {
                stream_id: 9,
                seq: 0,
                b64: "AP8=".into(),
            },
            RemoteHostMsg::BrowserResponseEnd { stream_id: 9 },
            RemoteHostMsg::BrowserResponseError {
                stream_id: 10,
                code: "unsupported-sse".into(),
                message: "not enabled".into(),
            },
        ] {
            let json = serde_json::to_string(&frame).unwrap();
            serde_json::from_str::<RemoteHostMsg>(&json).unwrap();
        }
        let credit = serde_json::to_string(&RemoteClientMsg::BrowserCredit {
            stream_id: 9,
            bytes: 65_536,
        })
        .unwrap();
        assert!(credit.contains(r#""bytes":65536"#), "{credit}");
    }
}
