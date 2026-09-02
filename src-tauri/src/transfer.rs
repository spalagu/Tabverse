use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long any one transfer may run before it is killed. scp's own
/// use — a build artifact, a log, a config — finishes well inside this;
/// a stuck connection (a blackholed port, a dead tunnel) is what the
/// deadline is for. Tests can shorten it with `TABVERSE_SCP_TIMEOUT_SECS`.
const DEFAULT_TIMEOUT_SECS: f64 = 600.0;

/// The poll cadence of the wait loop (bash.rs's number): often enough that
/// a finished transfer is noticed at once, rarely enough that waiting is
/// free.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The scp binary. `TABVERSE_SCP_BIN` points tests at a wrapper or stub.
fn scp_bin() -> String {
    #[cfg(test)]
    if let Ok(path) = std::env::var("TABVERSE_SCP_BIN") {
        return path;
    }
    "scp".to_string()
}

fn timeout() -> Duration {
    #[cfg(test)]
    if let Some(seconds) = std::env::var("TABVERSE_SCP_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|s| *s > 0.0)
    {
        return Duration::from_secs_f64(seconds);
    }
    Duration::from_secs_f64(DEFAULT_TIMEOUT_SECS)
}

/// The arguments every scp runs with, before the caller's own. BatchMode is
/// not a preference — it is what makes "no TTY" safe — so it is built in
/// here, where no caller can forget it (and where the test that pins the
/// shape lives next to it).
fn base_args() -> Vec<String> {
    vec!["-o".to_string(), "BatchMode=yes".to_string()]
}

/// Where transfers put files: the downloads directory's scp scratch
/// subdirectory, created on demand. One level below `dirs_next_download()`.
fn scratch_dir() -> Result<PathBuf> {
    let dir = crate::dirs_next_download().join("tabverse-scp");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("cannot create scp scratch dir {}", dir.display()))?;
    Ok(dir)
}

enum Outcome {
    Exited(Option<i32>),
    TimedOut(Duration),
}

/// Run scp to completion (or the deadline) and return its combined output.
///
/// stdin is null: nothing this module runs may be answered interactively,
/// and a child that asks gets EOF, not a keystroke. Output is drained on
/// threads so a transfer that fills the pipe buffer cannot wedge the poll
/// loop — the same deadlock an in-process command runner can trigger.
fn run_scp(caller_args: &[String]) -> Result<String> {
    let mut cmd = Command::new(scp_bin());
    let mut all = base_args();
    all.extend_from_slice(caller_args);
    for a in &all {
        cmd.arg(a);
    }
    // The child gets its own process group (unix): scp runs ssh as a
    // child, and a deadline kill that reached only scp would leave ssh
    // alive and holding the write ends of the pipes the readers below
    // drain — the kill "succeeds" and the function still hangs on join
    // until ssh gives up on its own, minutes later. The group kill below
    // is what makes the deadline mean what it says.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to start `{}`", scp_bin()))?;

    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let out_reader = std::thread::spawn(move || {
        let mut all = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => all.extend_from_slice(&buf[..n]),
            }
        }
        all
    });
    let err_reader = std::thread::spawn(move || {
        let mut all = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => all.extend_from_slice(&buf[..n]),
            }
        }
        all
    });

    let started = Instant::now();
    let limit = timeout();
    let outcome = loop {
        if let Some(status) = child.try_wait()? {
            break Outcome::Exited(status.code());
        }
        if started.elapsed() >= limit {
            // The GROUP, not just scp: see the spawn comment three screens
            // up. SIGKILL to the negative pgid takes ssh down with scp, so
            // the pipe write ends close and the reader joins below return
            // now rather than when ssh times out on its own.
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            break Outcome::TimedOut(limit);
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    let stdout_bytes = out_reader.join().unwrap_or_default();
    let stderr_bytes = err_reader.join().unwrap_or_default();
    let mut combined = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let errors = String::from_utf8_lossy(&stderr_bytes);
    if !errors.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&errors);
    }
    // scp's own words are the report: "Permission denied", "Host key
    // verification failed", "No such file" — the caller shows them as the
    // error's detail rather than translating them into vaguer ones. The
    // last few lines: the interesting part of a failed transfer is the end.
    let lines: Vec<&str> = combined.lines().collect();
    let tail = lines
        .iter()
        .rev()
        .take(5)
        .rev()
        .copied()
        .collect::<Vec<&str>>()
        .join("\n");

    match outcome {
        Outcome::Exited(Some(0)) => Ok(combined),
        Outcome::Exited(code) => Err(anyhow!(
            "scp failed (exit {}): {}",
            code.map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string()),
            if tail.is_empty() {
                "(no output)"
            } else {
                &tail
            }
        )),
        Outcome::TimedOut(limit) => Err(anyhow!(
            "scp timed out after {:.0}s and was killed: {}",
            limit.as_secs_f64(),
            if tail.is_empty() {
                "(no output)"
            } else {
                &tail
            }
        )),
    }
}

