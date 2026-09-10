//! Find files by name pattern.
//!
//! Walks with `ignore`, which is ripgrep's walker: it honours `.gitignore`,
//! `.ignore` and friends. That default matters more than it looks — a repository
//! with `node_modules/` or `target/` checked out will otherwise bury every real
//! result under build artifacts, and the model pays for each one in context.

use crate::path::resolve_tool_path;
use crate::truncate::{truncate_head, Limits, DEFAULT_MAX_LINES};
use crate::{Tool, ToolContext, ToolLocation, ToolOutput, ToolProgress};
use anyhow::{Context, Result};
use globset::{Glob, GlobMatcher};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::time::SystemTime;

/// Cap on returned paths. A pattern like `**/*` in a large tree would otherwise
/// return a list no one reads and the model cannot afford.
const MAX_RESULTS: usize = DEFAULT_MAX_LINES;

/// How many matches to look at before giving up on completeness.
///
/// Every match costs a stat call for its timestamp, and `**/*` against a home
/// directory means millions of them: one real run spent about three minutes
/// and 3.4 million stats before returning anything. Stopping early makes the
/// answer partial, which beats an answer that arrives after the user has given
/// up — and the notice says so, so the model can narrow the pattern rather
/// than trust a list that quietly left things out.
const MAX_SCAN: usize = 20_000;

#[derive(Debug, Deserialize)]
struct GlobInput {
    pattern: String,
    /// Root to search. Defaults to the working directory.
    #[serde(default)]
    path: Option<String>,
    /// Include files that `.gitignore` would exclude. Off by default.
    #[serde(default)]
    include_ignored: bool,
}

pub struct GlobTool {
    /// Matches to look at before giving up on completeness. A knob rather than
    /// a constant so a test can reach it without laying down twenty thousand
    /// files, and so this can be raised later without touching the walk.
    scan_limit: usize,
}

impl Default for GlobTool {
    fn default() -> Self {
        Self {
            scan_limit: MAX_SCAN,
        }
    }
}

impl GlobTool {
    #[cfg(test)]
    fn with_scan_limit(limit: usize) -> Self {
        Self { scan_limit: limit }
    }
}

