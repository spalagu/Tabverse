//! Run a shell command.
//!
//! Deliberately a plain child process rather than an embedded shell. Tabverse
//! already owns a PTY in `tabverse-term` for the interactive case, while this
//! tool only needs the system shell's command execution semantics.
//!
//! Output keeps the **tail**: the interesting part of a build log is the end.

use crate::truncate::{format_size, truncate_tail, Limits, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES};
use crate::{Tool, ToolContext, ToolOutput, ToolProgress};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::io::{Read, Write as _};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// Upper bound on a caller-supplied timeout. A model asking for a day-long
/// command is a mistake, not an intention.
const MAX_TIMEOUT_SECONDS: f64 = 600.0;
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Deserialize)]
struct BashInput {
    command: String,
    /// Seconds. No default — many legitimate commands are slow.
    #[serde(default)]
    timeout: Option<f64>,
}

#[derive(Default)]
pub struct BashTool;

impl Tool for BashTool {
    fn name(&self) -> &'static str {
        "bash"
    }

    fn description(&self) -> String {
        format!(
            "Execute a shell command in the current working directory. Returns stdout and stderr \
             combined. Output is truncated to the last {DEFAULT_MAX_LINES} lines or {}KB, whichever \
             is hit first; when truncated, the full output is written to a temporary file whose path \
             is reported. Optionally provide a timeout in seconds (maximum {MAX_TIMEOUT_SECONDS:.0}).",
            DEFAULT_MAX_BYTES / 1024
        )
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to execute" },
                "timeout": { "type": "number", "description": "Timeout in seconds (optional)" }
            },
            "required": ["command"],
            "additionalProperties": false
        })
    }

    fn execute(
        &self,
        input: serde_json::Value,
        ctx: &ToolContext<'_>,
        on_progress: &mut dyn FnMut(ToolProgress),
    ) -> Result<ToolOutput> {
        let args: BashInput = super::parse_input(self.name(), input)?;
        validate_timeout(args.timeout)?;
        ctx.cancel.bail_if_cancelled()?;

        let (program, flag) = shell_invocation();
        let mut command = Command::new(program);
        command
            .arg(flag)
            .arg(&args.command)
            .current_dir(ctx.env.cwd())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to start `{program}`"))?;

        // Drained on threads so a command that fills the pipe buffer cannot wedge
        // while we are polling for exit. Each chunk is forwarded as it lands, not
        // only at the end: a build that prints for two minutes has to be visible
        // for those two minutes, otherwise the tab looks hung.
        let mut stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");
        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let out_tx = chunk_tx.clone();
        let out_reader = std::thread::spawn(move || drain(&mut stdout, out_tx));
        let err_reader = std::thread::spawn(move || drain(&mut stderr, chunk_tx));

        // Hand whatever has arrived to the caller. Called from the poll loop and
        // once more after exit, so nothing written in the last instant is lost.
        let pump = |on_progress: &mut dyn FnMut(ToolProgress)| {
            while let Ok(chunk) = chunk_rx.try_recv() {
                on_progress(ToolProgress::Output(
                    String::from_utf8_lossy(&chunk).into_owned(),
                ));
            }
        };

        let started = Instant::now();
        let deadline = args.timeout.map(Duration::from_secs_f64);
        let outcome = loop {
            pump(on_progress);
            if let Some(status) = child.try_wait()? {
                break Outcome::Exited(status.code());
            }
            if ctx.cancel.is_cancelled() {
                stop_child(&mut child);
                break Outcome::Cancelled;
            }
            if let Some(limit) = deadline {
                if started.elapsed() >= limit {
                    stop_child(&mut child);
                    break Outcome::TimedOut(limit);
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        };

        let stdout_bytes = out_reader.join().unwrap_or_default();
        let stderr_bytes = err_reader.join().unwrap_or_default();
        // The readers have finished, so anything still queued is the tail.
        pump(on_progress);
        let mut combined = String::from_utf8_lossy(&stdout_bytes).into_owned();
        let errors = String::from_utf8_lossy(&stderr_bytes);
        if !errors.is_empty() {
            if !combined.is_empty() && !combined.ends_with('\n') {
                combined.push('\n');
            }
            combined.push_str(&errors);
        }

        if let Outcome::Cancelled = outcome {
            bail!("command cancelled");
        }

        let truncated = truncate_tail(&combined, Limits::default());
        let mut body = truncated.text.clone();

        if truncated.info.truncated {
            let full_path = spill_full_output(&combined)?;
            body.push_str(&format!(
                "\n\n[truncated: showing last {} of {} lines, {}. Full output: {}]",
                truncated.info.lines,
                truncated.info.original_lines,
                format_size(combined.len()),
                full_path
            ));
        }

        match outcome {
            Outcome::TimedOut(limit) => {
                body.push_str(&format!(
                    "\n\n[timed out after {:.0}s and was killed]",
                    limit.as_secs_f64()
                ));
            }
            Outcome::Exited(Some(code)) if code != 0 => {
                body.push_str(&format!("\n\n[exit code {code}]"));
            }
            Outcome::Exited(None) => {
                body.push_str("\n\n[terminated by signal]");
            }
            _ => {}
        }

        Ok(ToolOutput {
            content: vec![crate::ContentBlock::text(body)],
            truncation: Some(truncated.info),
            location: None,
        })
    }
}

/// Read to EOF, forwarding every chunk as it arrives and keeping a copy for the
/// final result. The copy is what gets truncated and returned to the model; the
/// forwarded chunks are what the user watches.
fn drain(reader: &mut impl Read, tx: std::sync::mpsc::Sender<Vec<u8>>) -> Vec<u8> {
    let mut all = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                all.extend_from_slice(&buf[..n]);
                // A closed receiver means the caller stopped listening; keep
                // reading anyway so the pipe does not fill and wedge the child.
                let _ = tx.send(buf[..n].to_vec());
            }
        }
    }
    all
}

