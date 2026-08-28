//! The built-in tools.

pub mod bash;
pub mod edit;
pub mod glob;
pub mod grep;
pub mod read;
pub mod write;

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;

/// Deserialize a tool's arguments, reporting which tool rejected them.
///
/// Models do get this wrong — a missing field, a number where a string belongs —
/// and the resulting message goes back to the model as the tool result, so it
/// has to name the tool and say what was wrong.
pub(crate) fn parse_input<T: DeserializeOwned>(tool: &str, input: serde_json::Value) -> Result<T> {
    serde_json::from_value(input)
        .with_context(|| format!("invalid arguments for the `{tool}` tool"))
}
