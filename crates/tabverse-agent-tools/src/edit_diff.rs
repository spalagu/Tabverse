//! Locating the text an edit means to replace.
//!
//! The naive version of this is `content.replace(old, new)` and it fails in
//! three ways that all show up within a day of real use: the model's `oldText`
//! came through a renderer and now carries smart quotes or an en-dash where the
//! file has plain ASCII; the same snippet occurs twice and a blind replace hits
//! the wrong one; or two edits in one call overlap and the second corrupts the
//! first. Each of those is an explicit outcome here rather than a silent wrong
//! answer.
//!
//! Adapted from Pi's `packages/agent/src/harness/tools/edit-diff.ts`; see the
//! repository's `NOTICE` file for attribution and license terms.

use anyhow::{bail, Result};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Edit {
    pub old_text: String,
    pub new_text: String,
}

/// Whichever ending the file already uses, so an edit does not silently rewrite
/// every line of a CRLF file.
pub fn detect_line_ending(content: &str) -> LineEnding {
    if content.contains("\r\n") {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

pub fn normalize_to_lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

pub fn restore_line_endings(text: &str, ending: LineEnding) -> String {
    match ending {
        LineEnding::Lf => text.to_string(),
        LineEnding::Crlf => text.replace('\n', "\r\n"),
    }
}

/// Split off a UTF-8 BOM so it survives the round trip rather than being
/// dropped into the middle of a rewritten file.
pub fn strip_bom(content: &str) -> (&str, &str) {
    match content.strip_prefix('\u{FEFF}') {
        Some(rest) => ("\u{FEFF}", rest),
        None => ("", content),
    }
}

/// The equivalence used when an exact match fails: differences that a human
/// would call "the same text" but bytes disagree about.
pub fn normalize_for_fuzzy_match(text: &str) -> String {
    let composed: String = text.nfkc().collect();
    let trimmed = composed
        .split('\n')
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    trimmed
        .chars()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct Match {
    /// Byte offset into whichever content was searched.
    pub index: usize,
    pub length: usize,
    pub used_fuzzy: bool,
}

/// Exact first, then the normalized equivalence. Offsets refer to the exact
/// content when `used_fuzzy` is false and to the normalized content when true —
/// the caller has to apply replacements in the same space it searched.
pub fn fuzzy_find(content: &str, old_text: &str) -> Option<Match> {
    if let Some(index) = content.find(old_text) {
        return Some(Match {
            index,
            length: old_text.len(),
            used_fuzzy: false,
        });
    }
    let fuzzy_content = normalize_for_fuzzy_match(content);
    let fuzzy_old = normalize_for_fuzzy_match(old_text);
    fuzzy_content.find(&fuzzy_old).map(|index| Match {
        index,
        length: fuzzy_old.len(),
        used_fuzzy: true,
    })
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.matches(needle).count()
}

struct Matched {
    edit_index: usize,
    index: usize,
    length: usize,
    new_text: String,
}

/// Apply every edit against the *original* content — not against the result of
/// the previous edit. That is what lets a model send several replacements in one
/// call without having to predict how earlier ones shift later offsets.
pub fn apply_edits(content: &str, edits: &[Edit], path: &str) -> Result<String> {
    if edits.is_empty() {
        bail!("no edits supplied for {path}: edits must contain at least one replacement");
    }

    let normalized: Vec<Edit> = edits
        .iter()
        .map(|e| Edit {
            old_text: normalize_to_lf(&e.old_text),
            new_text: normalize_to_lf(&e.new_text),
        })
        .collect();

    for (i, edit) in normalized.iter().enumerate() {
        if edit.old_text.is_empty() {
            bail!("edits[{i}] for {path} has an empty oldText; it must name the text to replace");
        }
    }

    // If any edit needs the relaxed equivalence, every edit is resolved in that
    // same space — offsets from two different spaces cannot be compared.
    let any_fuzzy = normalized
        .iter()
        .any(|e| fuzzy_find(content, &e.old_text).is_some_and(|m| m.used_fuzzy));
    let search_base = if any_fuzzy {
        normalize_for_fuzzy_match(content)
    } else {
        content.to_string()
    };

    let mut matched = Vec::with_capacity(normalized.len());
    for (i, edit) in normalized.iter().enumerate() {
        let needle = if any_fuzzy {
            normalize_for_fuzzy_match(&edit.old_text)
        } else {
            edit.old_text.clone()
        };
        let Some(m) = search_base.find(&needle).map(|index| Match {
            index,
            length: needle.len(),
            used_fuzzy: any_fuzzy,
        }) else {
            bail!(
                "edits[{i}] of {} for {path}: oldText was not found in the file. \
                 Read the file again and quote the current text exactly.",
                normalized.len()
            );
        };

        let occurrences = count_occurrences(&search_base, &needle);
        if occurrences > 1 {
            bail!(
                "edits[{i}] of {} for {path}: oldText appears {occurrences} times. \
                 Include enough surrounding context to make it unique.",
                normalized.len()
            );
        }

        matched.push(Matched {
            edit_index: i,
            index: m.index,
            length: m.length,
            new_text: edit.new_text.clone(),
        });
    }

    matched.sort_by_key(|m| m.index);
    for pair in matched.windows(2) {
        let (previous, current) = (&pair[0], &pair[1]);
        if previous.index + previous.length > current.index {
            bail!(
                "edits[{}] and edits[{}] overlap in {path}. \
                 Merge them into one edit or target disjoint regions.",
                previous.edit_index,
                current.edit_index
            );
        }
    }

    // Right to left, so earlier offsets stay valid as we splice.
    let mut out = search_base.clone();
    for m in matched.iter().rev() {
        out.replace_range(m.index..m.index + m.length, &m.new_text);
    }

    if out == content {
        bail!("applying the edits to {path} produced no change; oldText and newText are identical");
    }

    Ok(if any_fuzzy {
        preserve_unchanged_lines(content, &search_base, &out)
    } else {
        out
    })
}

/// A fuzzy match forces the whole file through normalization, which would
/// otherwise rewrite every smart quote in it as a side effect of one edit.
/// Lines that the edit did not change are restored to their original bytes.
fn preserve_unchanged_lines(original: &str, normalized_base: &str, edited: &str) -> String {
    let original_lines: Vec<&str> = original.split('\n').collect();
    let base_lines: Vec<&str> = normalized_base.split('\n').collect();
    let edited_lines: Vec<&str> = edited.split('\n').collect();

    // Line counts only line up where the edit did not add or remove lines; when
    // they differ, the edited text is the honest answer.
    if base_lines.len() != original_lines.len() {
        return edited.to_string();
    }

    let mut out: Vec<String> = Vec::with_capacity(edited_lines.len());
    for (i, line) in edited_lines.iter().enumerate() {
        match (base_lines.get(i), original_lines.get(i)) {
            (Some(base), Some(original_line)) if base == line => {
                out.push((*original_line).to_string())
            }
            _ => out.push((*line).to_string()),
        }
    }
    out.join("\n")
}

/// 1-indexed line of the first difference, for jumping the editor there.
pub fn first_changed_line(before: &str, after: &str) -> Option<u32> {
    let before_lines: Vec<&str> = before.split('\n').collect();
    let after_lines: Vec<&str> = after.split('\n').collect();
    for (i, (b, a)) in before_lines.iter().zip(after_lines.iter()).enumerate() {
        if b != a {
            return Some(i as u32 + 1);
        }
    }
    if before_lines.len() != after_lines.len() {
        return Some(before_lines.len().min(after_lines.len()) as u32 + 1);
    }
    None
}

/// A compact summary of what changed, for the tool result the model reads back.
pub fn summarize_change(before: &str, after: &str) -> String {
    let before_lines = before.split('\n').count();
    let after_lines = after.split('\n').count();
    match after_lines.cmp(&before_lines) {
        std::cmp::Ordering::Equal => format!("{before_lines} lines, content changed in place"),
        std::cmp::Ordering::Greater => {
            format!(
                "{before_lines} -> {after_lines} lines (+{})",
                after_lines - before_lines
            )
        }
        std::cmp::Ordering::Less => {
            format!(
                "{before_lines} -> {after_lines} lines (-{})",
                before_lines - after_lines
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(old: &str, new: &str) -> Edit {
        Edit {
            old_text: old.to_string(),
            new_text: new.to_string(),
        }
    }

    #[test]
    fn exact_match_replaces_once() {
        let out = apply_edits(
            "let a = 1;\nlet b = 2;\n",
            &[edit("let a = 1;", "let a = 9;")],
            "f.rs",
        )
        .unwrap();
        assert_eq!(out, "let a = 9;\nlet b = 2;\n");
    }

    #[test]
    fn missing_target_names_the_edit_and_tells_the_model_what_to_do() {
        let err = apply_edits("hello\n", &[edit("goodbye", "x")], "f.rs").unwrap_err();
        let message = err.to_string();
        assert!(message.contains("edits[0]"), "got: {message}");
        assert!(message.contains("not found"), "got: {message}");
        assert!(message.contains("Read the file again"), "got: {message}");
    }

    #[test]
    fn ambiguous_target_is_refused_with_the_count() {
        let err = apply_edits("x = 1;\nx = 1;\n", &[edit("x = 1;", "x = 2;")], "f.rs").unwrap_err();
        let message = err.to_string();
        assert!(message.contains("appears 2 times"), "got: {message}");
        assert!(message.contains("unique"), "got: {message}");
    }

    #[test]
    fn several_edits_in_one_call_all_match_the_original() {
        let out = apply_edits(
            "one\ntwo\nthree\n",
            &[edit("one", "1"), edit("three", "3")],
            "f.rs",
        )
        .unwrap();
        assert_eq!(out, "1\ntwo\n3\n");
    }

    #[test]
    fn overlapping_edits_are_refused_by_index() {
        let err =
            apply_edits("abcdef\n", &[edit("abcd", "X"), edit("cdef", "Y")], "f.rs").unwrap_err();
        let message = err.to_string();
        assert!(message.contains("overlap"), "got: {message}");
        assert!(
            message.contains("edits[0]") && message.contains("edits[1]"),
            "got: {message}"
        );
    }

    #[test]
    fn smart_quotes_in_the_target_still_match_ascii_source() {
        // The model quoted the line back through a renderer: ' became U+2019.
        let source = "let s = \"it's here\";\n";
        let out = apply_edits(
            source,
            &[edit("let s = \"it\u{2019}s here\";", "let s = \"moved\";")],
            "f.rs",
        )
        .unwrap();
        assert_eq!(out, "let s = \"moved\";\n");
    }

    #[test]
    fn trailing_whitespace_difference_still_matches() {
        let out = apply_edits(
            "value = 1   \nnext\n",
            &[edit("value = 1", "value = 2")],
            "f.rs",
        )
        .unwrap();
        assert!(out.starts_with("value = 2"), "got: {out:?}");
    }

    #[test]
    fn a_fuzzy_match_does_not_rewrite_unrelated_lines() {
        // Line 2 must keep its em-dash even though the edit went through
        // normalization to find line 1.
        let source = "let s = \"it's here\";\n// note \u{2014} keep this dash\n";
        let out = apply_edits(
            source,
            &[edit("let s = \"it\u{2019}s here\";", "let s = \"moved\";")],
            "f.rs",
        )
        .unwrap();
        assert!(
            out.contains('\u{2014}'),
            "unchanged lines must keep their original characters: {out:?}"
        );
    }

    #[test]
    fn empty_old_text_is_refused() {
        let err = apply_edits("a\n", &[edit("", "x")], "f.rs").unwrap_err();
        assert!(err.to_string().contains("empty oldText"));
    }

    #[test]
    fn a_no_op_edit_is_refused() {
        let err = apply_edits("same\n", &[edit("same", "same")], "f.rs").unwrap_err();
        assert!(err.to_string().contains("no change"), "got: {err}");
    }

    #[test]
    fn crlf_files_keep_their_line_endings() {
        let source = "a\r\nb\r\n";
        assert_eq!(detect_line_ending(source), LineEnding::Crlf);
        let normalized = normalize_to_lf(source);
        let edited = apply_edits(&normalized, &[edit("a", "z")], "f.rs").unwrap();
        assert_eq!(
            restore_line_endings(&edited, LineEnding::Crlf),
            "z\r\nb\r\n"
        );
    }

    #[test]
    fn bom_is_split_off_and_can_be_restored() {
        let (bom, text) = strip_bom("\u{FEFF}content");
        assert_eq!(bom, "\u{FEFF}");
        assert_eq!(text, "content");
        let (none, plain) = strip_bom("content");
        assert_eq!(none, "");
        assert_eq!(plain, "content");
    }

    #[test]
    fn first_changed_line_is_one_indexed() {
        assert_eq!(first_changed_line("a\nb\nc", "a\nZ\nc"), Some(2));
        assert_eq!(first_changed_line("a\nb", "a\nb"), None);
    }

    #[test]
    fn change_summary_reports_line_delta() {
        assert!(summarize_change("a\nb", "a\nb\nc").contains("+1"));
        assert!(summarize_change("a\nb\nc", "a").contains("-2"));
        assert!(summarize_change("a\nb", "z\nb").contains("in place"));
    }
}
