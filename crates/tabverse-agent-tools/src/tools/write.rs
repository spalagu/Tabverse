//! Write a file whole, creating parents as needed.

use crate::path::resolve_tool_path;
use crate::{Tool, ToolContext, ToolLocation, ToolOutput, ToolProgress};
use anyhow::Result;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
struct WriteInput {
    path: String,
    content: String,
}

#[derive(Default)]
pub struct WriteTool;

impl Tool for WriteTool {
    fn name(&self) -> &'static str {
        "write"
    }

    fn description(&self) -> String {
        "Write content to a file. Creates the file if it does not exist and overwrites it if it does. \
         Parent directories are created automatically."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to write (relative or absolute)" },
                "content": { "type": "string", "description": "Content to write to the file" }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        })
    }

    fn execute(
        &self,
        input: serde_json::Value,
        ctx: &ToolContext<'_>,
        _on_progress: &mut dyn FnMut(ToolProgress),
    ) -> Result<ToolOutput> {
        let args: WriteInput = super::parse_input(self.name(), input)?;
        ctx.cancel.bail_if_cancelled()?;

        let resolved = resolve_tool_path(ctx.env, &args.path)?;
        ctx.env.write_file(&resolved, &args.content)?;
        ctx.cancel.bail_if_cancelled()?;

        Ok(ToolOutput::text(format!(
            "Wrote {} bytes to {}",
            args.content.len(),
            args.path
        ))
        .with_location(ToolLocation::file(&resolved)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::LocalEnv;
    use crate::CancelToken;

    fn run(env: &LocalEnv, input: serde_json::Value) -> Result<ToolOutput> {
        let cancel = CancelToken::new();
        let ctx = ToolContext::new(env, &cancel);
        WriteTool.execute(input, &ctx, &mut |_| {})
    }

    #[test]
    fn writes_a_new_file_and_reports_location() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());

        let out = run(&env, json!({ "path": "out.txt", "content": "hello" })).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("out.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            out.location.as_ref().unwrap().path,
            dir.path().join("out.txt")
        );
        assert!(out.joined_text().contains("5 bytes"));
    }

    #[test]
    fn overwrites_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("out.txt"), "old").unwrap();
        let env = LocalEnv::new(dir.path());

        run(&env, json!({ "path": "out.txt", "content": "new" })).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("out.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());

        run(&env, json!({ "path": "deep/nested/f.txt", "content": "x" })).unwrap();
        assert!(dir.path().join("deep/nested/f.txt").exists());
    }

    #[test]
    fn missing_content_field_is_rejected_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let err = run(&env, json!({ "path": "x.txt" })).unwrap_err();
        assert!(err.to_string().contains("write"), "got: {err}");
    }
}