enum Outcome {
    Exited(Option<i32>),
    TimedOut(Duration),
    Cancelled,
}

fn validate_timeout(timeout: Option<f64>) -> Result<()> {
    let Some(value) = timeout else { return Ok(()) };
    if !value.is_finite() || value <= 0.0 {
        bail!("invalid timeout: must be a finite positive number of seconds");
    }
    if value > MAX_TIMEOUT_SECONDS {
        bail!("invalid timeout: maximum is {MAX_TIMEOUT_SECONDS:.0} seconds");
    }
    Ok(())
}

#[cfg(windows)]
fn shell_invocation() -> (&'static str, &'static str) {
    ("cmd", "/C")
}

#[cfg(not(windows))]
fn shell_invocation() -> (&'static str, &'static str) {
    ("/bin/sh", "-c")
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    // The shell can start descendants that inherit stdout/stderr. Put the shell
    // in its own group so cancellation also closes those descendants' pipes.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_: &mut Command) {}

#[cfg(unix)]
fn stop_child(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        let _ = libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(not(unix))]
fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Park the untruncated output somewhere the user (or a later tool call) can read it.
fn spill_full_output(content: &str) -> Result<String> {
    let mut file = tempfile::Builder::new()
        .prefix("tabverse-bash-")
        .suffix(".log")
        .tempfile()
        .context("failed to create a temp file for full command output")?;
    file.write_all(content.as_bytes())?;
    let (_, path) = file
        .keep()
        .context("failed to persist full command output")?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::LocalEnv;
    use crate::CancelToken;

    fn run(env: &LocalEnv, input: serde_json::Value) -> Result<ToolOutput> {
        let cancel = CancelToken::new();
        let ctx = ToolContext::new(env, &cancel);
        BashTool.execute(input, &ctx, &mut |_| {})
    }

    #[test]
    fn captures_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "command": "echo hello" })).unwrap();
        assert!(
            out.joined_text().contains("hello"),
            "got: {}",
            out.joined_text()
        );
    }

    #[test]
    fn captures_stderr_too() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "command": "echo oops 1>&2" })).unwrap();
        assert!(out.joined_text().contains("oops"));
    }

    #[test]
    fn runs_in_the_env_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "x").unwrap();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "command": "ls" })).unwrap();
        assert!(out.joined_text().contains("marker.txt"));
    }

    #[test]
    fn reports_non_zero_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "command": "exit 3" })).unwrap();
        assert!(
            out.joined_text().contains("[exit code 3]"),
            "got: {}",
            out.joined_text()
        );
    }

    #[test]
    fn kills_a_command_that_outruns_its_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let started = Instant::now();
        // A guard value far above the timeout: if the kill does not happen the
        // test hangs long enough to be obviously wrong rather than flaky.
        let out = run(&env, json!({ "command": "sleep 30", "timeout": 0.5 })).unwrap();
        assert!(
            out.joined_text().contains("timed out"),
            "got: {}",
            out.joined_text()
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "kill did not take effect"
        );
    }

    #[test]
    fn output_reaches_the_caller_while_the_command_is_still_running() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let cancel = CancelToken::new();
        let ctx = ToolContext::new(&env, &cancel);

        let start = Instant::now();
        let mut first_at: Option<Duration> = None;
        let mut seen = String::new();
        BashTool
            .execute(
                json!({ "command": "echo early; sleep 1; echo late" }),
                &ctx,
                &mut |p| {
                    let ToolProgress::Output(text) = p;
                    first_at.get_or_insert(start.elapsed());
                    seen.push_str(&text);
                },
            )
            .unwrap();
        let total = start.elapsed();

        assert!(seen.contains("early"), "got: {seen:?}");
        assert!(seen.contains("late"), "the tail must arrive too: {seen:?}");
        // Discriminating on purpose: collecting output and emitting it once at
        // the end would put the first chunk at ~total, not at a fraction of it.
        let first = first_at.expect("progress must be emitted at all");
        assert!(
            first < total / 2,
            "first chunk arrived at {first:?} of a {total:?} run — that is only at the end"
        );
    }

    #[test]
    fn rejects_an_out_of_range_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        assert!(run(&env, json!({ "command": "echo x", "timeout": 0 })).is_err());
        assert!(run(&env, json!({ "command": "echo x", "timeout": 100000 })).is_err());
    }

    #[test]
    fn huge_output_is_tail_truncated_and_spilled_to_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "command": "seq 1 5000" })).unwrap();
        let text = out.joined_text();
        assert!(out.truncation.as_ref().unwrap().truncated);
        assert!(text.contains("5000"), "tail must be kept");
        assert!(
            !text.contains("\n1\n2\n3\n"),
            "head should have been dropped"
        );

        let marker = "Full output: ";
        let path = text[text.find(marker).expect("spill path reported") + marker.len()..]
            .trim_end_matches(']')
            .trim();
        let spilled = std::fs::read_to_string(path).expect("spilled file readable");
        let spilled_lines: Vec<&str> = spilled.trim_end_matches('\n').split('\n').collect();
        assert_eq!(
            spilled_lines.first(),
            Some(&"1"),
            "spill must start at the head"
        );
        assert_eq!(
            spilled_lines.last(),
            Some(&"5000"),
            "spill must reach the tail"
        );
        assert_eq!(spilled_lines.len(), 5000, "spill must hold every line");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cancellation_stops_a_running_command() {
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let cancel = CancelToken::new();
        let flag = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            flag.cancel();
        });
        let ctx = ToolContext::new(&env, &cancel);
        let started = Instant::now();
        let result = BashTool.execute(json!({ "command": "sleep 30" }), &ctx, &mut |_| {});
        assert!(result.is_err(), "cancelled command must not report success");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "kill did not take effect"
        );
    }

    #[test]
    fn a_hundred_thousand_lines_do_not_reach_the_model() {
        // The size the acceptance criterion names. Both ceilings are in play:
        // 2000 lines is the count, and 100000 six-digit numbers is far past the
        // byte budget, so the byte one is what actually binds here.
        let dir = tempfile::tempdir().unwrap();
        let env = LocalEnv::new(dir.path());
        let out = run(&env, json!({ "command": "seq 1 100000" })).unwrap();
        let text = out.joined_text();

        assert!(
            text.len() <= crate::truncate::DEFAULT_MAX_BYTES + 300,
            "one command must not spend the whole context, got {} bytes",
            text.len()
        );
        let info = out.truncation.as_ref().unwrap();
        // Splitting on '\n' counts the empty tail after the final newline, so
        // 100000 lines report as 100001. Harmless in a notice, but an assertion
        // should say what is true rather than what reads nicely.
        assert_eq!(info.original_lines, 100_001);
        assert!(info.lines <= DEFAULT_MAX_LINES);
        assert!(
            text.contains("[truncated: showing last "),
            "the model must be able to see that it is looking at a fragment"
        );
        // The tail is the part worth keeping for a command, and the notice
        // points at the whole thing on disk.
        let last_number = text
            .lines()
            .rfind(|l| l.chars().all(|c| c.is_ascii_digit()) && !l.is_empty())
            .unwrap()
            .to_string();
        assert_eq!(
            last_number, "100000",
            "the end is what a command's reader wants"
        );
        let spill = text
            .rsplit("Full output: ")
            .next()
            .unwrap()
            .trim_end_matches(']');
        assert_eq!(
            std::fs::read_to_string(spill).unwrap().lines().count(),
            100_000,
            "nothing is actually lost; it is parked where it can be read"
        );
    }
}
