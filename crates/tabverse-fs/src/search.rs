use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;

use crate::{canonical_dir, expand_path, Exclusions, IgnoreStack, WalkRules};

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    pub include_hidden: bool,
    pub include: Option<String>,
    /// Files whose relative path matches this glob are skipped entirely —
    /// by search AND by replace, because both enumerate through
    /// `files_under`.
    pub exclude: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// Relative to the searched root, which is what a result list shows.
    pub rel: String,
    pub path: String,
    /// 1-based, so it can be handed straight to "open at line".
    pub line: u32,
    pub col: u32,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResult {
    pub hits: Vec<Hit>,
    pub files_matched: usize,
    pub files_scanned: usize,
    /// The cap was reached and results are missing. Never silent.
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files_changed: usize,
    pub replacements: usize,
    pub failed: Vec<ReplaceFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFailure {
    pub rel: String,
    pub error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreviewLine {
    /// 1-based.
    pub line: u32,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreviewSite {
    /// 1-based.
    pub line: u32,
    /// 1-based start of the matched span.
    pub col: u32,
    /// Length of what is being replaced, in chars.
    pub before_len: u32,
    /// Length of the replacement, in chars (it is the same string
    /// everywhere; the length is what a diff view wants).
    pub after_len: u32,
    /// The hit line, one before, one after — the three that identify the
    /// place. First or last lines of a file simply have fewer neighbors.
    pub context: Vec<ReplacePreviewLine>,
}

/// One file of the preview: where it is, what it holds now, and every
/// place a replacement would land.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreviewFile {
    pub rel: String,
    pub path: String,
    /// mtime in whole seconds at preview time; the execution rechecks it,
    /// because between "show me" and "do it" is exactly where someone
    /// else's edit slips in.
    pub modified: Option<u64>,
    /// The whole current text — the diff's original side. Shipping it
    /// costs one copy of a file that is already capped at 8 MB and was
    /// read to build the preview anyway; shipping it once beats the panel
    /// re-deriving an "after" through a second, drifting implementation.
    pub before: String,
    pub sites: Vec<ReplacePreviewSite>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub files: Vec<ReplacePreviewFile>,
    pub replacements: usize,
    pub files_matched: usize,
}

/// An mtime stamp the preview took, for the execution to recheck.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceStamp {
    /// Absolute, as the preview reported it — unambiguous across roots.
    pub path: String,
    pub modified: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipSite {
    pub rel: String,
    pub line: u32,
    pub col: u32,
}

/// What the execution step was told by the preview step: the stamps to
/// recheck, and the sites to leave alone.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePlan {
    pub stamps: Option<Vec<ReplaceStamp>>,
    pub skip: Option<Vec<SkipSite>>,
}

/// Longest line this will hold in memory per file, and the largest file it
/// will read at all. Both are about a text editor's idea of a text file: a
/// 40 MB minified bundle is not something a person searches through.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// A compiled needle. Built once per search rather than per line.
enum Needle {
    Plain { query: String, options: GrepOptions },
    Pattern(regex::Regex),
}

impl Needle {
    fn build(query: &str, o: &GrepOptions) -> Result<Self> {
        if o.regex {
            let pattern = if o.whole_word {
                format!(r"\b(?:{query})\b")
            } else {
                query.to_string()
            };
            let re = regex::RegexBuilder::new(&pattern)
                .case_insensitive(!o.case_sensitive)
                .build()?;
            return Ok(Needle::Pattern(re));
        }
        Ok(Needle::Plain {
            query: if o.case_sensitive {
                query.to_string()
            } else {
                query.to_lowercase()
            },
            options: o.clone(),
        })
    }

    /// Byte offsets of every match in one line.
    fn find_all(&self, line: &str) -> Vec<(usize, usize)> {
        match self {
            Needle::Pattern(re) => re.find_iter(line).map(|m| (m.start(), m.end())).collect(),
            Needle::Plain { query, options } => {
                if query.is_empty() {
                    return Vec::new();
                }
                let hay = if options.case_sensitive {
                    line.to_string()
                } else {
                    line.to_lowercase()
                };
                let mut out = Vec::new();
                let mut from = 0usize;
                while let Some(at) = hay[from..].find(query.as_str()) {
                    let start = from + at;
                    let end = start + query.len();
                    if !options.whole_word || is_whole_word(&hay, start, end) {
                        out.push((start, end));
                    }
                    // Always move on, so an empty or overlapping match
                    // cannot spin here forever.
                    from = end.max(start + 1);
                    if from >= hay.len() {
                        break;
                    }
                }
                out
            }
        }
    }
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_whole_word(hay: &str, start: usize, end: usize) -> bool {
    let bytes = hay.as_bytes();
    let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
    let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
    before_ok && after_ok
}

/// Does this look like something a person would read?
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

pub(crate) struct PathFilter {
    include: Option<globset::GlobMatcher>,
    exclude: Option<globset::GlobMatcher>,
}

impl PathFilter {
    fn from_options(o: &GrepOptions) -> Result<Self> {
        let compile = |raw: &Option<String>, what: &str| -> Result<Option<globset::GlobMatcher>> {
            match raw {
                None => Ok(None),
                Some(p) if p.trim().is_empty() => Ok(None),
                Some(p) => Ok(Some(
                    globset::GlobBuilder::new(p)
                        // A single star stops at the path separator, so
                        // `*.rs` means "top level only" and `**/*.rs` is
                        // the way to say "anywhere" — the distinction the
                        // panel's ghost completion (`*.rs` → `**/*.rs`)
                        // exists to teach. globset's default lets `*`
                        // cross separators, which would make the two
                        // patterns synonyms and the completion pointless.
                        .literal_separator(true)
                        .build()
                        .map_err(|e| anyhow::anyhow!("invalid {what} glob {p:?}: {e}"))?
                        .compile_matcher(),
                )),
            }
        };
        Ok(PathFilter {
            include: compile(&o.include, "include")?,
            exclude: compile(&o.exclude, "exclude")?,
        })
    }

    fn admits(&self, rel: &Path) -> bool {
        // Include narrows first, exclude then removes from whatever is left.
        self.include.as_ref().is_none_or(|m| m.is_match(rel))
            && self.exclude.as_ref().is_none_or(|m| !m.is_match(rel))
    }
}

fn files_under(
    root: &Path,
    include_hidden: bool,
    filter: &PathFilter,
    excl: &Exclusions,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let root_ignores = IgnoreStack::at_root(root);
    let mut stack = vec![(root.to_path_buf(), root_ignores)];
    while let Some((dir, ignores)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for dent in rd.flatten() {
            let name = dent.file_name().to_string_lossy().to_string();
            let path = dent.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            let hidden = name.starts_with('.');
            if meta.is_dir() {
                if !excl.dir_admitted(&name) {
                    continue;
                }
                if excl.respect_gitignore && ignores.ignored(&path, true) {
                    continue;
                }
                if hidden && !include_hidden {
                    continue;
                }
                let child_ignores = ignores.descending(&path);
                stack.push((path, child_ignores));
            } else if !hidden || include_hidden {
                if excl.respect_gitignore && ignores.ignored(&path, false) {
                    continue;
                }
                if meta.len() > MAX_FILE_BYTES {
                    continue;
                }
                let rel = path.strip_prefix(root).unwrap_or(&path);
                if !filter.admits(rel) {
                    continue;
                }
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

pub fn grep(
    root: &str,
    query: &str,
    options: GrepOptions,
    max_hits: usize,
    rules: &WalkRules,
) -> Result<GrepResult> {
    let root_path = canonical_dir(&expand_path(root));
    let filter = PathFilter::from_options(&options)?;
    let excl = Exclusions::compile(rules)?;
    let needle = Needle::build(query, &options)?;
    let mut result = GrepResult {
        hits: Vec::new(),
        files_matched: 0,
        files_scanned: 0,
        truncated: false,
    };
    if query.is_empty() {
        return Ok(result);
    }
    for path in files_under(&root_path, options.include_hidden, &filter, &excl) {
        if result.hits.len() >= max_hits {
            result.truncated = true;
            break;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if looks_binary(&bytes) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        result.files_scanned += 1;
        let rel = path
            .strip_prefix(&root_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        let mut matched_here = false;
        for (i, line) in text.lines().enumerate() {
            for (start, _) in needle.find_all(line) {
                if result.hits.len() >= max_hits {
                    result.truncated = true;
                    break;
                }
                matched_here = true;
                result.hits.push(Hit {
                    rel: rel.clone(),
                    path: path.to_string_lossy().to_string(),
                    line: (i + 1) as u32,
                    col: (start + 1) as u32,
                    // Long lines are cut for display; the file is untouched.
                    text: line.chars().take(400).collect(),
                });
            }
            if result.truncated {
                break;
            }
        }
        if matched_here {
            result.files_matched += 1;
        }
    }
    Ok(result)
}

pub fn replace_all(
    root: &str,
    query: &str,
    replacement: &str,
    options: GrepOptions,
    only: Option<Vec<String>>,
    plan: Option<ReplacePlan>,
    rules: &WalkRules,
) -> Result<ReplaceResult> {
    let root_path = canonical_dir(&expand_path(root));
    let filter = PathFilter::from_options(&options)?;
    let excl = Exclusions::compile(rules)?;
    let needle = Needle::build(query, &options)?;
    let mut out = ReplaceResult {
        files_changed: 0,
        replacements: 0,
        failed: Vec::new(),
    };
    if query.is_empty() {
        return Ok(out);
    }
    let wanted: Option<std::collections::HashSet<String>> = only.map(|v| v.into_iter().collect());
    // (rel → the char columns on that line to leave alone). Skip keys are
    // the preview's own coordinates; they stay meaningful only because the
    // stamp check below refuses a file that moved since the preview took
    // them.
    let mut skip: std::collections::HashMap<String, std::collections::HashSet<(u32, u32)>> =
        Default::default();
    for s in plan.as_ref().and_then(|p| p.skip.as_deref()).unwrap_or(&[]) {
        skip.entry(s.rel.clone())
            .or_default()
            .insert((s.line, s.col));
    }
    // The stamp check runs BEFORE any write: a refusal that lands after
    // half the files changed would be a worse answer than either finishing
    // or not starting. Same granularity as the draft channel's
    // mtimeUnchanged (whole seconds), and for the same reason.
    if let Some(stamps) = plan.as_ref().and_then(|p| p.stamps.as_deref()) {
        for st in stamps {
            let Ok(meta) = std::fs::metadata(&st.path) else {
                anyhow::bail!("changed since the preview (gone now): {}", st.path);
            };
            let now = epoch_secs(&meta);
            if st.modified != now {
                anyhow::bail!("changed since the preview: {}", st.path);
            }
        }
    }
    for path in files_under(&root_path, options.include_hidden, &filter, &excl) {
        let rel = path
            .strip_prefix(&root_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        if let Some(set) = &wanted {
            if !set.contains(&rel) {
                continue;
            }
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if looks_binary(&bytes) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let skipped_here = skip.get(&rel);
        let mut changed = 0usize;
        let mut rebuilt = String::with_capacity(text.len());
        for (i, line) in text.lines().enumerate() {
            if i > 0 {
                rebuilt.push('\n');
            }
            let spans = needle.find_all(line);
            if spans.is_empty() {
                rebuilt.push_str(line);
                continue;
            }
            let mut at = 0usize;
            for (start, end) in spans {
                let col = (start + 1) as u32;
                let site = ((i + 1) as u32, col);
                if skipped_here.is_some_and(|s| s.contains(&site)) {
                    // An unchecked place keeps its original text.
                    rebuilt.push_str(&line[at..end]);
                    at = end;
                    continue;
                }
                rebuilt.push_str(&line[at..start]);
                rebuilt.push_str(replacement);
                at = end;
                changed += 1;
            }
            rebuilt.push_str(&line[at..]);
        }
        // `lines()` drops a trailing newline; put it back rather than
        // quietly reformatting every file that has one.
        if text.ends_with('\n') {
            rebuilt.push('\n');
        }
        if changed > 0 && rebuilt != text {
            if let Err(e) = std::fs::write(&path, rebuilt) {
                // Report, do not stop: the files after this one are not
                // guilty of this one's failure, and the files before it
                // are already written.
                out.failed.push(ReplaceFailure {
                    rel,
                    error: format!("{e:#}"),
                });
                continue;
            }
            out.files_changed += 1;
            out.replacements += changed;
        }
    }
    Ok(out)
}

/// mtime in whole seconds — the unit FileMeta and the draft channel use.
fn epoch_secs(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

pub fn replace_preview(
    root: &str,
    query: &str,
    replacement: &str,
    options: GrepOptions,
    only: Option<Vec<String>>,
    rules: &WalkRules,
) -> Result<ReplacePreview> {
    let root_path = canonical_dir(&expand_path(root));
    let filter = PathFilter::from_options(&options)?;
    let excl = Exclusions::compile(rules)?;
    let needle = Needle::build(query, &options)?;
    let mut preview = ReplacePreview {
        files: Vec::new(),
        replacements: 0,
        files_matched: 0,
    };
    if query.is_empty() {
        return Ok(preview);
    }
    let wanted: Option<std::collections::HashSet<String>> = only.map(|v| v.into_iter().collect());
    for path in files_under(&root_path, options.include_hidden, &filter, &excl) {
        let rel = path
            .strip_prefix(&root_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        if let Some(set) = &wanted {
            if !set.contains(&rel) {
                continue;
            }
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if looks_binary(&bytes) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let lines: Vec<&str> = text.lines().collect();
        let mut sites = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            for (start, end) in needle.find_all(line) {
                // Chars, not bytes: the preview is read by people and
                // keyed by the panel.
                let col = line.chars().take(start).count() as u32 + 1;
                let before_len = line.chars().take(end).count() as u32 - (col - 1);
                let mut context = Vec::with_capacity(3);
                // One line before, the hit line, one line after — the
                // three that identify the place.
                if i > 0 {
                    context.push(ReplacePreviewLine {
                        line: i as u32,
                        text: chars_taken(lines[i - 1]),
                    });
                }
                context.push(ReplacePreviewLine {
                    line: (i + 1) as u32,
                    text: chars_taken(line),
                });
                if i + 1 < lines.len() {
                    context.push(ReplacePreviewLine {
                        line: (i + 2) as u32,
                        text: chars_taken(lines[i + 1]),
                    });
                }
                sites.push(ReplacePreviewSite {
                    line: (i + 1) as u32,
                    col,
                    before_len,
                    after_len: replacement.chars().count() as u32,
                    context,
                });
            }
        }
        if sites.is_empty() {
            continue;
        }
        preview.replacements += sites.len();
        preview.files_matched += 1;
        let modified = std::fs::metadata(&path).ok().as_ref().and_then(epoch_secs);
        preview.files.push(ReplacePreviewFile {
            rel,
            path: path.to_string_lossy().to_string(),
            modified,
            before: text,
            sites,
        });
    }
    Ok(preview)
}

/// A context line, cut to the same 400-char display budget a hit's text
/// gets — context is for recognizing a place, not for reading the file.
fn chars_taken(line: &str) -> String {
    line.chars().take(400).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(case_sensitive: bool, whole_word: bool, regex: bool) -> GrepOptions {
        GrepOptions {
            case_sensitive,
            whole_word,
            regex,
            include_hidden: false,
            include: None,
            exclude: None,
        }
    }

    #[test]
    fn whole_word_does_not_match_inside_a_longer_word() {
        let n = Needle::build("cat", &opts(true, true, false)).unwrap();
        assert!(n.find_all("a cat sat").len() == 1);
        assert!(n.find_all("concatenate").is_empty());
    }

    #[test]
    fn case_insensitive_finds_either_spelling_and_reports_the_real_column() {
        let n = Needle::build("Cat", &opts(false, false, false)).unwrap();
        let hits = n.find_all("the CAT and the cat");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].0, 4);
    }

    #[test]
    fn a_repeated_needle_terminates_rather_than_spinning() {
        let n = Needle::build("aa", &opts(true, false, false)).unwrap();
        assert_eq!(n.find_all("aaaa").len(), 2);
    }

    #[test]
    fn binary_is_recognised_by_a_nul_byte_not_by_its_name() {
        assert!(looks_binary(b"PNG\0\r\n"));
        assert!(!looks_binary(b"plain text, .bin or not"));
    }

    #[test]
    fn replacing_keeps_a_trailing_newline() {
        let dir = std::env::temp_dir().join(format!("cal-search-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.txt");
        std::fs::write(&f, "one two\nthree two\n").unwrap();
        let r = replace_all(
            dir.to_str().unwrap(),
            "two",
            "2",
            opts(true, false, false),
            None,
            None,
            &WalkRules::default(),
        )
        .unwrap();
        assert_eq!(r.replacements, 2);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "one 2\nthree 2\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A fresh tree with a couple of files to filter, one nested a level
    /// down so the `**/*.rs` question (cross-directory matching) has a
    /// case to answer.
    fn glob_tree() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("cal-glob-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("top.rs"), "needle here\n").unwrap();
        std::fs::write(dir.join("src/nested.rs"), "needle here\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "needle here\n").unwrap();
        std::fs::write(dir.join("debug.log"), "needle here\n").unwrap();
        dir
    }

    fn opts_with(include: Option<&str>, exclude: Option<&str>) -> GrepOptions {
        GrepOptions {
            include: include.map(str::to_string),
            exclude: exclude.map(str::to_string),
            ..opts(false, false, false)
        }
    }

    fn hit_rels(dir: &Path, o: GrepOptions) -> Vec<String> {
        grep(
            dir.to_str().unwrap(),
            "needle",
            o,
            100,
            &WalkRules::default(),
        )
        .unwrap()
        .hits
        .into_iter()
        .map(|h| h.rel)
        .collect()
    }

    #[test]
    fn a_bare_glob_stays_at_the_top_level_and_the_double_star_crosses_dirs() {
        let dir = glob_tree();
        // `*.rs` matches "top.rs" but not "src/nested.rs": a single star
        // stops at the separator, which is exactly the gap the panel's
        // `**/` ghost completion exists to close.
        assert_eq!(
            hit_rels(&dir, opts_with(Some("*.rs"), None)),
            vec!["top.rs"]
        );
        assert_eq!(
            hit_rels(&dir, opts_with(Some("**/*.rs"), None)),
            vec!["src/nested.rs", "top.rs"]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_exclude_glob_removes_only_what_it_names() {
        let dir = glob_tree();
        assert_eq!(
            hit_rels(&dir, opts_with(None, Some("**/*.log"))),
            vec!["notes.txt", "src/nested.rs", "top.rs"]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn globs_match_the_relative_path_not_the_absolute_one() {
        let dir = glob_tree();
        // An absolute-looking pattern matches nothing: candidates are
        // relative to the root, the same thing `only` names.
        let abs = format!("{}/**/*.rs", dir.to_str().unwrap());
        assert!(hit_rels(&dir, opts_with(Some(&abs), None)).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bad_glob_is_an_error_not_a_silent_empty_search() {
        let dir = glob_tree();
        // `[` never closes: globset refuses it, and the caller shows the
        // message instead of a result list that looks like "no matches".
        assert!(grep(
            dir.to_str().unwrap(),
            "needle",
            opts_with(Some("[.rs"), None),
            100,
            &WalkRules::default(),
        )
        .is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn search_and_replace_share_one_scope() {
        let dir = glob_tree();
        let o = opts_with(Some("**/*.rs"), Some("**/nested.rs"));
        let shown = hit_rels(&dir, o.clone());
        assert_eq!(shown, vec!["top.rs"]);
        replace_all(
            dir.to_str().unwrap(),
            "needle",
            "NEEDLE",
            o,
            None,
            None,
            &WalkRules::default(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("top.rs")).unwrap(),
            "NEEDLE here\n"
        );
        // Every file the search did NOT show is untouched.
        assert_eq!(
            std::fs::read_to_string(dir.join("notes.txt")).unwrap(),
            "needle here\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("src/nested.rs")).unwrap(),
            "needle here\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("debug.log")).unwrap(),
            "needle here\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    fn stamp_dir(tag: &str) -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("cal-prev-{tag}-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn stamps_for(preview: &ReplacePreview) -> Vec<ReplaceStamp> {
        preview
            .files
            .iter()
            .map(|f| ReplaceStamp {
                path: f.path.clone(),
                modified: f.modified,
            })
            .collect()
    }

    #[test]
    fn a_dry_run_reports_every_site_with_context_and_char_spans() {
        let dir = stamp_dir("sites");
        std::fs::write(dir.join("a.txt"), "one two\nthree two\n").unwrap();
        let preview = replace_preview(
            dir.to_str().unwrap(),
            "two",
            "2",
            opts(true, false, false),
            None,
            &WalkRules::default(),
        )
        .unwrap();
        assert_eq!(preview.files.len(), 1);
        assert_eq!(preview.replacements, 2);
        let f = &preview.files[0];
        assert_eq!(f.rel, "a.txt");
        assert_eq!(f.before, "one two\nthree two\n");
        assert!(f.modified.is_some(), "the preview stamps the mtime");
        // Site 1: line 1, "two" starts at char 5, three chars long.
        assert_eq!(f.sites[0].line, 1);
        assert_eq!(f.sites[0].col, 5);
        assert_eq!(f.sites[0].before_len, 3);
        assert_eq!(f.sites[0].after_len, 1);
        // Context: the hit line plus its neighbors — line 1 has no
        // before, so two entries; line 2 has both neighbors, so three.
        assert_eq!(f.sites[0].context.len(), 2);
        assert_eq!(f.sites[0].context[0].line, 1);
        assert_eq!(f.sites[1].line, 2);
        assert_eq!(f.sites[1].col, 7);
        // Line 2 is the last (lines() drops the trailing newline), so it
        // has a before-neighbor but no after-neighbor.
        assert_eq!(f.sites[1].context.len(), 2);
        assert_eq!(f.sites[1].context[0].line, 1);
        assert_eq!(f.sites[1].context[1].line, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unchecked_site_keeps_its_text() {
        let dir = stamp_dir("skip");
        std::fs::write(dir.join("a.txt"), "one two\nthree two\n").unwrap();
        let o = opts(true, false, false);
        let preview = replace_preview(
            dir.to_str().unwrap(),
            "two",
            "2",
            o.clone(),
            None,
            &WalkRules::default(),
        )
        .unwrap();
        // The user unchecked the SECOND place (line 2, col 6).
        let plan = ReplacePlan {
            stamps: Some(stamps_for(&preview)),
            skip: Some(vec![SkipSite {
                rel: "a.txt".into(),
                line: 2,
                col: 7,
            }]),
        };
        replace_all(
            dir.to_str().unwrap(),
            "two",
            "2",
            o,
            None,
            Some(plan),
            &WalkRules::default(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "one 2\nthree two\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_that_moved_since_the_preview_refuses_the_whole_run() {
        let dir = stamp_dir("mtime");
        std::fs::write(dir.join("a.txt"), "one two\n").unwrap();
        std::fs::write(dir.join("b.txt"), "two again\n").unwrap();
        let o = opts(true, false, false);
        let preview = replace_preview(
            dir.to_str().unwrap(),
            "two",
            "2",
            o.clone(),
            None,
            &WalkRules::default(),
        )
        .unwrap();
        // The file changes after the preview was taken.
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        filetime::set_file_mtime(
            dir.join("a.txt"),
            filetime::FileTime::from_system_time(later),
        )
        .unwrap();
        let plan = ReplacePlan {
            stamps: Some(stamps_for(&preview)),
            skip: None,
        };
        let refused = replace_all(
            dir.to_str().unwrap(),
            "two",
            "2",
            o.clone(),
            None,
            Some(plan),
            &WalkRules::default(),
        );
        assert!(refused.is_err(), "a moved file must refuse, not replace");
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "one two\n"
        );
        // Not a file was touched — b.txt too, though only a.txt moved.
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "two again\n"
        );
        // And the run that follows an UNMOVED window executes normally.
        let ok = replace_all(
            dir.to_str().unwrap(),
            "two",
            "2",
            o,
            None,
            Some(ReplacePlan {
                // Fresh stamps: the refused run never wrote, so a new
                // preview of the same tree is identical — but re-preview
                // anyway, the way the panel does.
                stamps: Some(stamps_for(
                    &replace_preview(
                        dir.to_str().unwrap(),
                        "two",
                        "2",
                        opts(true, false, false),
                        None,
                        &WalkRules::default(),
                    )
                    .unwrap(),
                )),
                skip: None,
            }),
            &WalkRules::default(),
        )
        .unwrap();
        assert_eq!(ok.replacements, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_write_failure_is_reported_per_file_and_the_rest_still_land() {
        let dir = stamp_dir("failed");
        std::fs::write(dir.join("a.txt"), "one two\n").unwrap();
        std::fs::write(dir.join("b.txt"), "two again\n").unwrap();
        let o = opts(true, false, false);
        let preview = replace_preview(
            dir.to_str().unwrap(),
            "two",
            "2",
            o.clone(),
            None,
            &WalkRules::default(),
        )
        .unwrap();
        // a.txt is made unwritable; the enumeration order is alphabetical,
        // so a.txt is attempted first — the failure must not stop b.txt.
        let ro = dir.join("a.txt");
        let original_perms = std::fs::metadata(&ro).unwrap().permissions();
        std::fs::set_permissions(&ro, std::os::unix::fs::PermissionsExt::from_mode(0o444)).ok();
        let plan = ReplacePlan {
            stamps: Some(stamps_for(&preview)),
            skip: None,
        };
        let r = replace_all(
            dir.to_str().unwrap(),
            "two",
            "2",
            o,
            None,
            Some(plan),
            &WalkRules::default(),
        )
        .unwrap();
        std::fs::set_permissions(&ro, original_perms).ok();
        assert_eq!(r.failed.len(), 1, "the failure is reported, not swallowed");
        assert_eq!(r.failed[0].rel, "a.txt");
        assert_eq!(r.files_changed, 1);
        assert_eq!(r.replacements, 1);
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "2 again\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_users_noise_list_and_gitignore_shape_the_search() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("cal-search-rules-{stamp}"));
        std::fs::create_dir_all(dir.join("vendor/lib")).unwrap();
        std::fs::create_dir_all(dir.join("pkgbuild-out")).unwrap();
        std::fs::write(dir.join("vendor/lib/a.c"), "needle\n").unwrap();
        std::fs::write(dir.join("pkgbuild-out/artifact.txt"), "needle\n").unwrap();
        std::fs::write(dir.join("readme.md"), "needle\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "pkgbuild-out/\n").unwrap();
        let plain = opts(false, false, false);
        let rels = |rules: &WalkRules| {
            grep(dir.to_str().unwrap(), "needle", plain.clone(), 100, rules)
                .unwrap()
                .hits
                .into_iter()
                .map(|h| h.rel)
                .collect::<Vec<_>>()
        };

        // The user's list removes vendor — the literal — while the
        // pkgbuild family stays until the switch or a glob takes it.
        let rules = WalkRules {
            exclude: vec!["vendor".into()],
            respect_gitignore: false,
        };
        assert!(!rels(&rules).iter().any(|r| r.contains("vendor")));
        assert!(rels(&rules).iter().any(|r| r.contains("pkgbuild-out")));

        // The glob form removes the family, the same entry shape the walk
        // tests use: one list, one semantics.
        let rules = WalkRules {
            exclude: vec!["pkgbuild-*".into()],
            respect_gitignore: false,
        };
        assert!(!rels(&rules).iter().any(|r| r.contains("pkgbuild")));

        // The gitignore switch alone: on removes the ignored output, off
        // (the default, first assertion above) keeps it.
        let on = WalkRules {
            exclude: vec![],
            respect_gitignore: true,
        };
        assert!(!rels(&on).iter().any(|r| r.contains("pkgbuild-out")));
        assert!(rels(&on).iter().any(|r| r == "readme.md"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Replace rides the same enumeration, so the same configuration rules
    /// what a replacement may touch — a directory the search was told to
    /// skip is not silently repaired by "replace everything".
    #[test]
    fn replace_cannot_reach_what_the_search_was_told_to_skip() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("cal-repl-rules-{stamp}"));
        std::fs::create_dir_all(dir.join("vendor")).unwrap();
        std::fs::write(dir.join("vendor/a.txt"), "needle\n").unwrap();
        std::fs::write(dir.join("top.txt"), "needle\n").unwrap();
        let rules = WalkRules {
            exclude: vec!["vendor".into()],
            respect_gitignore: false,
        };
        replace_all(
            dir.to_str().unwrap(),
            "needle",
            "NEEDLE",
            opts(true, false, false),
            None,
            None,
            &rules,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("top.txt")).unwrap(),
            "NEEDLE\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("vendor/a.txt")).unwrap(),
            "needle\n",
            "the excluded directory is outside the replace scope too"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
