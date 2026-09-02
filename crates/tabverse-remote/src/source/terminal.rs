//! The terminal adapter: one PTY-backed tab as the hub's `ShareSource`.
//!
//! Runtime handles arrive as injected closures, because this crate has no
//! dependency on `tabverse-term` (dev-only) nor on the app's event plumbing:
//! the glue layer hands in "write these bytes to the PTY" and "announce the
//! joint viewport to the local view", and the adapter owns everything in
//! between — the ordered dispatch bridge and the current grid.

use std::sync::{Arc, Mutex};

use tabverse_proto::{Access, SharedTabType};

use super::{InputOutcome, InputPayload, ShareSource, ViewerId, Viewport};
use crate::bridge::SessionBridge;
use crate::ShareBinding;

/// Glue-injected: write viewer bytes into the PTY (`terms.write(session, _)`).
pub type WritePty = Arc<dyn Fn(&[u8]) + Send + Sync>;
/// Glue-injected: tell the local view what the joint viewer viewport is now
/// (the app emits a `share-viewport` event; a test records the value).
pub type EmitViewport = Arc<dyn Fn(Option<Viewport>) + Send + Sync>;

pub struct TerminalSource {
    /// Ordered output dispatch for this session. `bind`/`unbind` attach and
    /// detach the share's fan-out here, and snapshot markers enter the byte
    /// stream through it — the lock inside is what makes `snapshot + buffer`
    /// gapless.
    bridge: Arc<SessionBridge>,
    write_pty: WritePty,
    emit_viewport: EmitViewport,
    /// The PTY grid as of `term_create`, kept current by `term_resize` — what
    /// a share started later reports in `Welcome`.
    grid: Mutex<Viewport>,
}

impl TerminalSource {
    pub fn new(
        bridge: Arc<SessionBridge>,
        write_pty: WritePty,
        emit_viewport: EmitViewport,
        grid: Viewport,
    ) -> Self {
        Self {
            bridge,
            write_pty,
            emit_viewport,
            grid: Mutex::new(grid),
        }
    }

    /// The host resized the PTY. Keeps `grid()` truthful for a share started
    /// after the resize; a share already live learns of it through the
    /// bridge's `dispatch_resize`, not through here.
    pub fn set_grid(&self, grid: Viewport) {
        *self.grid.lock().unwrap() = grid;
    }
}

impl ShareSource for TerminalSource {
    fn kind(&self) -> SharedTabType {
        SharedTabType::Terminal
    }

    fn grid(&self) -> Option<Viewport> {
        Some(*self.grid.lock().unwrap())
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
        match payload {
            InputPayload::Bytes(bytes) => {
                (self.write_pty)(&bytes);
                Ok(InputOutcome::Applied)
            }
            // The app-share frames only route to app shares (same rule, same
            // stance: an error the hub logs beats a silent drop).
            InputPayload::Rpc { .. }
            | InputPayload::Action { .. }
            | InputPayload::ClipPush { .. }
            | InputPayload::ProxyReq { .. }
            | InputPayload::BrowserOpen { .. }
            | InputPayload::BrowserRequestChunk { .. }
            | InputPayload::BrowserRequestEnd { .. }
            | InputPayload::BrowserCredit { .. }
            | InputPayload::BrowserCancel { .. }
            | InputPayload::RemoteAck { .. }
            | InputPayload::RemoteResnapshot { .. }
            | InputPayload::RemoteIntent { .. } => {
                anyhow::bail!("a terminal source cannot take app-share input")
            }
        }
    }

    fn apply_viewport(&self, joint: Option<Viewport>) {
        (self.emit_viewport)(joint)
    }

    fn bind(&self, binding: ShareBinding) {
        self.bridge.attach_share(binding);
    }

    fn unbind(&self) {
        let _ = self.bridge.detach_share();
    }
}
