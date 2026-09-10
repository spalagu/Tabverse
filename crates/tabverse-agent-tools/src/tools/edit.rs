//! Replace targeted text in a file.
//!
//! The shell around `edit_diff`: read, normalize away the things that must
//! survive the round trip (BOM, CRLF), apply, write back. It also absorbs two
//! shapes models actually send that the schema does not describe — `edits` as a
//! JSON *string* instead of an array, and a bare `oldText`/`newText` pair at the
//! top level. Both are cheap to accept and expensive to refuse: refusing costs a
//! whole round trip to say something the tool could have understood.

use crate::edit_diff::{
    apply_edits, detect_line_ending, first_changed_line, normalize_to_lf, restore_line_endings,
    strip_bom, summarize_change, Edit,
};
use crate::path::resolve_tool_path;
use crate::{Tool, ToolContext, ToolLocation, ToolOutput, ToolProgress};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
struct EditSpec {
    old_text: String,
    new_text: String,
}

#[derive(Default)]
pub struct EditTool;

impl Tool for EditTool {
    fn name(&self) -> &'static str {
        "edit"
    }

    fn description(&self) -> String {
        "Replace exact text in a file. Provide one or more edits; each oldText must appear exactly \
         once in the file and must not overlap another edit in the same call. Every edit is matched \
         against the original file, not against the result of the previous one, so offsets do not \
         need to be adjusted. Include enough surrounding context to make each oldText unique."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to edit (relative or absolute)" },
                "edits": {
                    "type": "array",
                    "description": "One or more targeted replacements, each matched against the original file.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_text": { "type": "string", "description": "Exact text to replace; must be unique in the file" },
                            "new_text": { "type": "string", "description": "Replacement text" }
                        },
                        "required": ["old_text", "new_text"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["path", "edits"],
            "additionalProperties": false
        })
    }

    fn execute(
        &self,
        input: serde_json::Value,
        ctx: &ToolContext<'_>,
        _on_progress: &mut dyn FnMut(ToolProgress),
    ) -> Result<ToolOutput> {
        let (path_arg, edits) = parse_edit_input(input)?;
        ctx.cancel.bail_if_cancelled()?;

        let resolved = resolve_tool_path(ctx.env, &path_arg)?;
        if !ctx.env.exists(&resolved) {
            bail!("file not found: {path_arg}");
        }
        let raw = ctx.env.read_file(&resolved)?;
        let original = String::from_utf8_lossy(&raw).into_owned();

        let (bom, body) = strip_bom(&original);
        let ending = detect_line_ending(body);
        let normalized = normalize_to_lf(body);

        let edited = apply_edits(&normalized, &edits, &path_arg)?;
        ctx.cancel.bail_if_cancelled()?;

        let line = first_changed_line(&normalized, &edited);
        let summary = summarize_change(&normalized, &edited);

        let restored = format!("{bom}{}", restore_line_endings(&edited, ending));
        ctx.env.write_file(&resolved, &restored)?;

        let location = match line {
            Some(l) => ToolLocation::at_line(&resolved, l),
            None => ToolLocation::file(&resolved),
        };
        Ok(ToolOutput::text(format!(
            "Applied {} edit(s) to {path_arg} ({summary})",
            edits.len()
        ))
        .with_location(location))
    }
}

/// Accepts the documented shape plus the two the models keep sending anyway.
fn parse_edit_input(input: Value) -> Result<(String, Vec<Edit>)> {
    let Value::Object(mut map) = input else {
        bail!("invalid arguments for the `edit` tool: expected an object");
    };

    let path = match map.remove("path") {
        Some(Value::String(p)) => p,
        _ => bail!("invalid arguments for the `edit` tool: `path` must be a string"),
    };

    // Shape 2: a bare oldText/newText pair instead of an edits array.
    let legacy = match (map.remove("old_text"), map.remove("new_text")) {
        (Some(Value::String(old)), Some(Value::String(new))) => Some(Edit {
            old_text: old,
            new_text: new,
        }),
        _ => None,
    };

    let mut edits: Vec<Edit> = match map.remove("edits") {
        // Shape 1: the array arrived as a JSON string.
        Some(Value::String(raw)) => {
            let parsed: Vec<EditSpec> = serde_json::from_str(&raw).map_err(|e| {
                anyhow::anyhow!("invalid arguments for the `edit` tool: `edits` was a string but not valid JSON ({e})")
            })?;
            parsed.into_iter().map(Into::into).collect()
        }
        Some(value @ Value::Array(_)) => {
            let parsed: Vec<EditSpec> = serde_json::from_value(value)
                .map_err(|e| anyhow::anyhow!("invalid arguments for the `edit` tool: {e}"))?;
            parsed.into_iter().map(Into::into).collect()
        }
        None => Vec::new(),
        Some(_) => bail!("invalid arguments for the `edit` tool: `edits` must be an array"),
    };

    if let Some(single) = legacy {
        edits.push(single);
    }
    if edits.is_empty() {
        bail!("invalid arguments for the `edit` tool: supply at least one edit");
    }
    Ok((path, edits))
}

