//! The agent adapter: one agent session as the hub's `ShareSource`.
//!
//! Runtime handles arrive as injected closures, because this crate has no
//! dependency on the app's agent registry and cannot have one: the glue layer
//! hands in "say this to the session", "decide this approval", "stop the
//! turn", "replay what has happened" and "point the event fan-out at a share",
//! and the adapter owns nothing else — an agent has no grid, no ordered byte
//! stream and no snapshot dance, so the trait's defaults already say the rest.

use std::sync::Arc;

use tabverse_proto::{Access, SharedTabType};

use super::{InputOutcome, InputPayload, ShareSource, ViewerId, Viewport};
use crate::{Share, ShareBinding};

/// Glue-injected: a viewer said something to the agent.
pub type PromptHook = Arc<dyn Fn(&str) + Send + Sync>;
/// Glue-injected: a viewer decided a permission request; returns whether that
/// answer was the one that took effect (false = somebody else got there
/// first, which is the race result the hub broadcasts).
pub type AnswerHook = Arc<dyn Fn(&str, bool, Option<String>) -> bool + Send + Sync>;
/// Glue-injected: a viewer stopped the turn in progress.
pub type CancelHook = Arc<dyn Fn() + Send + Sync>;
/// Glue-injected: everything that has happened in the session so far, for a
/// viewer that has just arrived.
pub type HistoryHook = Arc<dyn Fn() -> Vec<serde_json::Value> + Send + Sync>;
/// Glue-injected: point the session's event fan-out at a share (Some) or away
/// from one (None) — where `bind`/`unbind` land on the runtime's side.
pub type SetBroadcastHook = Arc<dyn Fn(Option<Arc<Share>>) + Send + Sync>;

/// The verbs a shared agent session offers viewers, as closures reaching back
/// into the runtime that owns it (the app's agent registry, or a test's
/// recording doubles).
pub struct AgentHooks {
    pub prompt: PromptHook,
    pub answer: AnswerHook,
    pub cancel: CancelHook,
    pub history: HistoryHook,
    pub set_broadcast: SetBroadcastHook,
}

pub struct AgentSource {
    hooks: AgentHooks,
}

impl AgentSource {
    pub fn new(hooks: AgentHooks) -> Self {
        Self { hooks }
    }
}

impl ShareSource for AgentSource {
    fn kind(&self) -> SharedTabType {
        SharedTabType::Agent
    }

    /// An agent has no grid. None travels as zeroes on the wire, so a client
    /// that tries to lay one out gets an obvious answer instead of a
    /// plausible wrong one.
    fn grid(&self) -> Option<Viewport> {
        None
    }

    fn history(&self) -> Vec<serde_json::Value> {
        (self.hooks.history)()
    }

    fn inject_input(
        &self,
        _viewer: ViewerId,
        _access: Access,
        payload: InputPayload,
    ) -> anyhow::Result<InputOutcome> {
        match payload {
            // The hub gates raw bytes by share kind before the source, so one
            // landing here is a hub bug. An error the hub logs beats a silent
            // drop — the same stance the terminal adapter takes on agent
            // frames.
            InputPayload::Bytes(_) => {
                anyhow::bail!("an agent source cannot take raw terminal bytes")
            }
            InputPayload::AgentPrompt { text } => {
                (self.hooks.prompt)(&text);
                Ok(InputOutcome::Applied)
            }
            InputPayload::AgentAnswer {
                call_id,
                allow,
                reason,
            } => {
                if (self.hooks.answer)(&call_id, allow, reason) {
                    Ok(InputOutcome::Applied)
                } else {
                    Ok(InputOutcome::Raced)
                }
            }
            InputPayload::AgentCancel => {
                (self.hooks.cancel)();
                Ok(InputOutcome::Applied)
            }
            // The app-share frames only reach app shares; one landing here
            // is a hub bug, and an error the hub logs beats a silent drop.
            InputPayload::Rpc { .. }
            | InputPayload::Action { .. }
            | InputPayload::ClipPush { .. }
            | InputPayload::ProxyReq { .. } => {
                anyhow::bail!("an agent source cannot take app-share input")
            }
        }
    }

    fn bind(&self, binding: ShareBinding) {
        (self.hooks.set_broadcast)(Some(binding.share));
    }

    fn unbind(&self) {
        (self.hooks.set_broadcast)(None);
    }
}
