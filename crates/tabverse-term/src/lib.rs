//! PTY session engine.
//!
//! Deliberately UI-agnostic: sessions emit bytes through callbacks so the same
//! engine serves the local webview (via Tauri channels) and remote viewers
//! (via iroh streams) without knowing about either.

pub mod backend;
pub mod client;
pub mod helper;
pub mod protocol;
pub mod replay;
pub mod shell_integration;
pub mod transport;

use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};

pub type DataCallback = Arc<dyn Fn(&[u8]) + Send + Sync + 'static>;
pub type ExitCallback = Arc<dyn Fn(Option<u32>) + Send + Sync + 'static>;

#[derive(Debug, Clone, Default)]
pub struct SpawnOpts {
    /// Absolute path of the shell binary; falls back to $SHELL, then a platform default.
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub env: Vec<(String, String)>,
    /// Emit OSC 133/7 markers so the UI can segment output into command
    /// blocks. Off in tests that assert on raw shell output.
    pub shell_integration: bool,
    pub run_on_start: Option<String>,
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

/// The user's home directory, or `None` if the environment names none.
///
/// `HOME` is a Unix variable. Windows leaves it unset and puts the profile
/// path in `USERPROFILE`, so reading only `HOME` there finds no home at all —
/// which opened every new terminal at the drive root instead of the user's
/// directory. `HOME` is still tried first: when it is set on Windows it was
/// set deliberately (git-bash, a test harness) and should win.
pub(crate) fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a shell attached to a fresh PTY. Bytes flow to `on_data` from a
    /// dedicated reader thread; `on_exit` fires exactly once when the child dies.
    pub fn create(
        &self,
        opts: SpawnOpts,
        on_data: DataCallback,
        on_exit: ExitCallback,
    ) -> Result<String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: opts.rows.max(2),
                cols: opts.cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty failed")?;

