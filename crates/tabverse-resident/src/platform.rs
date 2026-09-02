use anyhow::{bail, Result};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    time::Duration,
};
use wait_timeout::ChildExt;

#[cfg(windows)]
use std::{
    net::{SocketAddr, TcpStream},
    thread,
    time::Instant,
};

const PLATFORM_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(windows)]
const ENDPOINT_STOP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformKind {
    MacOs,
    Windows,
    Linux,
}

impl PlatformKind {
    pub fn current() -> Result<Self> {
        match std::env::consts::OS {
            "macos" => Ok(Self::MacOs),
            "windows" => Ok(Self::Windows),
            "linux" => Ok(Self::Linux),
            other => bail!("unsupported resident platform: {other}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallFile {
    pub path: PathBuf,
    pub contents: String,
    pub owner_only: bool,
}

/// A declarative plan. Building or testing a plan never registers a service;
/// the packaging layer applies it only as part of an explicit install flow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPlan {
    pub platform: PlatformKind,
    pub service_name: String,
    pub resident_root: PathBuf,
    pub launcher: PathBuf,
    pub files: Vec<InstallFile>,
    pub activate: Vec<String>,
    pub deactivate: Vec<String>,
    replace_existing: bool,
}

impl InstallPlan {
    pub fn render(
        platform: PlatformKind,
        resident_root: impl Into<PathBuf>,
        user_config_root: impl Into<PathBuf>,
    ) -> Result<Self> {
        Self::render_named(platform, resident_root, user_config_root, None)
    }

    /// Render a CI-only service plan whose manager identity and service file
    /// are unique to one acceptance run. Unlike the production plan it never
    /// overwrites an existing registration.
    pub fn render_acceptance(
        platform: PlatformKind,
        resident_root: impl Into<PathBuf>,
        user_config_root: impl Into<PathBuf>,
        run_id: &str,
    ) -> Result<Self> {
        validate_acceptance_run_id(run_id)?;
        Self::render_named(platform, resident_root, user_config_root, Some(run_id))
    }

    fn render_named(
        platform: PlatformKind,
        resident_root: impl Into<PathBuf>,
        user_config_root: impl Into<PathBuf>,
        acceptance_run_id: Option<&str>,
    ) -> Result<Self> {
        let resident_root = resident_root.into();
        let user_config_root = user_config_root.into();
        let launcher = resident_root.join(if platform == PlatformKind::Windows {
            "tabverse-resident-launcher.exe"
        } else {
            "tabverse-resident-launcher"
        });
        let (service_name, files, activate, deactivate) = match platform {
            PlatformKind::MacOs => {
                let service_name = acceptance_run_id
                    .map(|run_id| format!("app.tabverse.resident.acceptance.{run_id}"))
                    .unwrap_or_else(|| "app.tabverse.resident".into());
                let path = user_config_root.join(format!("LaunchAgents/{service_name}.plist"));
                let contents = format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
                     <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
                     \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
                     <plist version=\"1.0\"><dict>\n\
                     <key>Label</key><string>{}</string>\n\
                     <key>ProgramArguments</key><array><string>{}</string><string>--resident-supervisor</string></array>\n\
                     <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n\
                     </dict></plist>\n",
                    xml_text(&service_name),
                    xml(&launcher)
                );
                (
                    service_name.clone(),
                    vec![InstallFile {
                        path: path.clone(),
                        contents,
                        owner_only: true,
                    }],
                    vec![
                        "launchctl".into(),
                        "bootstrap".into(),
                        "gui/$UID".into(),
                        path.display().to_string(),
                    ],
                    vec![
                        "launchctl".into(),
                        "bootout".into(),
                        format!("gui/$UID/{service_name}"),
                    ],
                )
            }
            PlatformKind::Windows => {
                let service_name = acceptance_run_id
                    .map(|run_id| format!("TabverseResidentAcceptance-{run_id}"))
                    .unwrap_or_else(|| "TabverseResident".into());
                let path = user_config_root.join(if acceptance_run_id.is_some() {
                    format!("Tabverse/resident/acceptance/{service_name}.xml")
                } else {
                    "Tabverse/resident/TabverseResident.xml".into()
                });
                let command = xml(&launcher);
                let user = xml_text(&current_windows_user()?);
                let contents = format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
                     <Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
                     <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>\n\
                     <Principals><Principal id=\"Author\"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n\
                     <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>\n\
                     <Actions Context=\"Author\"><Exec><Command>{command}</Command><Arguments>--resident-supervisor</Arguments></Exec></Actions>\n\
                     </Task>\n"
                );
                let mut create = vec![
                    "schtasks.exe".into(),
                    "/Create".into(),
                    "/TN".into(),
                    service_name.clone(),
                    "/XML".into(),
                    path.display().to_string(),
                ];
                if acceptance_run_id.is_none() {
                    create.push("/F".into());
                }
                (
                    service_name.clone(),
                    vec![InstallFile {
                        path: path.clone(),
                        contents,
                        owner_only: true,
                    }],
                    create,
                    vec![
                        "schtasks.exe".into(),
                        "/Delete".into(),
                        "/TN".into(),
                        service_name,
                        "/F".into(),
                    ],
                )
            }
            PlatformKind::Linux => {
                let service_name = acceptance_run_id
                    .map(|run_id| format!("tabverse-resident-acceptance-{run_id}.service"))
                    .unwrap_or_else(|| "tabverse-resident.service".into());
                let path = user_config_root.join(format!("systemd/user/{service_name}"));
                let contents = format!(
                    "[Unit]\nDescription=Tabverse Resident Supervisor\n\n\
                     [Service]\nType=simple\nExecStart={} --resident-supervisor\nRestart=on-failure\n\
                     NoNewPrivileges=true\nPrivateTmp=true\n\n\
                     [Install]\nWantedBy=default.target\n",
                    systemd(&launcher)
                );
                (
                    service_name.clone(),
                    vec![InstallFile {
                        path,
                        contents,
                        owner_only: true,
                    }],
                    vec![
                        "systemctl".into(),
                        "--user".into(),
                        "enable".into(),
                        "--now".into(),
                        service_name.clone(),
                    ],
                    vec![
                        "systemctl".into(),
                        "--user".into(),
                        "disable".into(),
                        "--now".into(),
                        service_name,
                    ],
                )
            }
        };
        Ok(Self {
            platform,
            service_name,
            resident_root,
            launcher,
            files,
            activate,
            deactivate,
            replace_existing: acceptance_run_id.is_none(),
        })
    }

