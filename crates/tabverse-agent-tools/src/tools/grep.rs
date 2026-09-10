//! Search file contents by regular expression.
//!
//! Built on ripgrep's own engine (`grep-searcher` + `grep-regex`) rather than a
//! hand-rolled line loop, because the hard parts are the ones a loop gets wrong:
//! binary files must be detected and skipped instead of dumping bytes into the
//! context, and a minified bundle's single 2MB line must not become the entire
//! result. The per-line cap is the second of those guards.

use crate::path::resolve_tool_path;
use crate::truncate::{truncate_head, Limits, DEFAULT_MAX_LINES, GREP_MAX_LINE_LENGTH};
use crate::{Tool, ToolContext, ToolLocation, ToolOutput, ToolProgress};
use anyhow::{Context, Result};
use globset::{Glob, GlobMatcher};
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct GrepInput {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    /// Restrict to files whose path matches this glob, e.g. `**/*.rs`.
    #[serde(default)]
    glob: Option<String>,
    #[serde(default)]
    case_insensitive: bool,
}

#[derive(Debug, Clone)]
struct Hit {
    path: PathBuf,
    line: u64,
    text: String,
}

#[derive(Default)]
pub struct GrepTool;

impl Tool for GrepTool {
    fn name(&self) -> &'static str {
        "grep"
    }

    fn description(&self) -> String {
        format!(
            "Search file contents with a regular expression. Returns matching lines as \
             `path:line: text`, capped at {DEFAULT_MAX_LINES} matches and 50KB, with each line \
             truncated to {GREP_MAX_LINE_LENGTH} characters. Binary files and paths excluded by .gitignore are \
             skipped. Use glob to restrict which files are searched."
        )
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regular expression to search for" },
                "path": { "type": "string", "description": "Directory to search in (defaults to the working directory)" },
                "glob": { "type": "string", "description": "Only search files whose path matches this glob, e.g. **/*.rs" },
                "case_insensitive": { "type": "boolean", "description": "Case-insensitive matching (default false)" }
            },
            "required": ["pattern"],
            "additionalProperties": false
        })
    }

    fn execute(
        &self,
        input: serde_json::Value,
        ctx: &ToolContext<'_>,
        _on_progress: &mut dyn FnMut(ToolProgress),
    ) -> Result<ToolOutput> {
        let args: GrepInput = super::parse_input(self.name(), input)?;
        ctx.cancel.bail_if_cancelled()?;

        let root = match &args.path {
            Some(p) => resolve_tool_path(ctx.env, p)?,
            None => ctx.env.cwd().to_path_buf(),
        };

        let matcher = RegexMatcher::new_line_matcher(&if args.case_insensitive {
            format!("(?i){}", args.pattern)
        } else {
            args.pattern.clone()
        })
        .with_context(|| format!("invalid regular expression: {}", args.pattern))?;

        let file_filter: Option<GlobMatcher> = match &args.glob {
            Some(g) => Some(
                Glob::new(g)
                    .with_context(|| format!("invalid glob pattern: {g}"))?
                    .compile_matcher(),
            ),
            None => None,
        };

        // Binary detection is off by default in grep-searcher. Left off, a match
        // inside a compiled artifact dumps raw bytes straight into the model's
        // context; `quit` abandons the file at the first NUL instead.
        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            .binary_detection(BinaryDetection::quit(0))
            .build();
        let mut hits: Vec<Hit> = Vec::new();

        // require_git(false) for the same reason as the glob tool: an agent often
        // works in a directory that is not a repository, and .gitignore there
        // still means what it says.
        for entry in ignore::WalkBuilder::new(&root)
            .hidden(false)
            .require_git(false)
            .build()
        {
            ctx.cancel.bail_if_cancelled()?;
            if hits.len() >= DEFAULT_MAX_LINES {
                break;
            }
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let path = entry.path();
            if let Some(filter) = &file_filter {
                let relative = path.strip_prefix(&root).unwrap_or(path);
                if !filter.is_match(relative) {
                    continue;
                }
            }
            search_one(&mut searcher, &matcher, path, &mut hits);
        }

        if hits.is_empty() {
            return Ok(ToolOutput::text(format!(
                "No matches for `{}` under {}",
                args.pattern,
                root.display()
            )));
        }

        let first = hits[0].clone();
        let found = hits.len();
        let listing = hits
            .iter()
            .map(|h| format!("{}:{}: {}", h.path.display(), h.line, h.text))
            .collect::<Vec<_>>()
            .join("\n");
        // Counting matches is not the same as bounding size: 2000 hits with
        // lines up to the per-line ceiling is a megabyte. Both limits apply.
        let kept = truncate_head(&listing, Limits::default());
        let mut body = kept.text;
        if kept.info.lines < found {
            body.push_str(&format!(
                "\n\n[showing {} of {found} matches; the rest did not fit]",
                kept.info.lines
            ));
        }

        Ok(ToolOutput::text(body)
            .with_location(ToolLocation::at_line(first.path, first.line as u32)))
    }
}