        let shell = opts.shell.clone().unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&shell);

        // Shell integration first: it may add arguments, and bash's --rcfile
        // is incompatible with -l (a login shell reads profile files instead).
        let integration_env = if opts.shell_integration {
            shell_integration::prepare(&shell).unwrap_or_default()
        } else {
            Vec::new()
        };
        let integration_args = shell_integration::args_for(&shell, &integration_env);
        if integration_args.is_empty() {
            // Login shell so the user's PATH / profile applies (POSIX only).
            if !cfg!(windows) {
                cmd.arg("-l");
            }
        } else {
            for a in &integration_args {
                cmd.arg(a);
            }
        }

        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TABVERSE", env!("CARGO_PKG_VERSION"));
        for (k, v) in &integration_env {
            cmd.env(k, v);
        }
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        let cwd = opts
            .cwd
            .clone()
            .or_else(home_dir)
            .unwrap_or_else(|| "/".to_string());
        cmd.cwd(cwd);

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .context("spawn shell failed")?;
        // The slave end lives in the child now; keep only master.
        drop(pair.slave);

        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .context("clone pty reader failed")?;
        let mut writer = pair
            .master
            .take_writer()
            .context("take pty writer failed")?;

        // Carriage return is what a terminal sends for Return under ConPTY;
        // a bare newline leaves the line sitting unexecuted at a PowerShell
        // prompt.
        if let Some(command) = &opts.run_on_start {
            let line = format!("{command}{}", if cfg!(windows) { "\r\n" } else { "\n" });
            writer
                .write_all(line.as_bytes())
                .context("send run_on_start failed")?;
            writer.flush().context("flush run_on_start failed")?;
        }

        let id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
        });
        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), session.clone());

        // Reader pump: PTY -> callback. Ends when the PTY closes.
        thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_data(&buf[..n]),
                }
            }
        });

        // Waiter: reap the child, report its exit once, then release every
        // PTY handle even when nobody sent an explicit Terminate.
        let waiter_sessions = Arc::clone(&self.sessions);
        let waiter_id = id.clone();
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            on_exit(code);
            waiter_sessions.lock().unwrap().remove(&waiter_id);
        });

        Ok(id)
    }

    fn get(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown session {id}"))
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let s = self.get(id)?;
        let mut w = s.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let s = self.get(id)?;
        s.master.lock().unwrap().resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Kill the child process and forget the session.
    pub fn kill(&self, id: &str) -> Result<()> {
        let s = self.get(id)?;
        let _ = s.killer.lock().unwrap().kill();
        self.sessions.lock().unwrap().remove(id);
        Ok(())
    }

    /// Forget a session whose child already exited on its own.
    pub fn remove(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }

    pub fn ids(&self) -> Vec<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Collect PTY output until `pred` holds or the deadline passes.
    fn drain_until(
        rx: &mpsc::Receiver<Vec<u8>>,
        secs: u64,
        pred: impl Fn(&str) -> bool,
    ) -> (bool, String) {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        let mut all = Vec::new();
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                all.extend_from_slice(&chunk);
                let s = String::from_utf8_lossy(&all).to_string();
                if pred(&s) {
                    return (true, s);
                }
            }
        }
        (false, String::from_utf8_lossy(&all).to_string())
    }

    /// Build a throwaway HOME whose startup files each set a marker, so a live
    /// shell can be asked which of them it actually read.
    fn fake_home(tag: &str) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!("tabverse-home-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".zshenv"), "export MARK_ZSHENV=yes\n").unwrap();
        std::fs::write(
            home.join(".zprofile"),
            "export MARK_ZPROFILE=yes\nexport PATH=\"/opt/fake/bin:$PATH\"\n",
        )
        .unwrap();
        std::fs::write(home.join(".zshrc"), "export MARK_ZSHRC=yes\n").unwrap();
        std::fs::write(home.join(".bash_profile"), "export MARK_BASH_PROFILE=yes\n").unwrap();
        std::fs::write(home.join(".bashrc"), "export MARK_BASHRC=yes\n").unwrap();
        home
    }

    /// Shell integration must not cost the user their environment.
    ///
    /// Pointing ZDOTDIR at a generated directory makes zsh look for *every*
    /// startup file there, so anything we do not forward is silently skipped —
    /// and `.zprofile` is exactly where Homebrew puts PATH. Launched from a
    /// terminal this hides, because the app inherits an already-good PATH;
    /// launched from the dock it leaves the user without `brew` or `node`.
    // Reported as ignored on Windows rather than skipped at runtime: a test
    // that returns early still prints `ok`, and four of those in the summary
    // read exactly like four that verified something. There is no equivalent
    // to run here — the shell integration exists only for zsh and bash.
    #[test]
    #[cfg_attr(windows, ignore = "zsh/bash shell integration is Unix-only")]
    fn zsh_integration_preserves_user_startup_files() {
        if !std::path::Path::new("/bin/zsh").exists() {
            eprintln!("no /bin/zsh on this machine; skipping");
            return;
        }
        let home = fake_home("zsh");
        let mgr = SessionManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let id = mgr
            .create(
                SpawnOpts {
                    shell: Some("/bin/zsh".into()),
                    cols: 100,
                    rows: 24,
                    shell_integration: true,
                    // An empty value, not an unset one: the generated .zshenv
                    // treats empty as "no opinion" and falls back to $HOME —
                    // which is the fake home this test means to speak for.
                    // Without this, a Tabverse terminal running the tests
                    // leaks its own TABVERSE_USER_ZDOTDIR into the child and
                    // the probe reads the developer's real dotfiles instead.
                    env: vec![
                        ("HOME".into(), home.to_string_lossy().to_string()),
                        ("TABVERSE_USER_ZDOTDIR".into(), String::new()),
                    ],
                    ..Default::default()
                },
                Arc::new(move |b| {
                    let _ = tx.send(b.to_vec());
                }),
                Arc::new(|_| {}),
            )
            .expect("create session");

        mgr.write(
            &id,
            b"echo PROBE-${MARK_ZSHENV:-no}-${MARK_ZPROFILE:-no}-${MARK_ZSHRC:-no}\n",
        )
        .expect("write");
        let (seen, transcript) = drain_until(&rx, 20, |s| s.contains("PROBE-yes-yes-yes"));
        assert!(
            seen,
            "a shell started through the integration must still read the user's \
             .zshenv, .zprofile and .zshrc; got:\n{}",
            transcript.escape_debug()
        );
        mgr.kill(&id).ok();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// bash's `--rcfile` implies a non-login shell, which skips the profile
    /// files where PATH is set up. The integration has to emulate that itself.
    #[test]
    #[cfg_attr(windows, ignore = "zsh/bash shell integration is Unix-only")]
    fn bash_integration_preserves_profile_files() {
        if !std::path::Path::new("/bin/bash").exists() {
            eprintln!("no /bin/bash on this machine; skipping");
            return;
        }
        let home = fake_home("bash");
        let mgr = SessionManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let id = mgr
            .create(
                SpawnOpts {
                    shell: Some("/bin/bash".into()),
                    cols: 100,
                    rows: 24,
                    shell_integration: true,
                    env: vec![("HOME".into(), home.to_string_lossy().to_string())],
                    ..Default::default()
                },
                Arc::new(move |b| {
                    let _ = tx.send(b.to_vec());
                }),
                Arc::new(|_| {}),
            )
            .expect("create session");

        mgr.write(&id, b"echo PROBE-${MARK_BASH_PROFILE:-no}\n")
            .expect("write");
        let (seen, transcript) = drain_until(&rx, 20, |s| s.contains("PROBE-yes"));
        assert!(
            seen,
            "bash must still read the user's profile files; got:\n{}",
            transcript.escape_debug()
        );
        mgr.kill(&id).ok();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A real login bash never sources ~/.bashrc itself — the user's profile
    /// does (or does not). If the integration adds its own .bashrc read on
    /// top, the most common macOS setup (.bash_profile sourcing .bashrc) runs
    /// it twice: PATH entries duplicate and tools like nvm initialize twice.
    #[test]
    #[cfg_attr(windows, ignore = "zsh/bash shell integration is Unix-only")]
    fn bash_integration_sources_bashrc_exactly_once() {
        if !std::path::Path::new("/bin/bash").exists() {
            eprintln!("no /bin/bash on this machine; skipping");
            return;
        }
        let home =
            std::env::temp_dir().join(format!("tabverse-home-bash-once-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        // Each startup file logs a line, so the log reveals extra sourcing
        // that env-var markers (set once, set twice — same result) would hide.
        std::fs::write(
            home.join(".bash_profile"),
            "echo profile >> \"$HOME/rc-count\"\n[ -f \"$HOME/.bashrc\" ] && . \"$HOME/.bashrc\"\n",
        )
        .unwrap();
        std::fs::write(home.join(".bashrc"), "echo bashrc >> \"$HOME/rc-count\"\n").unwrap();

        let mgr = SessionManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let id = mgr
            .create(
                SpawnOpts {
                    shell: Some("/bin/bash".into()),
                    cols: 100,
                    rows: 24,
                    shell_integration: true,
                    env: vec![("HOME".into(), home.to_string_lossy().to_string())],
                    ..Default::default()
                },
                Arc::new(move |b| {
                    let _ = tx.send(b.to_vec());
                }),
                Arc::new(|_| {}),
            )
            .expect("create session");

        // Startup files have all run once a typed command produces output; the
        // arithmetic keeps the echoed input from satisfying the predicate.
        mgr.write(&id, b"echo SYNC-$((40+2))\n").expect("write");
        let (synced, transcript) = drain_until(&rx, 20, |s| s.contains("SYNC-42"));
        assert!(
            synced,
            "bash never reached a working prompt; got:\n{}",
            transcript.escape_debug()
        );

        let log = std::fs::read_to_string(home.join("rc-count")).unwrap_or_default();
        assert_eq!(
            log.matches("profile").count(),
            1,
            ".bash_profile must run exactly once; log:\n{log}"
        );
        assert_eq!(
            log.matches("bashrc").count(),
            1,
            ".bashrc must be sourced exactly once (by the profile, never by the \
             integration itself); log:\n{log}"
        );
        mgr.kill(&id).ok();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The integration is only real if a live shell actually emits the markers.
    /// Checking that the rc file *contains* them would pass even if the shell
    /// never loaded it.
    #[test]
    #[cfg_attr(windows, ignore = "zsh/bash shell integration is Unix-only")]
    fn zsh_emits_command_block_markers() {
        if !std::path::Path::new("/bin/zsh").exists() {
            eprintln!("no /bin/zsh on this machine; skipping");
            return;
        }
        let mgr = SessionManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let id = mgr
            .create(
                SpawnOpts {
                    shell: Some("/bin/zsh".into()),
                    cols: 80,
                    rows: 24,
                    shell_integration: true,
                    ..Default::default()
                },
                Arc::new(move |b| {
                    let _ = tx.send(b.to_vec());
                }),
                Arc::new(|_| {}),
            )
            .expect("create session");

        // Wait for the first prompt marker, then run a command.
        let (saw_prompt, prompt_transcript) = drain_until(&rx, 15, |s| s.contains("\u{1b}]133;A"));
        assert!(saw_prompt, "no prompt-start marker from a live zsh");

        mgr.write(&id, b"echo blockcheck\n").expect("write");
        // 'echo blockcheck' base64 -> ZWNobyBibG9ja2NoZWNr
        let (saw_all, transcript) = drain_until(&rx, 15, |s| {
            s.contains("133;C;cmdline_b64=ZWNobyBibG9ja2NoZWNr") && s.contains("133;D;0")
        });
        assert!(
            saw_all,
            "expected command-start (with the command line) and exit-0 markers; got:\n{}",
            transcript.escape_debug()
        );
        assert!(
            prompt_transcript.contains("\u{1b}]7;file://")
                || transcript.contains("\u{1b}]7;file://"),
            "expected a working-directory marker"
        );
        mgr.kill(&id).ok();
    }

    /// Where a real fish lives on this machine, if it does. Both Homebrew
    /// prefixes plus the usual Linux packaging slots.
    fn find_fish() -> Option<&'static str> {
        [
            "/opt/homebrew/bin/fish",
            "/usr/local/bin/fish",
            "/usr/bin/fish",
            "/bin/fish",
        ]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
    }

    /// A throwaway HOME whose config.fish defines a function and logs one
    /// line, so a live fish can be asked both "did my config run" (the
    /// function works) and "did it run exactly once" (the log line count).
    fn fake_fish_home(tag: &str) -> std::path::PathBuf {
        let home =
            std::env::temp_dir().join(format!("tabverse-fish-home-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let cfg = home.join(".config").join("fish");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(
            cfg.join("config.fish"),
            format!(
                "echo RAN >> {}/fish-config-log\nfunction userfn_probe\n    echo USERFN-yes\nend\n",
                home.to_string_lossy()
            ),
        )
        .unwrap();
        home
    }

    /// Shell integration must not cost fish users their config. fish's -C
    /// runs after config.fish, so the integration never needs to forward
    /// anything — but that is exactly what has to be proven, not assumed: a
    /// displaced config (0 runs) or a doubled one (2 runs) would look
    /// identical in the terminal output, and only the log tells them apart.
    #[test]
    #[cfg_attr(windows, ignore = "fish shell integration is Unix-only here")]
    fn fish_integration_preserves_user_config() {
        let Some(fish) = find_fish() else {
            eprintln!("no fish on this machine; skipping");
            return;
        };
        let home = fake_fish_home("config");
        let mgr = SessionManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let id = mgr
            .create(
                SpawnOpts {
                    shell: Some(fish.into()),
                    cols: 100,
                    rows: 24,
                    shell_integration: true,
                    // XDG_CONFIG_HOME pinned so a developer's exported value
                    // cannot redirect fish to a different config.
                    env: vec![
                        ("HOME".into(), home.to_string_lossy().to_string()),
                        (
                            "XDG_CONFIG_HOME".into(),
                            home.join(".config").to_string_lossy().to_string(),
                        ),
                    ],
                    ..Default::default()
                },
                Arc::new(move |b| {
                    let _ = tx.send(b.to_vec());
                }),
                Arc::new(|_| {}),
            )
            .expect("create session");

        mgr.write(&id, b"userfn_probe\n").expect("write");
        let (seen, transcript) = drain_until(&rx, 20, |s| s.contains("USERFN-yes"));
        assert!(
            seen,
            "a fish started through the integration must still run the user's \
             config.fish (their functions should work); got:\n{}",
            transcript.escape_debug()
        );
        let log = std::fs::read_to_string(home.join("fish-config-log")).unwrap_or_default();
        assert_eq!(
            log.matches("RAN").count(),
            1,
            "config.fish must run exactly once — never displaced, never doubled; log:\n{log}"
        );
        mgr.kill(&id).ok();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The integration is only real if a live fish emits the markers
    /// byte-for-byte like the zsh version: A/C/D + OSC 7 + the base64 command
    /// line. The trailing C-count assertion is the fish-specific
    /// discriminator: fish >= 4.0 emits its own OSC 133 with a cmdline_url=
    /// payload that the UI would double-book into a second empty block, so
    /// prepare() passes `--features no-mark-prompt` — if that ever stops
    /// reaching argv, a second "]133;C" shows up right here.
    #[test]
    #[cfg_attr(windows, ignore = "fish shell integration is Unix-only here")]
    fn fish_emits_command_block_markers() {
        let Some(fish) = find_fish() else {
            eprintln!("no fish on this machine; skipping");
            return;
        };
        let mgr = SessionManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let id = mgr
            .create(
                SpawnOpts {
                    shell: Some(fish.into()),
                    cols: 80,
                    rows: 24,
                    shell_integration: true,
                    ..Default::default()
                },
                Arc::new(move |b| {
                    let _ = tx.send(b.to_vec());
                }),
                Arc::new(|_| {}),
            )
            .expect("create session");

        // Wait for the first prompt marker, then run a command.
        let (saw_prompt, _) = drain_until(&rx, 20, |s| s.contains("\u{1b}]133;A"));
        assert!(saw_prompt, "no prompt-start marker from a live fish");

        mgr.write(&id, b"echo blockcheck\n").expect("write");
        // 'echo blockcheck' base64 -> ZWNobyBibG9ja2NoZWNr. All four markers
        // ride one predicate: the prompt-cycle handler emits D then OSC 7 then
        // A back to back, and returning at the first D (as a split assertion
        // would) races the OSC 7 bytes still in flight.
        let (saw_all, transcript) = drain_until(&rx, 20, |s| {
            s.contains("\u{1b}]133;C;cmdline_b64=ZWNobyBibG9ja2NoZWNr\u{7}")
                && s.contains("\u{1b}]133;D;0\u{7}")
                && s.contains("\u{1b}]7;file://")
                && s.contains("\u{1b}]133;B\u{7}")
        });
        assert!(
            saw_all,
            "expected command-start (with the command line, byte-exact), \
             exit-0, working-directory and prompt-end markers; got:\n{}",
            transcript.escape_debug()
        );
        assert_eq!(
            transcript.matches("]133;C").count(),
            1,
            "exactly one command-start marker per command — fish's built-in \
             markers must be silenced by --features no-mark-prompt"
        );
        mgr.kill(&id).ok();
    }

    /// A shell this platform has, in a dialect this test knows how to speak.
    ///
    /// Not `default_shell`: on Unix that follows `$SHELL`, and the arithmetic
    /// below has to be spelled for a shell we can name.
    fn probe_shell() -> String {
        if cfg!(windows) {
            "powershell.exe".into()
        } else {
            "/bin/sh".into()
        }
    }

    /// Carriage return is what a terminal sends for Return under ConPTY; a
    /// bare newline leaves the line unexecuted at the PowerShell prompt.
    fn line(cmd: &str) -> Vec<u8> {
        format!("{cmd}{}", if cfg!(windows) { "\r\n" } else { "\n" }).into_bytes()
    }

    /// Round-trip: spawn a real shell, run `echo`, observe the marker in output,
    /// then kill and observe exit. This is the engine's ground-truth test.
    #[test]
    fn pty_echo_roundtrip() {
        let mgr = SessionManager::new();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Option<u32>>();
        let id = mgr
            .create(
                SpawnOpts {
                    shell: Some(probe_shell()),
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                Arc::new(move |b| {
                    let _ = tx.send(b.to_vec());
                }),
                Arc::new(move |c| {
                    let _ = etx.send(c);
                }),
            )
            .expect("create session");

        // The arithmetic is the point: `tabverse_42` in the output proves a
        // real shell evaluated the line, where the literal text would only
        // prove the bytes came back. POSIX and PowerShell differ in spelling.
        let echo = if cfg!(windows) {
            "echo tabverse_$(40+2)"
        } else {
            "echo tabverse_$((40+2))"
        };
        mgr.write(&id, &line(echo)).expect("write");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut all = Vec::new();
        let mut seen = false;
        // Cursor-position reports answered as they arrive, counted against the
        // whole buffer so a report split across two reads is still seen.
        let mut answered = 0usize;
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                all.extend_from_slice(&chunk);
                let asked = all.windows(4).filter(|w| *w == b"\x1b[6n").count();
                while answered < asked {
                    mgr.write(&id, b"\x1b[1;1R").expect("answer cursor report");
                    answered += 1;
                }
                if String::from_utf8_lossy(&all).contains("tabverse_42") {
                    seen = true;
                    break;
                }
            }
        }
        assert!(
            seen,
            "expected echo output, got: {}",
            String::from_utf8_lossy(&all)
        );

        mgr.write(&id, &line("exit")).expect("write exit");
        let code = erx
            .recv_timeout(Duration::from_secs(10))
            .expect("exit callback");
        assert_eq!(code, Some(0));
    }
}
