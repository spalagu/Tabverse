//! The share-source abstraction: what the hub speaks to instead of a bag of
//! callbacks.
//!
//! A `ShareSource` is one shared tab's runtime as the transport layer sees it:
//! it says what it is (`kind`, `grid`), produces catch-up state for a joining
//! viewer (`request_snapshot` for ordered streams, `history` for event logs),
//! accepts viewer input the hub has already authorised (`inject_input`),
//! follows the joint viewer viewport (`apply_viewport`), and hooks its output
//! fan-out up when the share goes live (`bind` / `unbind`). The hub keeps
//! policy — access checks, version negotiation, buffering — and the source
//! keeps mechanism; neither reaches into the other's half.

pub mod terminal;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tabverse_proto::{Access, SharedTabType};

use crate::ShareBinding;

/// Hub-issued viewer id, unique across every share on one hub.
pub type ViewerId = u64;

/// A character grid, as sources and viewers reason about one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewport {
    pub cols: u16,
    pub rows: u16,
}

/// One connected viewer as a host UI needs to see it (the presence payload).
#[derive(Debug, Clone)]
pub struct ViewerInfo {
    pub id: ViewerId,
    pub name: String,
    pub access: Access,
}

/// Viewer input, after the hub has finished the per-frame access check.
pub enum InputPayload {
    /// Raw PTY bytes (Steer and above; terminal).
    Bytes(Vec<u8>),
    /// Invoke a host command (Steer and above; app shares, v3).
    Rpc {
        id: u64,
        cmd: String,
        args: serde_json::Value,
    },
    /// A store action to execute (Steer and above; app shares, v3).
    Action {
        name: String,
        args: serde_json::Value,
    },
    /// Clipboard text from the join page (Steer and above; app, v3).
    ClipPush {
        text: String,
    },
    /// An HTTP request for the remote proxy (Steer and above; app, v3).
    ProxyReq {
        id: u64,
        head: String,
        body: Option<String>,
    },
    BrowserOpen {
        stream_id: u64,
        tab_id: String,
        grant_id: String,
        attachment_id: String,
        attachment_generation: u64,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body_len: Option<u64>,
    },
    BrowserRequestChunk {
        stream_id: u64,
        seq: u64,
        b64: String,
    },
    BrowserRequestEnd {
        stream_id: u64,
    },
    BrowserCredit {
        stream_id: u64,
        bytes: u64,
    },
    BrowserCancel {
        stream_id: u64,
        reason: Option<String>,
    },
    /// A viewer acknowledged one ordered contribution frame (v4).
    RemoteAck {
        tab_id: String,
        epoch: String,
        frame_seq: u64,
    },
    /// A viewer detected a gap/epoch change and requires a new snapshot (v4).
    RemoteResnapshot {
        tab_id: String,
        epoch: Option<String>,
    },
    /// A schema-declared contribution intent (v4); attachment identity was
    /// already validated by the hub against the server-issued connection id.
    RemoteIntent {
        tab_id: String,
        attachment_id: String,
        attachment_generation: u64,
        intent_id: String,
        name: String,
        args: serde_json::Value,
    },
}

/// What an injection did.
pub enum InputOutcome {
    Applied,
}