    /// Query the current user's native service manager for this exact service
    /// identity. Acceptance plans call this before staging so a test can never
    /// reuse or replace an unrelated registration.
    pub fn is_registered_current_user(&self) -> Result<bool> {
        let success = match self.platform {
            PlatformKind::MacOs => {
                #[cfg(target_os = "macos")]
                {
                    let service =
                        format!("gui/{}/{}", unsafe { libc::geteuid() }, self.service_name);
                    command_success(
                        Command::new("launchctl")
                            .args(["print", &service])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null()),
                        "launchctl-print",
                    )?
                }
                #[cfg(not(target_os = "macos"))]
                unreachable!();
            }
            PlatformKind::Windows => {
                #[cfg(target_os = "windows")]
                {
                    command_success(
                        Command::new("schtasks.exe")
                            .args(["/Query", "/TN", &self.service_name])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null()),
                        "schtasks-query",
                    )?
                }
                #[cfg(not(target_os = "windows"))]
                unreachable!();
            }
            PlatformKind::Linux => {
                #[cfg(target_os = "linux")]
                {
                    let enabled = command_success(
                        Command::new("systemctl")
                            .args(["--user", "is-enabled", &self.service_name])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null()),
                        "systemctl-is-enabled",
                    )?;
                    let active = command_success(
                        Command::new("systemctl")
                            .args(["--user", "is-active", &self.service_name])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null()),
                        "systemctl-is-active",
                    )?;
                    enabled || active
                }
                #[cfg(not(target_os = "linux"))]
                unreachable!();
            }
        };
        Ok(success)
    }

    /// Register and start the per-user resident service. The Tauri bridge and
    /// platform acceptance harness call this same implementation so service
    /// behavior cannot drift behind a second set of shell commands.
    pub fn activate_current_user(&self) -> Result<()> {
        let registered = self.is_registered_current_user()?;
        if registered && !self.replace_existing {
            bail!("resident-service-acceptance-collision")
        }
        match self.platform {
            PlatformKind::MacOs => {
                #[cfg(target_os = "macos")]
                {
                    let domain = format!("gui/{}", unsafe { libc::geteuid() });
                    let service = format!("{domain}/{}", self.service_name);
                    let success = if registered {
                        command_success(
                            Command::new("launchctl").args(["kickstart", "-k", &service]),
                            "launchctl-kickstart",
                        )?
                    } else {
                        command_success(
                            Command::new("launchctl")
                                .args(["bootstrap", &domain])
                                .arg(&self.files[0].path),
                            "launchctl-bootstrap",
                        )?
                    };
                    if !success {
                        bail!("resident-service-activation-failed")
                    }
                }
                #[cfg(not(target_os = "macos"))]
                unreachable!();
            }
            PlatformKind::Windows => {
                #[cfg(target_os = "windows")]
                {
                    let mut create = Command::new("schtasks.exe");
                    create
                        .args(["/Create", "/TN", &self.service_name, "/XML"])
                        .arg(&self.files[0].path);
                    if self.replace_existing {
                        create.arg("/F");
                    }
                    if !command_success(&mut create, "schtasks-create")? {
                        bail!("resident-service-activation-failed")
                    }
                    if !command_success(
                        Command::new("schtasks.exe").args(["/Run", "/TN", &self.service_name]),
                        "schtasks-run",
                    )? {
                        bail!("resident-service-start-failed")
                    }
                }
                #[cfg(not(target_os = "windows"))]
                unreachable!();
            }
            PlatformKind::Linux => {
                #[cfg(target_os = "linux")]
                {
                    for args in [
                        vec!["--user", "daemon-reload"],
                        vec!["--user", "enable", "--now", &self.service_name],
                    ] {
                        if !command_success(
                            Command::new("systemctl").args(args),
                            "systemctl-activate",
                        )? {
                            bail!("resident-service-activation-failed")
                        }
                    }
                }
                #[cfg(not(target_os = "linux"))]
                unreachable!();
            }
        }
        Ok(())
    }

    /// Restart the registered service so the stable launcher resolves the
    /// newly staged immutable supervisor slot.
    pub fn restart_current_user(&self) -> Result<()> {
        let success = match self.platform {
            PlatformKind::MacOs => {
                #[cfg(target_os = "macos")]
                {
                    let service =
                        format!("gui/{}/{}", unsafe { libc::geteuid() }, self.service_name);
                    command_success(
                        Command::new("launchctl").args(["kickstart", "-k", &service]),
                        "launchctl-kickstart",
                    )?
                }
                #[cfg(not(target_os = "macos"))]
                unreachable!();
            }
            PlatformKind::Windows => {
                #[cfg(target_os = "windows")]
                {
                    let _ = command_success(
                        Command::new("schtasks.exe").args(["/End", "/TN", &self.service_name]),
                        "schtasks-end",
                    );
                    wait_for_endpoint_down(&self.resident_root)?;
                    command_success(
                        Command::new("schtasks.exe").args(["/Run", "/TN", &self.service_name]),
                        "schtasks-run",
                    )?
                }
                #[cfg(not(target_os = "windows"))]
                unreachable!();
            }
            PlatformKind::Linux => {
                #[cfg(target_os = "linux")]
                {
                    command_success(
                        Command::new("systemctl").args(["--user", "restart", &self.service_name]),
                        "systemctl-restart",
                    )?
                }
                #[cfg(not(target_os = "linux"))]
                unreachable!();
            }
        };
        if !success {
            bail!("resident-service-restart-failed")
        }
        Ok(())
    }

    /// Stop and unregister the per-user service. Callers own removal of the
    /// rendered service file after the platform manager releases it.
    pub fn deactivate_current_user(&self) -> Result<()> {
        if !self.is_registered_current_user()? {
            return Ok(());
        }
        let success = match self.platform {
            PlatformKind::MacOs => {
                #[cfg(target_os = "macos")]
                {
                    let service =
                        format!("gui/{}/{}", unsafe { libc::geteuid() }, self.service_name);
                    command_success(
                        Command::new("launchctl").args(["bootout", &service]),
                        "launchctl-bootout",
                    )?
                }
                #[cfg(not(target_os = "macos"))]
                unreachable!();
            }
            PlatformKind::Windows => {
                #[cfg(target_os = "windows")]
                {
                    let _ = command_success(
                        Command::new("schtasks.exe").args(["/End", "/TN", &self.service_name]),
                        "schtasks-end",
                    );
                    wait_for_endpoint_down(&self.resident_root)?;
                    command_success(
                        Command::new("schtasks.exe").args([
                            "/Delete",
                            "/TN",
                            &self.service_name,
                            "/F",
                        ]),
                        "schtasks-delete",
                    )?
                }
                #[cfg(not(target_os = "windows"))]
                unreachable!();
            }
            PlatformKind::Linux => {
                #[cfg(target_os = "linux")]
                {
                    let disabled = command_success(
                        Command::new("systemctl").args([
                            "--user",
                            "disable",
                            "--now",
                            &self.service_name,
                        ]),
                        "systemctl-disable",
                    )?;
                    let reloaded = command_success(
                        Command::new("systemctl").args(["--user", "daemon-reload"]),
                        "systemctl-daemon-reload",
                    )?;
                    disabled && reloaded
                }
                #[cfg(not(target_os = "linux"))]
                unreachable!();
            }
        };
        if !success {
            bail!("resident-service-deactivation-failed")
        }
        if self.is_registered_current_user()? {
            bail!("resident-service-still-registered")
        }
        Ok(())
    }
}

