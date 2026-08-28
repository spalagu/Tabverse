//! The agent runtime.
//!
//! Four pieces, and the boundaries between them are the point:
//!
//! - [`event`] — what the session emits. The tab, the remote peer and the
//!   session log all read this one stream, which is what keeps them consistent
//!   without three implementations having to agree.
//! - [`provider`] — the model behind the session, behind a trait so the loop can
//!   be driven by a script in tests and so a change of provider stays local.
//! - [`permission`] — the point every tool call passes through. Rules answer
//!   instantly; only what they decline reaches a human.
//! - [`session`] — the loop itself.
//!
//! Tools live in `tabverse-agent-tools`: this crate decides *when* something runs
//! and whether it may, that one knows *how*.

pub mod branch;
pub mod cache;
pub mod codex;
pub mod compact;
pub mod event;
pub mod log;
pub mod memory;
pub mod permission;
pub mod provider;
pub mod session;

pub use event::{EventLog, EventSink, PermissionOutcome, SessionEvent, StopReason};
pub use log::{Replay, SessionLog, LOG_VERSION};
pub use permission::{AllowReadOnly, ApprovalGate, AskEverything, Decision, Policy};
pub use provider::{Message, Provider, ProviderEvent, ToolCall, ToolSpec, TurnOutcome};
pub use session::{Session, DEFAULT_MAX_ROUNDS};
