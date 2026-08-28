//! Ordered output dispatch for one terminal session.
//!
//! Everything that must observe the byte stream in a consistent order goes
//! through one lock here: the local view, the remote share fan-out, and
//! snapshot markers (which pin the exact stream position where the local view
//! serializes its state for a joining viewer). Keeping this out of the GUI
//! layer is what makes remote control verifiable without a webview.

use std::sync::{Arc, Mutex};

use crate::{RemoteHub, Share};

/// The local view of a session (the app's webview, or a test double).
pub trait LocalSink: Send + Sync + 'static {
    fn data(&self, bytes: &[u8]);
    fn exit(&self, code: Option<i32>);
    /// A viewer needs a snapshot taken at exactly this point of the stream.
    /// Implementors answer asynchronously via `Share::snapshot_ready`.
    fn snapshot_request(&self, viewer: u64);
}

#[derive(Clone)]
pub struct ShareBinding {
    pub share: Arc<Share>,
    pub hub: Arc<RemoteHub>,
}

struct Inner {
    share: Option<ShareBinding>,
}

pub struct SessionBridge {
    local: Arc<dyn LocalSink>,
    inner: Mutex<Inner>,
}

impl SessionBridge {
    pub fn new(local: Arc<dyn LocalSink>) -> Arc<Self> {
        Arc::new(Self {
            local,
            inner: Mutex::new(Inner { share: None }),
        })
    }

    pub fn dispatch_data(&self, bytes: &[u8]) {
        let g = self.inner.lock().unwrap();
        self.local.data(bytes);
        if let Some(b) = &g.share {
            b.share.broadcast_output(bytes);
        }
    }

    pub fn dispatch_exit(&self, code: Option<i32>) {
        let mut g = self.inner.lock().unwrap();
        self.local.exit(code);
        if let Some(b) = g.share.take() {
            b.hub.share_stop(&b.share.id);
        }
    }

    pub fn dispatch_resize(&self, cols: u16, rows: u16) {
        let g = self.inner.lock().unwrap();
        if let Some(b) = &g.share {
            b.share.broadcast_resize(cols, rows);
        }
    }

    pub fn attach_share(&self, binding: ShareBinding) {
        self.inner.lock().unwrap().share = Some(binding);
    }

    pub fn detach_share(&self) -> Option<ShareBinding> {
        self.inner.lock().unwrap().share.take()
    }

    pub fn current_share(&self) -> Option<ShareBinding> {
        self.inner.lock().unwrap().share.clone()
    }

    /// Inject a snapshot marker for `viewer` at the current stream position and
    /// start buffering remote output under the same lock, so
    /// `snapshot + buffer` reproduces the stream with no gap or duplication.
    pub fn inject_snapshot_request(&self, viewer: u64) {
        let g = self.inner.lock().unwrap();
        if let Some(b) = &g.share {
            // Order matters: start queueing *before* asking for the snapshot.
            // A sink that answers synchronously would otherwise be flipped to
            // Live by `snapshot_ready` and then reset back to Buffering here,
            // stranding every later frame in a queue nothing flushes.
            b.share.begin_buffering(viewer);
            self.local.snapshot_request(viewer);
        }
    }
}