fn validate_acceptance_run_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        bail!("resident-acceptance-run-id-invalid")
    }
    Ok(())
}

fn command_success(command: &mut Command, operation: &str) -> Result<bool> {
    Ok(command_status(command, operation)?.success())
}

fn command_status(command: &mut Command, operation: &str) -> Result<ExitStatus> {
    let mut child = command.spawn()?;
    if let Some(status) = child.wait_timeout(PLATFORM_COMMAND_TIMEOUT)? {
        return Ok(status);
    }
    let _ = child.kill();
    let _ = child.wait();
    bail!("resident-service-command-timeout:{operation}")
}

#[cfg(windows)]
fn wait_for_endpoint_down(resident_root: &Path) -> Result<()> {
    let deadline = Instant::now() + ENDPOINT_STOP_TIMEOUT;
    while Instant::now() < deadline {
        if !endpoint_accepts_tcp(resident_root) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    bail!("resident-service-endpoint-still-live")
}

#[cfg(windows)]
fn endpoint_accepts_tcp(resident_root: &Path) -> bool {
    let port = fs::read(resident_root.join("resident-endpoint.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("port").and_then(serde_json::Value::as_u64))
        .and_then(|port| u16::try_from(port).ok());
    port.is_some_and(|port| {
        TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(200),
        )
        .is_ok()
    })
}

/// Resolve the supervisor selected for new connections without following an
/// absolute or parent-traversing pointer. Existing runtimes keep their own
/// artifact slot; this pointer only chooses the control plane for new clients.
pub fn resolve_current_supervisor(resident_root: &Path) -> Result<PathBuf> {
    let relative = fs::read_to_string(resident_root.join("current/supervisor"))?;
    let relative = Path::new(relative.trim());
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("resident-current-pointer-invalid")
    }
    let target = resident_root.join(relative);
    if !target.is_file() {
        bail!("resident-current-supervisor-missing")
    }
    Ok(target)
}

fn xml(path: &Path) -> String {
    xml_text(&path.display().to_string())
}

fn xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(windows)]
fn current_windows_user() -> Result<String> {
    use windows_sys::Win32::Security::Authentication::Identity::{
        GetUserNameExW, NameSamCompatible,
    };

    let mut size = 0u32;
    unsafe {
        GetUserNameExW(NameSamCompatible, std::ptr::null_mut(), &mut size);
    }
    if size == 0 {
        bail!("resident-windows-user-unavailable")
    }
    let mut buffer = vec![0u16; size as usize];
    if !unsafe { GetUserNameExW(NameSamCompatible, buffer.as_mut_ptr(), &mut size) } {
        bail!("resident-windows-user-unavailable")
    }
    buffer.truncate(size as usize);
    if buffer.last() == Some(&0) {
        buffer.pop();
    }
    let user = String::from_utf16(&buffer)?;
    if user.is_empty() {
        bail!("resident-windows-user-unavailable")
    }
    Ok(user)
}

