//! Tools the coding agent may invoke.
//!
//! One trait, one shape of result, and a context that carries the filesystem
//! surface plus a cancellation flag. The agent loop owns the decision of *when*
//! to run a tool and whether it is permitted; this crate only knows *how*.
//!
//! Two things in the result deserve their placement. `location` is a first-class
//! field rather than something parsed back out of the text: the whole point of
//! the agent tab is that a file a tool touched can be opened in a real files tab,
//! and that only works if every tool reports where it acted. `truncation` is
//! likewise structured, because the UI needs to say "showing 2000 of 48231 lines"
//! without re-deriving it from a sentence.

pub mod edit_diff;
pub mod env;
pub mod path;
pub mod tools;
pub mod truncate;

use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use truncate::Truncation;

/// Cooperative cancellation. Tools check this between steps; a long-running
/// command also gets killed by the bash tool itself.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// Disarm the token so the next piece of work starts uncancelled.
    ///
    /// Stopping is about the turn in front of the user, not about the session:
    /// a token that stayed set after a stop would make every later prompt end
    /// before it began. The caller rearms at the point it starts new work,
    /// which is also the only point where "nothing is running" is knowable.
    pub fn reset(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    /// Convenience for the `?`-heavy bodies of tool implementations.
    pub fn bail_if_cancelled(&self) -> Result<()> {
        if self.is_cancelled() {
            anyhow::bail!("operation cancelled");
        }
        Ok(())
    }
}

/// Where a tool acted, so the UI can bring up the corresponding tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolLocation {
    pub path: std::path::PathBuf,
    /// 1-indexed, when the tool knows which line it touched.
    pub line: Option<u32>,
}

impl ToolLocation {
    pub fn file(path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            path: path.into(),
            line: None,
        }
    }

    pub fn at_line(path: impl Into<std::path::PathBuf>, line: u32) -> Self {
        Self {
            path: path.into(),
            line: Some(line),
        }
    }
}

/// A piece of what a tool produced. Images exist because `read` can return one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentBlock {
    Text(String),
    Image { base64: String, mime_type: String },
}

impl ContentBlock {
    pub fn text(s: impl Into<String>) -> Self {
        ContentBlock::Text(s.into())
    }

    /// The text of this block, or empty for non-text blocks. Test convenience.
    pub fn as_text(&self) -> &str {
        match self {
            ContentBlock::Text(t) => t,
            ContentBlock::Image { .. } => "",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ToolOutput {
    pub content: Vec<ContentBlock>,
    pub truncation: Option<Truncation>,
    pub location: Option<ToolLocation>,
}

impl ToolOutput {
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::text(s)],
            ..Default::default()
        }
    }

    pub fn with_location(mut self, location: ToolLocation) -> Self {
        self.location = Some(location);
        self
    }

    pub fn with_truncation(mut self, truncation: Truncation) -> Self {
        self.truncation = Some(truncation);
        self
    }

    /// All text blocks joined. Test and logging convenience.
    pub fn joined_text(&self) -> String {
        self.content
            .iter()
            .map(ContentBlock::as_text)
            .collect::<Vec<_>>()
            .join("")
    }
}

/// Incremental output while a tool is still running (a build printing lines).
pub enum ToolProgress {
    Output(String),
}

/// What a tool is given at execution time.
pub struct ToolContext<'a> {
    pub env: &'a dyn env::ExecutionEnv,
    pub cancel: &'a CancelToken,
}

impl<'a> ToolContext<'a> {
    pub fn new(env: &'a dyn env::ExecutionEnv, cancel: &'a CancelToken) -> Self {
        Self { env, cancel }
    }
}

/// A callable the model may request. `parameters` is the JSON Schema shown to
/// the model; `execute` receives whatever it sent back, still as JSON, and is
/// responsible for validating it.
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> String;
    fn parameters(&self) -> serde_json::Value;
    fn execute(
        &self,
        input: serde_json::Value,
        ctx: &ToolContext<'_>,
        on_progress: &mut dyn FnMut(ToolProgress),
    ) -> Result<ToolOutput>;
}

/// The built-in set, in the order they are advertised to the model.
pub fn builtin_tools() -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(tools::read::ReadTool),
        Box::new(tools::write::WriteTool),
        Box::new(tools::edit::EditTool),
        Box::new(tools::bash::BashTool),
        Box::new(tools::glob::GlobTool::default()),
        Box::new(tools::grep::GrepTool),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_token_starts_clear_and_latches() {
        let token = CancelToken::new();
        assert!(!token.is_cancelled());
        assert!(token.bail_if_cancelled().is_ok());
        token.cancel();
        assert!(token.is_cancelled());
        assert!(token.bail_if_cancelled().is_err());
    }

    #[test]
    fn builtin_tools_have_unique_names() {
        let tools = builtin_tools();
        let mut names: Vec<&str> = tools.iter().map(|t| t.name()).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count, "tool names must be unique");
    }

    #[test]
    fn builtin_tools_declare_object_schemas() {
        for tool in builtin_tools() {
            let schema = tool.parameters();
            assert_eq!(
                schema["type"],
                "object",
                "{} must declare an object schema",
                tool.name()
            );
            assert!(
                schema["properties"].is_object(),
                "{} must declare properties",
                tool.name()
            );
        }
    }
}