/// Pull one remote file into the scratch directory; resolves to the local
/// path it landed at. The wire error is the anyhow chain flattened to a
/// string — the interface shows it as the failure's detail (every existing
/// command speaks `Result<T, String>` on the wire).
#[tauri::command]
pub fn transfer_pull(host: String, remote_path: String) -> Result<String, String> {
    pull(host, remote_path).map_err(|e| format!("{e:#}"))
}

fn pull(host: String, remote_path: String) -> Result<String> {
    let host = host.trim();
    let remote_path = remote_path.trim();
    if host.is_empty() || host.contains(char::is_whitespace) {
        bail!("invalid host {host:?}");
    }
    if remote_path.is_empty() || remote_path.contains(char::is_whitespace) {
        bail!("invalid remote path {remote_path:?}");
    }
    // A `host:/path` spec is scp's own syntax; accepting the joined form
    // here would let a caller smuggle a second host in through `host`.
    if host.contains(':') {
        bail!("host must not carry a path (got {host:?})");
    }
    let name = remote_path.rsplit('/').next().unwrap_or("");
    if name.is_empty() || name == "." || name == ".." {
        bail!("remote path {remote_path:?} names no file");
    }
    let landing = scratch_dir()?.join(name);
    let spec = format!("{host}:{remote_path}");
    run_scp(&[spec, landing.to_string_lossy().into_owned()])?;
    Ok(landing.to_string_lossy().into_owned())
}

/// Push one file's bytes to a directory on the far side. The bytes arrive
/// as base64 because the interface's DOM drop has content, not a path.
#[tauri::command]
pub fn transfer_push(
    host: String,
    dir: String,
    name: String,
    data_b64: String,
) -> Result<(), String> {
    push(host, dir, name, data_b64).map_err(|e| format!("{e:#}"))
}

fn push(host: String, dir: String, name: String, data_b64: String) -> Result<()> {
    let host = host.trim();
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains(':') {
        bail!("invalid host {host:?}");
    }
    // `name` becomes one path segment on the far side; a slash in it would
    // climb, and neither side of this interface has any business writing
    // that.
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(char::is_whitespace)
    {
        bail!("invalid file name {name:?}");
    }
    let dir = dir.trim();
    if dir.is_empty() {
        bail!("empty remote directory");
    }
    let bytes = b64_engine()
        .decode(data_b64.as_bytes())
        .context("file is not valid base64")?;
    // Stage inside the same scratch directory a pull lands in, then hand
    // scp the staged path; remove the staging file whatever scp said, so
    // the scratch directory holds results, not ghosts.
    let staging = scratch_dir()?.join(format!(".staging-{}-{name}", std::process::id()));
    std::fs::write(&staging, &bytes)
        .with_context(|| format!("cannot stage {}", staging.display()))?;
    let spec = format!("{host}:{dir}/{name}");
    let outcome = run_scp(&[staging.to_string_lossy().into_owned(), spec]);
    let _ = std::fs::remove_file(&staging);
    outcome.map(|_| ())
}

