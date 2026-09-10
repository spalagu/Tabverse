//! Read a file, or hand back an image as an attachment.

use crate::path::resolve_read_path;
use crate::truncate::{format_size, truncate_head, Limits, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES};
use crate::{ContentBlock, Tool, ToolContext, ToolLocation, ToolOutput, ToolProgress};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
struct ReadInput {
    path: String,
    /// 1-indexed first line to return.
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Default)]
pub struct ReadTool;

impl Tool for ReadTool {
    fn name(&self) -> &'static str {
        "read"
    }

    fn description(&self) -> String {
        format!(
            "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). \
             Images are returned as attachments. Text output is truncated to {DEFAULT_MAX_LINES} lines \
             or {}KB, whichever is hit first. Use offset and limit for large files; to read a whole \
             file, keep advancing offset until the end is reached.",
            DEFAULT_MAX_BYTES / 1024
        )
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to read (relative or absolute)" },
                "offset": { "type": "number", "description": "Line number to start reading from (1-indexed)" },
                "limit": { "type": "number", "description": "Maximum number of lines to read" }
            },
            "required": ["path"],
            "additionalProperties": false
        })
    }

    fn execute(
        &self,
        input: serde_json::Value,
        ctx: &ToolContext<'_>,
        _on_progress: &mut dyn FnMut(ToolProgress),
    ) -> Result<ToolOutput> {
        let args: ReadInput = super::parse_input(self.name(), input)?;
        ctx.cancel.bail_if_cancelled()?;

        let resolved = resolve_read_path(ctx.env, &args.path)?;
        if !ctx.env.exists(&resolved) {
            bail!("file not found: {}", args.path);
        }
        let bytes = ctx.env.read_file(&resolved)?;

        if let Some(mime_type) = detect_image_mime(&bytes) {
            return Ok(ToolOutput {
                content: vec![ContentBlock::Image {
                    base64: base64_encode(&bytes),
                    mime_type: mime_type.to_string(),
                }],
                truncation: None,
                location: Some(ToolLocation::file(&resolved)),
            });
        }

        // Lossy on purpose: a file with a stray invalid byte should still be
        // readable rather than failing the whole call.
        let text = String::from_utf8_lossy(&bytes).into_owned();

        let offset = args.offset.unwrap_or(1).max(1);
        let windowed = if offset > 1 || args.limit.is_some() {
            let all: Vec<&str> = text.split('\n').collect();
            let start = (offset - 1).min(all.len());
            let end = match args.limit {
                Some(limit) => (start + limit).min(all.len()),
                None => all.len(),
            };
            all[start..end].join("\n")
        } else {
            text
        };

        let out = truncate_head(&windowed, Limits::default());
        let mut body = out.text;
        if out.info.truncated {
            body.push_str(&format!(
                "\n\n[truncated: showing {} of {} lines, {}]",
                out.info.lines,
                out.info.original_lines,
                format_size(out.info.bytes)
            ));
        }

        Ok(ToolOutput {
            content: vec![ContentBlock::text(body)],
            truncation: Some(out.info),
            location: Some(ToolLocation::at_line(&resolved, offset as u32)),
        })
    }
}

/// Magic-number sniffing. Extensions lie; the first bytes do not.
fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Small enough not to justify a dependency, and image attachments are the only caller.
fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::LocalEnv;
    use crate::CancelToken;

    fn run(env: &LocalEnv, input: serde_json::Value) -> Result<ToolOutput> {
        let cancel = CancelToken::new();
        let ctx = ToolContext::new(env, &cancel);
        ReadTool.execute(input, &ctx, &mut |_| {})
    }

    #[test]
    fn reads_a_text_file_and_reports_location() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello\nworld").unwrap();
        let env = LocalEnv::new(dir.path());

        let out = run(&env, json!({ "path": "a.txt" })).unwrap();
        assert_eq!(out.joined_text(), "hello\nworld");
        assert_eq!(
            out.location.unwrap().path,
            dir.path().join("a.txt"),
            "read must report where it acted"
        );
    }

    #[test]
    fn offset_and_limit_window_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("n.txt"), "1\n2\n3\n4\n5").unwrap();
        let env = LocalEnv::new(dir.path());

        let out = run(&env, json!({ "path": "n.txt", "offset": 2, "limit": 2 })).unwrap();
        assert_eq!(out.joined_text(), "2\n3");
    }

    #[test]
    fn missing_file_is_an_error_naming_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let err = run(&env, json!({ "path": "nope.txt" })).unwrap_err();
        assert!(err.to_string().contains("nope.txt"), "got: {err}");
    }

    #[test]
    fn long_files_are_truncated_with_a_notice() {
        let dir = tempfile::tempdir().unwrap();
        let body = (0..3000)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("big.txt"), &body).unwrap();
        let env = LocalEnv::new(dir.path());

        let out = run(&env, json!({ "path": "big.txt" })).unwrap();
        assert!(out.truncation.as_ref().unwrap().truncated);
        assert!(out
            .joined_text()
            .contains("[truncated: showing 2000 of 3000 lines"));
    }

    #[test]
    fn png_comes_back_as_an_image_block() {
        let dir = tempfile::tempdir().unwrap();
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        std::fs::write(dir.path().join("x.png"), png).unwrap();
        let env = LocalEnv::new(dir.path());

        let out = run(&env, json!({ "path": "x.png" })).unwrap();
        match &out.content[0] {
            ContentBlock::Image { mime_type, base64 } => {
                assert_eq!(mime_type, "image/png");
                assert!(!base64.is_empty());
            }
            other => panic!("expected an image block, got {other:?}"),
        }
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn cancelled_before_start_does_not_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let env = LocalEnv::new(dir.path());
        let cancel = CancelToken::new();
        cancel.cancel();
        let ctx = ToolContext::new(&env, &cancel);
        assert!(ReadTool
            .execute(json!({ "path": "a.txt" }), &ctx, &mut |_| {})
            .is_err());
    }
}
