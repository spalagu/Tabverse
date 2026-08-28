//! Turning what a model typed into a path that actually opens.
//!
//! Models produce paths that are *almost* right in predictable ways, and every
//! variant handled here comes from a real failure mode rather than caution:
//! a leading `@` because that is how files get referenced in chat, exotic
//! Unicode spaces pasted out of rendered text, and — on macOS — filenames whose
//! on-disk bytes differ from what was typed because the filesystem stores them
//! decomposed, or because a screenshot's name carries a narrow no-break space
//! before AM/PM.
//!
//! Adapted from Pi's `packages/agent/src/harness/tools/path-utils.ts`; see the
//! repository's `NOTICE` file for attribution and license terms.

use crate::env::ExecutionEnv;
use anyhow::Result;
use std::path::PathBuf;
use unicode_normalization::UnicodeNormalization;

/// Space-like characters that are not U+0020 but read as one.
const UNICODE_SPACES: [char; 15] = [
    '\u{00A0}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}',
    '\u{2007}', '\u{2008}', '\u{2009}', '\u{200A}', '\u{202F}', '\u{205F}', '\u{3000}',
];

const NARROW_NO_BREAK_SPACE: char = '\u{202F}';
const RIGHT_SINGLE_QUOTE: char = '\u{2019}';

/// Collapse space lookalikes and drop the chat-style `@` prefix.
pub fn normalize_tool_path(path: &str) -> String {
    let collapsed: String = path
        .chars()
        .map(|c| if UNICODE_SPACES.contains(&c) { ' ' } else { c })
        .collect();
    collapsed
        .strip_prefix('@')
        .map(str::to_string)
        .unwrap_or(collapsed)
}

/// Resolve a path for writing: normalize, then make absolute. No existence probing —
/// the file is usually supposed to not exist yet.
pub fn resolve_tool_path(env: &dyn ExecutionEnv, path: &str) -> Result<PathBuf> {
    env.absolute_path(&normalize_tool_path(path))
}

/// Resolve a path for reading, trying the variants that differ only in how the
/// same name can be encoded. Returns the first variant that exists; if none do,
/// returns the plain resolution so the caller reports a sensible "not found".
pub fn resolve_read_path(env: &dyn ExecutionEnv, path: &str) -> Result<PathBuf> {
    let resolved = resolve_tool_path(env, path)?;
    let base = resolved.to_string_lossy().to_string();

    let mut variants = vec![
        base.clone(),
        narrow_space_before_meridiem(&base),
        base.nfd().collect::<String>(),
        base.replace('\'', &RIGHT_SINGLE_QUOTE.to_string()),
        base.nfd()
            .collect::<String>()
            .replace('\'', &RIGHT_SINGLE_QUOTE.to_string()),
    ];
    variants.dedup();

    for variant in &variants {
        let candidate = PathBuf::from(variant);
        if env.exists(&candidate) {
            return Ok(candidate);
        }
    }
    Ok(resolved)
}

/// `"Shot 3.04.12 PM.png"` -> `"Shot 3.04.12\u{202F}PM.png"`.
/// Screenshot names on macOS carry a narrow no-break space that round-trips as
/// a plain space through most UIs, so the typed name never matches on disk.
fn narrow_space_before_meridiem(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let is_boundary = chars[i] == ' '
            && i + 3 <= chars.len().saturating_sub(1)
            && matches!(chars[i + 1], 'A' | 'P' | 'a' | 'p')
            && matches!(chars[i + 2], 'M' | 'm')
            && chars.get(i + 3) == Some(&'.');
        if is_boundary {
            out.push(NARROW_NO_BREAK_SPACE);
        } else {
            out.push(chars[i]);
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::LocalEnv;

    #[test]
    fn strips_chat_style_at_prefix() {
        assert_eq!(normalize_tool_path("@src/main.rs"), "src/main.rs");
    }

    #[test]
    fn collapses_unicode_spaces() {
        assert_eq!(normalize_tool_path("my\u{00A0}file.txt"), "my file.txt");
        assert_eq!(normalize_tool_path("a\u{3000}b.txt"), "a b.txt");
    }

    #[test]
    fn leaves_ordinary_paths_alone() {
        assert_eq!(normalize_tool_path("src/main.rs"), "src/main.rs");
    }

    #[test]
    fn inserts_narrow_space_before_meridiem() {
        assert_eq!(
            narrow_space_before_meridiem("Shot 3.04.12 PM.png"),
            "Shot 3.04.12\u{202F}PM.png"
        );
        // A space before "PM" that is not part of a timestamp stays put.
        assert_eq!(
            narrow_space_before_meridiem("note PM notes"),
            "note PM notes"
        );
    }

    #[test]
    fn read_path_finds_decomposed_filename() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        // Store the name decomposed, ask for it composed.
        let decomposed: String = "café.txt".nfd().collect();
        std::fs::write(dir.path().join(&decomposed), "x").unwrap();

        let found = resolve_read_path(&env, "café.txt").unwrap();
        assert!(
            env.exists(&found),
            "expected a variant of the name to resolve"
        );
    }

    #[test]
    fn read_path_falls_back_to_plain_resolution() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let missing = resolve_read_path(&env, "nope.txt").unwrap();
        assert_eq!(missing, dir.path().join("nope.txt"));
    }
}