#[cfg(not(windows))]
fn current_windows_user() -> Result<String> {
    Ok("TabverseCurrentUser".into())
}

fn systemd(path: &Path) -> String {
    path.display()
        .to_string()
        .replace('\\', "\\\\")
        .replace(' ', "\\x20")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_platform_uses_a_stable_out_of_app_launcher_and_user_scope() {
        let root = PathBuf::from("/user-data/Tabverse Resident");
        for platform in [
            PlatformKind::MacOs,
            PlatformKind::Windows,
            PlatformKind::Linux,
        ] {
            let plan = InstallPlan::render(platform, &root, "/user-config").unwrap();
            assert!(plan.launcher.starts_with(&root));
            assert_eq!(plan.files.len(), 1);
            assert!(plan.files[0].owner_only);
            let rendered = &plan.files[0].contents;
            assert!(rendered.contains("resident"));
            assert!(!rendered.contains("/Applications/Tabverse.app"));
            assert!(!rendered.contains("SYSTEM"));
            assert!(!rendered.contains("enable-linger"));
            match platform {
                PlatformKind::MacOs => {
                    assert!(rendered.contains("RunAtLoad"));
                    assert!(rendered.contains("encoding=\"UTF-8\""));
                    assert_eq!(plan.activate[0], "launchctl");
                }
                PlatformKind::Windows => {
                    assert!(rendered.contains("InteractiveToken"));
                    assert!(rendered.contains("LeastPrivilege"));
                    assert!(rendered.contains("encoding=\"UTF-16\""));
                    assert!(rendered.contains("<UserId>TabverseCurrentUser</UserId>"));
                    assert_eq!(plan.activate[0], "schtasks.exe");
                }
                PlatformKind::Linux => {
                    assert!(rendered.contains("WantedBy=default.target"));
                    assert_eq!(plan.activate[..2], ["systemctl", "--user"]);
                }
            }
        }
    }

    #[test]
    fn generated_files_escape_paths_for_their_native_formats() {
        let mac =
            InstallPlan::render(PlatformKind::MacOs, "/tmp/A&B Resident", "/tmp/config").unwrap();
        assert!(mac.files[0].contents.contains("A&amp;B Resident"));
        let linux =
            InstallPlan::render(PlatformKind::Linux, "/tmp/Tabverse Resident", "/tmp/config")
                .unwrap();
        assert!(linux.files[0].contents.contains("Tabverse\\x20Resident"));
    }

    #[test]
    fn acceptance_plans_use_unique_non_overwriting_service_identities() {
        for platform in [
            PlatformKind::MacOs,
            PlatformKind::Windows,
            PlatformKind::Linux,
        ] {
            let first = InstallPlan::render_acceptance(
                platform,
                "/runner/resident-a",
                "/runner/config",
                "1234-1",
            )
            .unwrap();
            let second = InstallPlan::render_acceptance(
                platform,
                "/runner/resident-b",
                "/runner/config",
                "1234-2",
            )
            .unwrap();
            assert_ne!(first.service_name, second.service_name);
            assert_ne!(first.files[0].path, second.files[0].path);
            assert!(!first.replace_existing);
            assert!(!first.activate.iter().any(|argument| argument == "/F"));
            assert!(first.files[0]
                .path
                .to_string_lossy()
                .contains(&first.service_name));
        }
        for invalid in ["", "has space", "../escape", "under_score"] {
            assert!(InstallPlan::render_acceptance(
                PlatformKind::Linux,
                "/runner/resident",
                "/runner/config",
                invalid,
            )
            .is_err());
        }
    }

    #[test]
    fn stable_launcher_resolves_only_a_relative_immutable_slot() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("slots/supervisor@2/hash/tabverse");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"supervisor").unwrap();
        fs::create_dir_all(dir.path().join("current")).unwrap();
        fs::write(
            dir.path().join("current/supervisor"),
            "slots/supervisor@2/hash/tabverse\n",
        )
        .unwrap();
        assert_eq!(resolve_current_supervisor(dir.path()).unwrap(), target);
        for invalid in ["/Applications/Tabverse", "../outside", "slots//worker"] {
            fs::write(dir.path().join("current/supervisor"), invalid).unwrap();
            assert!(resolve_current_supervisor(dir.path()).is_err());
        }
    }
}