impl Tool for GlobTool {
    fn name(&self) -> &'static str {
        "glob"
    }

    fn description(&self) -> String {
        format!(
            "Find files whose path matches a glob pattern (for example `**/*.rs` or `src/**/test_*.py`). \
             Results are sorted by modification time, newest first, and capped at {MAX_RESULTS} \
             and 50KB. The search itself stops after {MAX_SCAN} matches and says so, in which case \
             narrow the pattern rather than trusting the list to be complete. \
             Files excluded by .gitignore are skipped unless include_ignored is set."
        )
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Glob pattern to match against paths, e.g. **/*.rs" },
                "path": { "type": "string", "description": "Directory to search in (defaults to the working directory)" },
                "include_ignored": { "type": "boolean", "description": "Include files excluded by .gitignore (default false)" }
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
        let args: GlobInput = super::parse_input(self.name(), input)?;
        ctx.cancel.bail_if_cancelled()?;

        let root = match &args.path {
            Some(p) => resolve_tool_path(ctx.env, p)?,
            None => ctx.env.cwd().to_path_buf(),
        };

        let matcher = build_matcher(&args.pattern)?;
        let Scan { mut hits, stopped } =
            collect_matches(&root, &matcher, args.include_ignored, self.scan_limit, ctx)?;

        // Newest first: when a model asks for "the test files", the ones just
        // touched are almost always the ones it means.
        hits.sort_by_key(|hit| std::cmp::Reverse(hit.1));
        let total = hits.len();
        hits.truncate(MAX_RESULTS);

        if hits.is_empty() {
            return Ok(ToolOutput::text(format!(
                "No files matching `{}` under {}",
                args.pattern,
                root.display()
            )));
        }

        let first = hits[0].0.clone();
        let listing = hits
            .iter()
            .map(|(p, _)| p.display().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        // The count ceiling is not a size ceiling. A real run returned 2000
        // paths — inside the count limit — that came to 220KB, because paths in
        // a deep tree are long. Both have to apply, and the notice goes on
        // afterwards so it survives.
        let kept = truncate_head(&listing, Limits::default());
        let shown = kept.info.lines;
        let mut body = kept.text;
        if stopped {
            body.push_str(&format!(
                "\n\n[scan stopped after {} matches; showing the {shown} most recently \
                 modified of those. Narrow the pattern or the path for a complete answer]",
                self.scan_limit
            ));
        } else if total > shown {
            body.push_str(&format!("\n\n[showing {shown} of {total} matches]"));
        }

        Ok(ToolOutput::text(body).with_location(ToolLocation::file(first)))
    }
}

fn build_matcher(pattern: &str) -> Result<GlobMatcher> {
    Ok(Glob::new(pattern)
        .with_context(|| format!("invalid glob pattern: {pattern}"))?
        .compile_matcher())
}

/// What a walk found, and whether it was cut short.
struct Scan {
    hits: Vec<(PathBuf, SystemTime)>,
    stopped: bool,
}

fn collect_matches(
    root: &std::path::Path,
    matcher: &GlobMatcher,
    include_ignored: bool,
    scan_limit: usize,
    ctx: &ToolContext<'_>,
) -> Result<Scan> {
    let mut hits = Vec::new();
    let mut stopped = false;
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(!include_ignored)
        .git_global(!include_ignored)
        .git_exclude(!include_ignored)
        .ignore(!include_ignored)
        // Without this, .gitignore is only honoured inside a git repository.
        // An agent often works in a directory that is not one — a scratch tree,
        // an extracted archive — and the user still means what the file says.
        .require_git(false)
        .build();

    for entry in walker {
        ctx.cancel.bail_if_cancelled()?;
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        // Match on the path relative to the search root, so `**/*.rs` behaves the
        // way it reads rather than depending on how deep the root itself sits.
        let relative = path.strip_prefix(root).unwrap_or(path);
        if !matcher.is_match(relative) {
            continue;
        }
        // Two different error types on the way to a timestamp (ignore's, then
        // std's), so flatten through Option rather than chaining Results.
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        hits.push((path.to_path_buf(), modified));
        if hits.len() >= scan_limit {
            stopped = true;
            break;
        }
    }
    Ok(Scan { hits, stopped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::LocalEnv;
    use crate::CancelToken;

    fn run(env: &LocalEnv, input: serde_json::Value) -> Result<ToolOutput> {
        let cancel = CancelToken::new();
        let ctx = ToolContext::new(env, &cancel);
        GlobTool::default().execute(input, &ctx, &mut |_| {})
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("target")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "// lib").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "text").unwrap();
        std::fs::write(dir.path().join("target/built.rs"), "// generated").unwrap();
        std::fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
        dir
    }

    #[test]
    fn matches_by_extension() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "**/*.rs" })).unwrap();
        let text = out.joined_text();
        assert!(text.contains("main.rs"), "got: {text}");
        assert!(text.contains("lib.rs"), "got: {text}");
        assert!(!text.contains("notes.txt"));
    }

    #[test]
    fn gitignored_files_are_skipped() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "**/*.rs" })).unwrap();
        assert!(
            !out.joined_text().contains("built.rs"),
            "target/ is gitignored and must not appear: {}",
            out.joined_text()
        );
    }

    #[test]
    fn include_ignored_brings_them_back() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(
            &env,
            json!({ "pattern": "**/*.rs", "include_ignored": true }),
        )
        .unwrap();
        assert!(
            out.joined_text().contains("built.rs"),
            "explicitly asking for ignored files must return them"
        );
    }

    #[test]
    fn reports_the_first_hit_as_location() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "**/*.rs" })).unwrap();
        let location = out.location.expect("glob must report where to jump");
        assert!(location.path.extension().is_some_and(|e| e == "rs"));
    }

    #[test]
    fn no_match_says_so_without_failing() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "**/*.zig" })).unwrap();
        assert!(out.joined_text().starts_with("No files matching"));
        assert!(out.location.is_none());
    }

    #[test]
    fn invalid_pattern_is_an_error_naming_the_pattern() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let err = run(&env, json!({ "pattern": "[" })).unwrap_err();
        assert!(err.to_string().contains('['), "got: {err}");
    }

    #[test]
    fn search_root_can_be_narrowed() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "*.rs", "path": "src" })).unwrap();
        assert!(out.joined_text().contains("main.rs"));
    }

    #[test]
    fn a_listing_of_long_paths_stays_inside_the_byte_budget() {
        // The count ceiling let a real run return 2000 paths that came to
        // 220KB, because paths in a deep tree are long. Reproduced small: a
        // deep directory and names near the filesystem's limit.
        let dir = tempfile::tempdir().unwrap();
        let deep = dir
            .path()
            .join("a".repeat(200))
            .join("b".repeat(200))
            .join("c".repeat(200));
        std::fs::create_dir_all(&deep).unwrap();
        for i in 0..120 {
            std::fs::write(deep.join(format!("{}{i}.rs", "n".repeat(200))), "x").unwrap();
        }

        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "**/*.rs" })).unwrap();
        let text = out.joined_text();

        assert!(
            text.len() <= crate::truncate::DEFAULT_MAX_BYTES + 300,
            "listing must respect the byte ceiling, got {} bytes",
            text.len()
        );
        assert!(
            text.contains("[showing "),
            "the model has to be told the list is partial, got tail: {}",
            &text[text.len().saturating_sub(200)..]
        );
    }

    #[test]
    fn a_walk_that_would_never_end_stops_and_says_so() {
        // What `**/*` against a home directory does: one real run made 3.4
        // million stat calls over about three minutes before returning.
        let dir = tempfile::tempdir().unwrap();
        for i in 0..40 {
            std::fs::write(dir.path().join(format!("f{i}.rs")), "x").unwrap();
        }
        let env = LocalEnv::new(dir.path());
        let cancel = CancelToken::new();
        let ctx = ToolContext::new(&env, &cancel);

        let out = GlobTool::with_scan_limit(10)
            .execute(json!({ "pattern": "**/*.rs" }), &ctx, &mut |_| {})
            .unwrap();
        let text = out.joined_text();

        assert!(
            text.contains("scan stopped after 10 matches"),
            "a partial answer must say it is partial, got: {text}"
        );
        assert!(
            text.contains("Narrow the pattern"),
            "and must say what to do about it, got: {text}"
        );
        assert_eq!(
            text.lines().filter(|l| l.ends_with(".rs")).count(),
            10,
            "only the matches actually looked at may be reported"
        );
    }

    #[test]
    fn a_complete_walk_never_claims_it_stopped() {
        let dir = fixture();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "pattern": "**/*.rs" })).unwrap();
        assert!(!out.joined_text().contains("scan stopped"));
    }

    #[test]
    fn the_shipped_scan_limit_is_large_enough_for_a_real_repository() {
        // Guards the knob itself: a limit small enough to cut short an ordinary
        // project would make every answer partial and every notice noise.
        const { assert!(MAX_SCAN >= 20_000) };
    }
}