/// Search a single file, appending to `hits`. Unreadable or binary files are
/// skipped silently — one unreadable file should not fail a whole search.
fn search_one(searcher: &mut Searcher, matcher: &RegexMatcher, path: &Path, hits: &mut Vec<Hit>) {
    let mut collector = Collector {
        path: path.to_path_buf(),
        hits,
    };
    let _ = searcher.search_path(matcher, path, &mut collector);
}

struct Collector<'a> {
    path: PathBuf,
    hits: &'a mut Vec<Hit>,
}

impl Sink for &mut Collector<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.hits.len() >= DEFAULT_MAX_LINES {
            // Returning false stops the search for this file.
            return Ok(false);
        }
        let raw = String::from_utf8_lossy(mat.bytes());
        let text = clamp_line(raw.trim_end_matches(['\n', '\r']));
        self.hits.push(Hit {
            path: self.path.clone(),
            line: mat.line_number().unwrap_or(0),
            text,
        });
        Ok(true)
    }
}

/// One minified line must not eat the whole result. Truncates on a character
/// boundary so the output stays valid UTF-8.
fn clamp_line(line: &str) -> String {
    if line.chars().count() <= GREP_MAX_LINE_LENGTH {
        return line.to_string();
    }
    let kept: String = line.chars().take(GREP_MAX_LINE_LENGTH).collect();
    format!("{kept}… [line truncated]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::LocalEnv;
    use crate::CancelToken;

    fn run(env: &LocalEnv, input: serde_json::Value) -> Result<ToolOutput> {
        let cancel = CancelToken::new();
        let ctx = ToolContext::new(env, &cancel);
        GrepTool.execute(input, &ctx, &mut |_| {})
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(
            dir.path().join("src/main.rs"),
            "fn main() {\n    let answer = 42;\n    println!(\"{answer}\");\n}\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("src/notes.md"), "the answer is 42\n").unwrap();
        std::fs::write(dir.path().join("README.md"), "No digits here\n").unwrap();
        dir
    }

    #[test]
    fn finds_matches_with_path_and_line_number() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "answer" })).unwrap();
        let text = out.joined_text();
        assert!(text.contains("main.rs:2:"), "got: {text}");
        assert!(text.contains("notes.md:1:"), "got: {text}");
        assert!(!text.contains("README.md"));
    }

    #[test]
    fn reports_first_hit_with_a_line_for_jumping() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "answer" })).unwrap();
        let location = out.location.expect("grep must report where to jump");
        assert!(location.line.is_some_and(|l| l > 0), "line number required");
    }

    #[test]
    fn glob_restricts_which_files_are_searched() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "answer", "glob": "**/*.rs" })).unwrap();
        let text = out.joined_text();
        assert!(text.contains("main.rs"));
        assert!(!text.contains("notes.md"), "glob must exclude it: {text}");
    }

    #[test]
    fn case_insensitive_is_opt_in() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        assert!(run(&env, json!({ "pattern": "ANSWER" }))
            .unwrap()
            .joined_text()
            .starts_with("No matches"));
        assert!(run(
            &env,
            json!({ "pattern": "ANSWER", "case_insensitive": true })
        )
        .unwrap()
        .joined_text()
        .contains("main.rs"));
    }

    #[test]
    fn a_very_long_line_is_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let long = format!("needle{}", "x".repeat(5000));
        std::fs::write(dir.path().join("min.js"), long).unwrap();
        let env = LocalEnv::new(dir.path());

        let out = run(&env, json!({ "pattern": "needle" })).unwrap();
        let text = out.joined_text();
        assert!(
            text.contains("[line truncated]"),
            "got {} chars",
            text.len()
        );
        assert!(
            text.chars().count() < GREP_MAX_LINE_LENGTH + 200,
            "one long line must not dominate the result"
        );
    }

    #[test]
    fn binary_files_do_not_leak_bytes() {
        let dir = tempfile::tempdir().unwrap();
        // NUL bytes make this binary as far as the searcher is concerned.
        let mut blob = b"needle".to_vec();
        blob.extend_from_slice(&[0u8; 64]);
        std::fs::write(dir.path().join("blob.bin"), blob).unwrap();
        std::fs::write(dir.path().join("plain.txt"), "needle here\n").unwrap();
        let env = LocalEnv::new(dir.path());

        let out = run(&env, json!({ "pattern": "needle" })).unwrap();
        let text = out.joined_text();
        assert!(text.contains("plain.txt"), "text file must still match");
        assert!(
            !text.contains('\0'),
            "binary content must not reach the output"
        );
    }

    #[test]
    fn gitignored_files_are_skipped_outside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("build")).unwrap();
        std::fs::write(dir.path().join("keep.txt"), "needle here\n").unwrap();
        std::fs::write(dir.path().join("build/generated.txt"), "needle there\n").unwrap();
        std::fs::write(dir.path().join(".gitignore"), "build/\n").unwrap();
        let env = LocalEnv::new(dir.path());

        let out = run(&env, json!({ "pattern": "needle" })).unwrap();
        let text = out.joined_text();
        assert!(text.contains("keep.txt"), "got: {text}");
        assert!(
            !text.contains("generated.txt"),
            "grep must honour .gitignore even when the tree is not a git repo: {text}"
        );
    }

    #[test]
    fn no_match_says_so_without_failing() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "zzz-not-present" })).unwrap();
        assert!(out.joined_text().starts_with("No matches"));
        assert!(out.location.is_none());
    }

    #[test]
    fn invalid_regex_is_an_error_naming_the_pattern() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let err = run(&env, json!({ "pattern": "(unclosed" })).unwrap_err();
        assert!(err.to_string().contains("unclosed"), "got: {err}");
    }

    #[test]
    fn many_wide_matches_stay_inside_the_byte_budget() {
        // Two thousand hits at the per-line ceiling is a megabyte: the match
        // count bounds how many, never how much.
        let dir = tempfile::tempdir().unwrap();
        let wide = format!("needle {}", "x".repeat(400));
        for i in 0..400 {
            std::fs::write(dir.path().join(format!("f{i}.txt")), &wide).unwrap();
        }
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "needle" })).unwrap();
        let text = out.joined_text();

        assert!(
            text.len() <= crate::truncate::DEFAULT_MAX_BYTES + 300,
            "got {} bytes",
            text.len()
        );
        assert!(
            text.contains("did not fit"),
            "dropped matches must be declared, got tail: {}",
            &text[text.len().saturating_sub(200)..]
        );
    }

    #[test]
    fn a_search_that_fits_says_nothing_about_dropping_anything() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "needle here").unwrap();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "needle" })).unwrap();
        assert!(!out.joined_text().contains("did not fit"));
    }
}
