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
    Agent,
    /// v3: the whole app, not one tab. A v2 client has no renderer for this
    /// and must be told "cannot display" rather than shown a blank grid;
    /// the hub rejects the join before any app frame is sent.
    App,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    /// Watch only.
    View,
    /// Watch, and put input in — type at the terminal, prompt the agent, stop
    /// a turn. Cannot authorise a tool call.
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

    // ── v2: agent tabs ───────────────────────────────────────────────────
    /// Say something to the agent. Requires Steer.
    #[serde(rename_all = "camelCase")]
    AgentPrompt { text: String },
    /// Answer a permission request. Requires Approve.
    #[serde(rename_all = "camelCase")]
    AgentAnswer {
        call_id: String,
        allow: bool,
        reason: Option<String>,
    },
    /// Stop the turn in progress. Requires Steer.
    AgentCancel,

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

    // ── v2: agent tabs ───────────────────────────────────────────────────
    /// One session event, verbatim.
    ///
    /// Carried as JSON rather than as a typed event so this crate stays free of
    /// the agent runtime: it is compiled into the browser wasm client too, and
    /// the whole turn loop has no business going there. Both ends recover the
    /// type at their own edge.
    #[serde(rename_all = "camelCase")]
    AgentEvent {
        event: serde_json::Value,
    },
    /// Everything that happened before this viewer arrived, in order.
    ///
    /// Separate from `AgentEvent` so a client can tell catching up from
    /// watching, and can render the backlog in one pass rather than animating
    /// its way through a run that already finished.
    #[serde(rename_all = "camelCase")]
    AgentSnapshot {
        events: Vec<serde_json::Value>,
    },
    /// Somebody else answered a permission request first.
    ///
    /// Sent to whoever lost the race, rather than dropping their answer in
    /// silence: a button that does nothing and says nothing is indistinguishable
    /// from a broken one.
    #[serde(rename_all = "camelCase")]
    AgentDecisionTaken {
        call_id: String,
        /// Who decided, for display. "the host" or a viewer's name.
        by: String,
    },

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
}

/// Highest protocol version this build speaks.
pub const REMOTE_PROTO_VERSION: u32 = 3;

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
pub fn agent_payloads_allowed(proto: u32) -> bool {
    proto >= 2
}

/// Can the app-level payload family be sent to a client speaking `proto`?
/// Same rule as the agent family: an older client's decoder fails the whole
/// connection on an unknown variant.
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
            "someone allowed to talk to the agent is not thereby allowed to authorise it"
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
    fn agent_payloads_are_withheld_from_a_v1_client() {
        // Its decoder fails the connection on an unknown variant, so this is
        // the difference between an old client working and an old client
        // dropping mid-session.
        assert!(!agent_payloads_allowed(1));
        assert!(agent_payloads_allowed(2));
    }

    #[test]
    fn agent_frames_round_trip_with_their_payload_intact() {
        let event = serde_json::json!({ "type": "assistant_text", "delta": "hi" });
        let frame = RemoteHostMsg::AgentEvent {
            event: event.clone(),
        };
        let json = serde_json::to_string(&frame).unwrap();
        match serde_json::from_str::<RemoteHostMsg>(&json).unwrap() {
            RemoteHostMsg::AgentEvent { event: got } => assert_eq!(got, event),
            other => panic!("{other:?}"),
        }

        let answer = RemoteClientMsg::AgentAnswer {
            call_id: "c1".into(),
            allow: false,
            reason: Some("not that one".into()),
        };
        let json = serde_json::to_string(&answer).unwrap();
        assert!(json.contains("\"callId\""), "camelCase on the wire: {json}");
        match serde_json::from_str::<RemoteClientMsg>(&json).unwrap() {
            RemoteClientMsg::AgentAnswer {
                call_id,
                allow,
                reason,
            } => {
                assert_eq!(call_id, "c1");
                assert!(!allow);
                assert_eq!(reason.as_deref(), Some("not that one"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_welcome_for_an_agent_tab_says_so() {
        let frame = RemoteHostMsg::Welcome {
            proto: 2,
            tab_title: "Agent".into(),
            cols: 0,
            rows: 0,
            tab_type: Some(SharedTabType::Agent),
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"tabType\":\"agent\""), "{json}");
    }

    #[test]
    fn v3_frames_round_trip_and_withhold_from_older_clients() {
        // The app payload family: round-trips intact, and is never sent to a
        // client below v3, whose decoder fails the connection on an unknown
        // variant (the same rule the agent family rests on).
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
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"tabType\":\"app\""), "{json}");

        // The v2 wire: an agent welcome from before this change parses to
        // exactly what it did, and a v2 terminal welcome carries no tabType.
        let v2 = RemoteHostMsg::Welcome {
            proto: 2,
            tab_title: "zsh".into(),
            cols: 80,
            rows: 24,
            tab_type: Some(SharedTabType::Terminal),
        };
        let json = serde_json::to_string(&v2).unwrap();
        assert!(json.contains("\"tabType\":\"terminal\""), "{json}");
        assert_eq!(negotiate(2), 2, "a v2 client stays on v2");
    }
}