impl From<EditSpec> for Edit {
    fn from(spec: EditSpec) -> Self {
        Edit {
            old_text: spec.old_text,
            new_text: spec.new_text,
        }
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
        EditTool.execute(input, &ctx, &mut |_| {})
    }

    fn with_file(contents: &str) -> (tempfile::TempDir, LocalEnv) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.rs"), contents).unwrap();
        let env = LocalEnv::new(dir.path());
        (dir, env)
    }

    #[test]
    fn replaces_exact_text_and_reports_the_changed_line() {
        let (dir, env) = with_file("let a = 1;\nlet b = 2;\n");
        let out = run(
            &env,
            json!({ "path": "f.rs", "edits": [{ "old_text": "let b = 2;", "new_text": "let b = 9;" }] }),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.rs")).unwrap(),
            "let a = 1;\nlet b = 9;\n"
        );
        assert_eq!(out.location.as_ref().unwrap().line, Some(2));
    }

    #[test]
    fn applies_several_edits_in_one_call() {
        let (dir, env) = with_file("one\ntwo\nthree\n");
        run(
            &env,
            json!({ "path": "f.rs", "edits": [
                { "old_text": "one", "new_text": "1" },
                { "old_text": "three", "new_text": "3" }
            ]}),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.rs")).unwrap(),
            "1\ntwo\n3\n"
        );
    }

    #[test]
    fn refuses_an_ambiguous_target_without_touching_the_file() {
        let (dir, env) = with_file("x = 1;\nx = 1;\n");
        let err = run(
            &env,
            json!({ "path": "f.rs", "edits": [{ "old_text": "x = 1;", "new_text": "x = 2;" }] }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("appears 2 times"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.rs")).unwrap(),
            "x = 1;\nx = 1;\n",
            "a refused edit must leave the file untouched"
        );
    }

    #[test]
    fn refuses_a_missing_target_without_touching_the_file() {
        let (dir, env) = with_file("hello\n");
        let err = run(
            &env,
            json!({ "path": "f.rs", "edits": [{ "old_text": "goodbye", "new_text": "x" }] }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("not found"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.rs")).unwrap(),
            "hello\n"
        );
    }

    #[test]
    fn crlf_survives_the_round_trip() {
        let (dir, env) = with_file("a\r\nb\r\n");
        run(
            &env,
            json!({ "path": "f.rs", "edits": [{ "old_text": "a", "new_text": "z" }] }),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.rs")).unwrap(),
            "z\r\nb\r\n",
            "editing must not convert a CRLF file to LF"
        );
    }

    #[test]
    fn bom_survives_the_round_trip() {
        let (dir, env) = with_file("\u{FEFF}alpha\nbeta\n");
        run(
            &env,
            json!({ "path": "f.rs", "edits": [{ "old_text": "beta", "new_text": "gamma" }] }),
        )
        .unwrap();
        let after = std::fs::read_to_string(dir.path().join("f.rs")).unwrap();
        assert!(after.starts_with('\u{FEFF}'), "BOM must be preserved");
        assert!(after.contains("gamma"));
    }

    #[test]
    fn accepts_edits_sent_as_a_json_string() {
        let (dir, env) = with_file("hello\n");
        run(
            &env,
            json!({ "path": "f.rs", "edits": "[{\"old_text\":\"hello\",\"new_text\":\"hi\"}]" }),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.rs")).unwrap(),
            "hi\n"
        );
    }

    #[test]
    fn accepts_a_bare_old_new_pair() {
        let (dir, env) = with_file("hello\n");
        run(
            &env,
            json!({ "path": "f.rs", "old_text": "hello", "new_text": "hi" }),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.rs")).unwrap(),
            "hi\n"
        );
    }

    #[test]
    fn missing_file_is_an_error_naming_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let err = run(
            &env,
            json!({ "path": "nope.rs", "edits": [{ "old_text": "a", "new_text": "b" }] }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("nope.rs"));
    }

    #[test]
    fn no_edits_is_refused() {
        let (_dir, env) = with_file("x\n");
        assert!(run(&env, json!({ "path": "f.rs", "edits": [] })).is_err());
    }
}
