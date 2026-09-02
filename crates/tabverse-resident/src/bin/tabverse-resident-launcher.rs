use std::{env, path::Path, process::Command};

#[cfg(windows)]
use std::{thread, time::Duration};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

fn main() {
    let code = run().unwrap_or_else(|error| {
        eprintln!("Tabverse Resident launcher failed: {error}");
        1
    });
    std::process::exit(code);
}

fn run() -> anyhow::Result<i32> {
    let launcher = env::current_exe()?;
    let root = launcher
        .parent()
        .ok_or_else(|| anyhow::anyhow!("launcher has no resident root"))?
        .to_path_buf();

    launch(&root)
}

fn supervisor_command(root: &Path) -> anyhow::Result<Command> {
    let supervisor = tabverse_resident::resolve_current_supervisor(root)?;
    let mut command = Command::new(supervisor);
    command
        .arg("--resident-supervisor")
        .arg("--resident-root")
        .arg(root)
        .args(env::args_os().skip(1));
    Ok(command)
}

#[cfg(unix)]
fn launch(root: &Path) -> anyhow::Result<i32> {
    use std::os::unix::process::CommandExt;
    let mut command = supervisor_command(root)?;
    Err(command.exec().into())
}

#[cfg(windows)]
fn launch(root: &Path) -> anyhow::Result<i32> {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const RESTART_DELAY: Duration = Duration::from_secs(1);

    let job = KillOnCloseJob::new()?;

    // Task Scheduler keeps this stable launcher alive as the task action.
    // A killed child is not a reliable Task Scheduler failure signal, so the
    // launcher itself owns supervisor recovery and resolves the current slot
    // again on every attempt. The private kill-on-close job makes `/End`
    // deterministically terminate the current Supervisor process tree too.
    loop {
        match supervisor_command(root).and_then(|mut command| {
            let mut child = command.creation_flags(CREATE_NO_WINDOW).spawn()?;
            if let Err(error) = job.assign(child.as_raw_handle() as HANDLE) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(child.wait()?)
        }) {
            Ok(status) => {
                eprintln!("Tabverse Resident supervisor exited with {status}; restarting")
            }
            Err(error) => {
                eprintln!("Tabverse Resident supervisor launch failed: {error}; retrying")
            }
        }
        thread::sleep(RESTART_DELAY);
    }
}

#[cfg(windows)]
struct KillOnCloseJob(HANDLE);

#[cfg(windows)]
impl KillOnCloseJob {
    fn new() -> anyhow::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(error.into());
        }
        Ok(Self(handle))
    }

    fn assign(&self, process: HANDLE) -> anyhow::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn launch(root: &Path) -> anyhow::Result<i32> {
    let mut command = supervisor_command(root)?;
    let status = command.status()?;
    Ok(status.code().unwrap_or(1))
}