/// One shared tab's runtime, behind the seam the hub talks through.
pub trait ShareSource: Send + Sync + 'static {
    fn kind(&self) -> SharedTabType;

    /// None means cols/rows travel as 0 in `Welcome`.
    fn grid(&self) -> Option<Viewport>;

    /// Ordered-stream snapshot (terminal semantics): put a marker in the
    /// output path and answer later via `Share::snapshot_ready`. Sources
    /// without that semantic keep the empty default.
    fn request_snapshot(&self, _viewer: ViewerId) {}

    /// Injection, called only after the hub let the frame through. `access`
    /// is for audit and logging — enforcement happens in the hub, once; an
    /// adapter enforcing it again would give the rule two places to drift.
    fn inject_input(
        &self,
        viewer: ViewerId,
        access: Access,
        payload: InputPayload,
    ) -> anyhow::Result<InputOutcome>;

    /// The joint viewer viewport changed: the smallest grid every current
    /// viewer can show, or None once nobody constrains it. Grid-bearing
    /// sources shrink to fit (tmux semantics); gridless ones keep the empty
    /// default.
    fn apply_viewport(&self, _joint: Option<Viewport>) {}

    /// A connection left. Requester-private streams owned by that viewer
    /// must be cancelled even when no explicit Cancel frame could arrive.
    fn viewer_detached(&self, _viewer: ViewerId) {}

    /// Host-owned Browser contribution state may rotate the one origin a
    /// shared Browser Tab grants. Other sources reject this capability.
    fn update_browser_grant(&self, _tab_id: &str, _url: &str) -> anyhow::Result<()> {
        anyhow::bail!("this share source does not own Browser network grants")
    }

    /// The share went live: keep the handle and attach the output fan-out
    /// (a terminal hangs it on its dispatch bridge). Called by the hub before
    /// the ticket exists, so nothing a
    /// runtime emits after this can miss the share.
    fn bind(&self, binding: ShareBinding);

    /// The share is over (stop command or runtime death): drop the handle.
    /// The glue layer calls this before `RemoteHub::share_stop` — the hub
    /// itself never does, because runtime-death paths reach `share_stop`
    /// while already holding the very locks an unbind would need.
    fn unbind(&self);
}

/// Sources by tab id. An entry lives exactly as long as that tab's runtime:
/// registered where the runtime is created, unregistered where it dies.
#[derive(Default)]
pub struct SourceRegistry {
    entries: Mutex<HashMap<String, Arc<dyn ShareSource>>>,
}

impl SourceRegistry {
    pub fn register(&self, tab_id: &str, source: Arc<dyn ShareSource>) {
        self.entries
            .lock()
            .unwrap()
            .insert(tab_id.to_string(), source);
    }

    /// Returns the removed source. The caller (the glue layer) is the one
    /// responsible for `RemoteHub::share_stop` on any share the source is
    /// still bound to — unregistering is what tab death looks like from
    /// here, and a dead tab must not keep serving viewers.
    pub fn unregister(&self, tab_id: &str) -> Option<Arc<dyn ShareSource>> {
        self.entries.lock().unwrap().remove(tab_id)
    }

    pub fn get(&self, tab_id: &str) -> Option<Arc<dyn ShareSource>> {
        self.entries.lock().unwrap().get(tab_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The least a source can be; `kind` doubles as its identity in asserts.
    struct NullSource(SharedTabType);

    impl ShareSource for NullSource {
        fn kind(&self) -> SharedTabType {
            self.0
        }
        fn grid(&self) -> Option<Viewport> {
            None
        }
        fn inject_input(
            &self,
            _viewer: ViewerId,
            _access: Access,
            _payload: InputPayload,
        ) -> anyhow::Result<InputOutcome> {
            Ok(InputOutcome::Applied)
        }
        fn bind(&self, _binding: ShareBinding) {}
        fn unbind(&self) {}
    }

    #[test]
    fn the_registry_returns_a_source_until_its_tab_unregisters() {
        let reg = SourceRegistry::default();
        assert!(reg.get("tab-1").is_none(), "an unknown tab has no source");

        reg.register("tab-1", Arc::new(NullSource(SharedTabType::Terminal)));
        reg.register("tab-2", Arc::new(NullSource(SharedTabType::App)));
        assert_eq!(
            reg.get("tab-1")
                .expect("registered source is retrievable")
                .kind(),
            SharedTabType::Terminal
        );
        assert_eq!(
            reg.get("tab-2")
                .expect("each tab holds its own source")
                .kind(),
            SharedTabType::App
        );

        let removed = reg
            .unregister("tab-2")
            .expect("unregister hands the removed source back");
        assert_eq!(removed.kind(), SharedTabType::App);
        assert!(
            reg.get("tab-2").is_none(),
            "an unregistered tab has no source any more"
        );
        assert!(
            reg.unregister("tab-2").is_none(),
            "a second unregister has nothing left to remove"
        );
        assert!(
            reg.get("tab-1").is_some(),
            "unregistering one tab must not touch another"
        );
    }
}
