use anyhow::{Context, Result};
use std::io::Write;

/// Size past which a single result is folded on its way into the history.
///
/// Well under the 50KB a tool may legally return: three results at that ceiling
/// are already 150KB, and the point is to stop them from adding up to a
/// compaction. Roughly 2000 tokens.
pub const BRANCH_THRESHOLD_BYTES: usize = 8 * 1024;

/// Lines kept from each end. The head of a result says what it is; the tail of
/// one says how it came out.
pub const KEPT_LINES: usize = 30;

/// A result folded down, with the whole of it left somewhere addressable.
#[derive(Debug, Clone, PartialEq)]
pub struct Folded {
    pub text: String,
    /// Where the full content went, when it was written out.
    pub spilled_to: Option<String>,
    pub original_bytes: usize,
    pub elided_lines: usize,
}

/// Fold a tool result if it is big enough to be worth folding.
///
/// `spill` receives the full content and returns where it put it. Injected so
/// the caller decides the storage — and so a test can assert on the skeleton
/// without touching a filesystem.
pub fn fold(content: &str, spill: &mut dyn FnMut(&str) -> Result<String>) -> Result<Folded> {
    let original_bytes = content.len();
    if original_bytes <= BRANCH_THRESHOLD_BYTES {
        return Ok(Folded {
            text: content.to_string(),
            spilled_to: None,
            original_bytes,
            elided_lines: 0,
        });
    }

    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= KEPT_LINES * 2 {
        // Few lines but many bytes: one enormous line, or a handful of them.
        // There is no middle to elide, so leave it to truncation, which has
        // already bounded it, rather than cutting a line in half.
        return Ok(Folded {
            text: content.to_string(),
            spilled_to: None,
            original_bytes,
            elided_lines: 0,
        });
    }

    let path = spill(content)?;
    let elided = lines.len() - KEPT_LINES * 2;
    let head = lines[..KEPT_LINES].join("\n");
    let tail = lines[lines.len() - KEPT_LINES..].join("\n");

    let text = format!(
        "{head}\n\n[{elided} lines elided to save context. The full {} output is at {path} — \
         read that file if you need the part that is not shown.]\n\n{tail}",
        crate::branch::format_bytes(original_bytes)
    );

    Ok(Folded {
        text,
        spilled_to: Some(path),
        original_bytes,
        elided_lines: elided,
    })
}

fn format_bytes(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Write the full content somewhere it can be read back.
pub fn spill_to_temp_file(content: &str) -> Result<String> {
    let mut file = tempfile::Builder::new()
        .prefix("tabverse-tool-")
        .suffix(".txt")
        .tempfile()
        .context("failed to create a file for the full tool output")?;
    file.write_all(content.as_bytes())?;
    let (_, path) = file.keep().context("failed to keep the full tool output")?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_spill() -> impl FnMut(&str) -> Result<String> {
        |_: &str| Ok("/tmp/full.txt".to_string())
    }

    fn lines(n: usize, width: usize) -> String {
        (0..n)
            .map(|i| format!("{i} {}", "x".repeat(width)))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_small_result_is_passed_through_untouched() {
        let content = "just a few lines\nof output";
        let out = fold(content, &mut no_spill()).unwrap();
        assert_eq!(out.text, content);
        assert_eq!(out.spilled_to, None);
        assert_eq!(out.elided_lines, 0);
    }

    #[test]
    fn a_result_right_at_the_threshold_is_left_alone() {
        let content = "x".repeat(BRANCH_THRESHOLD_BYTES);
        assert_eq!(fold(&content, &mut no_spill()).unwrap().spilled_to, None);
    }

    #[test]
    fn a_large_result_keeps_both_ends_and_says_what_it_dropped() {
        let content = lines(500, 40);
        let out = fold(&content, &mut no_spill()).unwrap();

        assert!(
            out.text.len() < content.len() / 4,
            "got {} bytes",
            out.text.len()
        );
        assert!(out.text.starts_with("0 "), "the head says what it is");
        assert!(
            out.text
                .trim_end()
                .ends_with(&format!("499 {}", "x".repeat(40))),
            "the tail says how it came out"
        );
        assert_eq!(out.elided_lines, 500 - KEPT_LINES * 2);
        assert!(out.text.contains("lines elided"));
        assert!(
            out.text.contains("/tmp/full.txt"),
            "and where the rest went"
        );
        assert!(
            out.text.contains("read that file"),
            "the model has to be told it can go and get the rest"
        );
    }

    #[test]
    fn one_enormous_line_is_not_cut_in_half() {
        // Many bytes, few lines: there is no middle to elide, and slicing a
        // line at an arbitrary point produces something that reads as data but
        // is not. Truncation has already bounded this case.
        let content = "y".repeat(BRANCH_THRESHOLD_BYTES * 3);
        let out = fold(&content, &mut no_spill()).unwrap();
        assert_eq!(out.text, content);
        assert_eq!(out.spilled_to, None);
    }

    #[test]
    fn the_full_content_is_what_gets_written_out() {
        let content = lines(500, 40);
        let mut captured = String::new();
        let mut spill = |full: &str| {
            captured = full.to_string();
            Ok("/tmp/full.txt".to_string())
        };
        fold(&content, &mut spill).unwrap();
        assert_eq!(
            captured, content,
            "the file must hold everything, not the skeleton"
        );
    }

    #[test]
    fn a_spill_that_fails_is_reported_rather_than_losing_the_middle() {
        // Folding without somewhere to put the rest would silently destroy it.
        let content = lines(500, 40);
        let mut spill = |_: &str| anyhow::bail!("disk full");
        let err = fold(&content, &mut spill).unwrap_err();
        assert!(err.to_string().contains("disk full"));
    }

    #[test]
    fn what_is_written_can_be_read_back_exactly() {
        let content = lines(500, 40);
        let path = spill_to_temp_file(&content).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        std::fs::remove_file(path).ok();
    }
}