fn b64_engine() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::sync::Mutex;

    /// Env-touching tests share one lock: cargo runs tests on threads, and
    /// two tests flipping TABVERSE_SCP_BIN at once would hand one of them
    /// the other's binary.
    static ENV: Mutex<()> = Mutex::new(());

    /// A stub scp that records its argv and exits 0 — what proves the
    /// invocation's SHAPE: BatchMode present, host:path joined, landing
    /// inside the scratch directory.
    #[test]
    fn pull_invokes_scp_with_batchmode_and_scratch_landing() {
        let _guard = ENV.lock().unwrap_or_else(|p| p.into_inner());
        let dir = std::env::temp_dir().join(format!("tabverse-scp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("argv");
        let stub = dir.join("scp-stub");
        let mut script = std::fs::File::create(&stub).unwrap();
        write!(
            script,
            "#!/bin/sh\necho \"$@\" > {}\nexit 0\n",
            log.to_string_lossy()
        )
        .unwrap();
        drop(script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::env::set_var("TABVERSE_SCP_BIN", &stub);
        std::env::set_var("TABVERSE_DOWNLOAD_DIR", dir.join("downloads"));

        let local = transfer_pull(
            "deploy@bastion.example.com".to_string(),
            "/var/log/app.log".to_string(),
        )
        .expect("stubbed pull succeeds");

        let argv = std::fs::read_to_string(&log).unwrap();
        // The shape assertions: BatchMode FIRST (a caller cannot outrank
        // it), the host:path spec, and the landing under tabverse-scp/.
        assert!(
            argv.starts_with("-o BatchMode=yes "),
            "BatchMode must lead the invocation, got: {argv}"
        );
        assert!(argv.contains("deploy@bastion.example.com:/var/log/app.log"));
        assert!(
            local.ends_with("tabverse-scp/app.log"),
            "landing was {local}"
        );
        assert!(PathBuf::from(&local).starts_with(dir.join("downloads")));

        std::env::remove_var("TABVERSE_SCP_BIN");
        std::env::remove_var("TABVERSE_DOWNLOAD_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreachable_host_fails_with_scp_words_not_a_hang() {
        let _guard = ENV.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var("TABVERSE_SCP_BIN");
        let started = Instant::now();
        let err = transfer_pull("no-such-host.invalid".to_string(), "/x".to_string())
            .expect_err("unreachable host must fail");
        assert!(started.elapsed() < Duration::from_secs(30));
        let words = format!("{err:#}");
        assert!(
            words.to_lowercase().contains("resolve")
                || words.to_lowercase().contains("hostname")
                || words.to_lowercase().contains("scp failed"),
            "expected scp's own complaint, got: {words}"
        );
    }

    /// A server that accepts and says nothing is the hang scp cannot break
    /// out of on its own — the deadline is what this pins. The test waits
    /// on a bounded channel so a regression that removes the kill fails
    /// the assertion instead of hanging CI forever.
    #[test]
    fn a_silent_server_is_killed_at_the_deadline() {
        let _guard = ENV.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var("TABVERSE_SCP_BIN");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept and go quiet: scp will wait for an ssh banner that never
        // comes. The read LOOPS — ssh speaks first (its client banner), and
        // a single read that consumes it and returns would drop the stream
        // and hand scp a "connection closed" instead of the silence this
        // test is built out of.
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut conn) = conn else { continue };
                std::thread::spawn(move || {
                    let _ = conn.set_read_timeout(Some(Duration::from_secs(600)));
                    let mut buf = [0u8; 1024];
                    loop {
                        match std::io::Read::read(&mut conn, &mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                });
            }
        });
        std::env::set_var("TABVERSE_SCP_TIMEOUT_SECS", "2");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            // run_scp directly: the port is the point, and host:path
            // syntax would not carry it.
            let args = vec![
                "-P".to_string(),
                port.to_string(),
                "127.0.0.1:/x".to_string(),
                std::env::temp_dir()
                    .join("tabverse-scp-hang-guard")
                    .to_string_lossy()
                    .into_owned(),
            ];
            let r = run_scp(&args);
            let _ = tx.send(r.map_err(|e| format!("{e:#}")).unwrap_or_else(|e| e));
        });
        let report = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("scp was not killed — the deadline is gone");
        assert!(report.contains("timed out"), "got: {report}");
        std::env::remove_var("TABVERSE_SCP_TIMEOUT_SECS");
    }

    /// The push's argument shape and staging cleanup, with the same stub.
    #[test]
    fn push_stages_bytes_and_targets_host_dir() {
        let _guard = ENV.lock().unwrap_or_else(|p| p.into_inner());
        let dir = std::env::temp_dir().join(format!("tabverse-scp-push-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("argv");
        // The stub copies its THIRD argument — with base_args() leading the
        // invocation ($1=-o, $2=BatchMode=yes), $3 is the staged file the
        // push hands scp — next to the log, so the test sees the bytes.
        let stub = dir.join("scp-stub");
        let mut script = std::fs::File::create(&stub).unwrap();
        write!(
            script,
            "#!/bin/sh\necho \"$@\" > {}\ncp \"$3\" {}\nexit 0\n",
            log.to_string_lossy(),
            dir.join("staged-copy").to_string_lossy()
        )
        .unwrap();
        drop(script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::env::set_var("TABVERSE_SCP_BIN", &stub);
        std::env::set_var("TABVERSE_DOWNLOAD_DIR", dir.join("downloads"));

        let payload = b"tabverse push probe";
        transfer_push(
            "box.example.com".to_string(),
            "~/cfg".to_string(),
            "settings.conf".to_string(),
            b64_engine().encode(payload),
        )
        .expect("stubbed push succeeds");

        let argv = std::fs::read_to_string(&log).unwrap();
        assert!(argv.starts_with("-o BatchMode=yes "), "got: {argv}");
        assert!(argv.contains("box.example.com:~/cfg/settings.conf"));
        assert_eq!(std::fs::read(dir.join("staged-copy")).unwrap(), payload);
        // The staging file is gone: scratch holds results, not ghosts.
        let leftover: Vec<_> = std::fs::read_dir(dir.join("downloads/tabverse-scp"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .map(|e| e.file_name().to_string_lossy().starts_with(".staging"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(leftover.is_empty(), "staging file survived: {leftover:?}");

        std::env::remove_var("TABVERSE_SCP_BIN");
        std::env::remove_var("TABVERSE_DOWNLOAD_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Bad inputs are refused before any process runs.
    #[test]
    fn rejects_path_smuggling() {
        assert!(transfer_pull("host:/etc/x".into(), "/x".into()).is_err());
        assert!(transfer_push("h".into(), "~".into(), "a/b".into(), "".into()).is_err());
        assert!(transfer_push("h".into(), "~".into(), "..".into(), "".into()).is_err());
        assert!(transfer_pull("".into(), "/x".into()).is_err());
    }

    /// The honest success path: only runs where the machine's own ssh lets
    /// BatchMode scp reach localhost (keys configured, sshd up). Anything
    /// less and this prints what it skipped on and returns — a recorded
    /// boundary, not a pretended pass.
    #[test]
    fn real_roundtrip_when_local_ssh_answers() {
        let probe = std::process::Command::new("scp")
            .args(base_args())
            .arg("localhost:/etc/hostname")
            .arg(std::env::temp_dir().join("tabverse-scp-probe"))
            .stdin(Stdio::null())
            .output();
        let ok = matches!(&probe, Ok(out) if out.status.success());
        if !ok {
            eprintln!(
                "skipped: BatchMode scp to localhost is not usable on this machine \
                 (no sshd, or no key auth) — success path left to a machine where it is"
            );
            return;
        }
        let _guard = ENV.lock().unwrap_or_else(|p| p.into_inner());
        let dir = std::env::temp_dir().join(format!("tabverse-scp-real-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("TABVERSE_DOWNLOAD_DIR", &dir);
        let src = dir.join("sentinel");
        std::fs::write(&src, "roundtrip probe").unwrap();
        // Push via localhost: the staged bytes must come back intact.
        transfer_push(
            "localhost".to_string(),
            "/tmp".to_string(),
            "tabverse-scp-roundtrip".to_string(),
            b64_engine().encode(std::fs::read(&src).unwrap()),
        )
        .expect("push over local ssh");
        let pulled = transfer_pull(
            "localhost".to_string(),
            "/tmp/tabverse-scp-roundtrip".to_string(),
        )
        .expect("pull over local ssh");
        assert_eq!(std::fs::read(&pulled).unwrap(), b"roundtrip probe");
        let _ = std::fs::remove_file("/tmp/tabverse-scp-roundtrip");
        std::env::remove_var("TABVERSE_DOWNLOAD_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
