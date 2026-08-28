//! Keeping tool output from eating the context window.
//!
//! A single `grep` or a chatty build can emit tens of thousands of lines. Handed
//! to the model whole, one tool call would consume the budget the whole session
//! needs. Two directions matter and they are not interchangeable: reading a file
//! keeps the **head** (you want the top of the file and then page down), while a
//! command keeps the **tail** (the interesting part of a build log is the end).
//!
//! Limits adapted from Pi's `packages/agent/src/harness/utils/truncate.ts`; see
//! the repository's `NOTICE` file for attribution and license terms.

/// Line ceiling before truncation kicks in.
pub const DEFAULT_MAX_LINES: usize = 2000;
/// Byte ceiling before truncation kicks in.
pub const DEFAULT_MAX_BYTES: usize = 50 * 1024;
/// Per-line ceiling for search matches, so one minified file cannot dominate.
pub const GREP_MAX_LINE_LENGTH: usize = 500;

/// Which ceiling was hit, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TruncatedBy {
    Lines,
    Bytes,
}

#[derive(Debug, Clone)]
pub struct Truncation {
    /// Lines actually returned.
    pub lines: usize,
    /// Bytes actually returned.
    pub bytes: usize,
    /// Lines the untruncated content had.
    pub original_lines: usize,
    pub truncated: bool,
    pub truncated_by: Option<TruncatedBy>,
}

#[derive(Debug, Clone)]
pub struct Truncated {
    pub text: String,
    pub info: Truncation,
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_lines: usize,
    pub max_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_lines: DEFAULT_MAX_LINES,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }
}

/// Keep the beginning. Used when reading files.
pub fn truncate_head(content: &str, limits: Limits) -> Truncated {
    truncate(content, limits, Keep::Head)
}

/// Keep the end. Used for command output.
pub fn truncate_tail(content: &str, limits: Limits) -> Truncated {
    truncate(content, limits, Keep::Tail)
}

#[derive(Clone, Copy)]
enum Keep {
    Head,
    Tail,
}

fn truncate(content: &str, limits: Limits, keep: Keep) -> Truncated {
    let all: Vec<&str> = content.split('\n').collect();
    let original_lines = all.len();

    // Line ceiling first, then bytes over whatever survived.
    let (mut kept, by_lines): (Vec<&str>, bool) = if original_lines > limits.max_lines {
        let slice = match keep {
            Keep::Head => all[..limits.max_lines].to_vec(),
            Keep::Tail => all[original_lines - limits.max_lines..].to_vec(),
        };
        (slice, true)
    } else {
        (all, false)
    };

    let mut by_bytes = false;
    loop {
        let size: usize = kept
            .iter()
            .map(|l| l.len() + 1)
            .sum::<usize>()
            .saturating_sub(1);
        if size <= limits.max_bytes || kept.len() <= 1 {
            break;
        }
        by_bytes = true;
        match keep {
            Keep::Head => {
                kept.pop();
            }
            Keep::Tail => {
                kept.remove(0);
            }
        }
    }

    let text = kept.join("\n");
    // Bytes are reported ahead of lines: hitting the byte ceiling is the more
    // surprising outcome and the one worth telling the model about.
    let truncated_by = if by_bytes {
        Some(TruncatedBy::Bytes)
    } else if by_lines {
        Some(TruncatedBy::Lines)
    } else {
        None
    };

    Truncated {
        info: Truncation {
            lines: kept.len(),
            bytes: text.len(),
            original_lines,
            truncated: truncated_by.is_some(),
            truncated_by,
        },
        text,
    }
}

/// Human-readable size for the notice appended to truncated output.
pub fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(n: usize) -> String {
        (0..n).map(|i| i.to_string()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn short_content_is_untouched() {
        let out = truncate_head("a\nb\nc", Limits::default());
        assert!(!out.info.truncated);
        assert_eq!(out.text, "a\nb\nc");
        assert_eq!(out.info.original_lines, 3);
    }

    #[test]
    fn head_keeps_the_beginning() {
        let out = truncate_head(&lines(3000), Limits::default());
        assert!(out.info.truncated);
        assert_eq!(out.info.truncated_by, Some(TruncatedBy::Lines));
        assert!(out.text.starts_with("0\n1\n2"));
        assert_eq!(out.info.lines, DEFAULT_MAX_LINES);
        assert_eq!(out.info.original_lines, 3000);
    }

    #[test]
    fn tail_keeps_the_end() {
        let out = truncate_tail(&lines(3000), Limits::default());
        assert!(out.info.truncated);
        assert!(out.text.ends_with("2997\n2998\n2999"));
        assert_eq!(out.info.lines, DEFAULT_MAX_LINES);
    }

    #[test]
    fn byte_ceiling_applies_within_the_line_budget() {
        // 100 lines, far under the line ceiling, but way over a tiny byte ceiling.
        let content = (0..100)
            .map(|_| "x".repeat(100))
            .collect::<Vec<_>>()
            .join("\n");
        let out = truncate_head(
            &content,
            Limits {
                max_lines: DEFAULT_MAX_LINES,
                max_bytes: 500,
            },
        );
        assert!(out.info.truncated);
        assert_eq!(out.info.truncated_by, Some(TruncatedBy::Bytes));
        assert!(out.info.bytes <= 500);
    }

    #[test]
    fn a_single_oversized_line_is_not_dropped_to_nothing() {
        let out = truncate_head(
            &"y".repeat(5000),
            Limits {
                max_lines: 10,
                max_bytes: 100,
            },
        );
        assert_eq!(out.info.lines, 1, "must not truncate below one line");
    }

    #[test]
    fn size_formatting() {
        assert_eq!(format_size(512), "512B");
        assert_eq!(format_size(50 * 1024), "50.0KB");
    }
}
