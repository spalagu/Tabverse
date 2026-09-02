use crate::{RunningWorker, SpawnedWorker, WorkerContext, WorkerFactory, WorkerOutput};
use anyhow::{anyhow, bail, Result};
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
};

const MAX_WORKER_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub struct ProcessWorkerFactory {
    #[cfg(debug_assertions)]
    allow_in_process_test_parent: bool,
}

impl ProcessWorkerFactory {
    #[cfg(debug_assertions)]
    pub fn for_in_process_tests() -> Self {
        Self {
            allow_in_process_test_parent: true,
        }
    }
}

impl WorkerFactory for ProcessWorkerFactory {
    fn spawn(&self, context: WorkerContext) -> Result<SpawnedWorker> {
        let mut command = Command::new(&context.entrypoint);
        command
            .arg("--resident-worker")
            .arg(&context.runtime.kind)
            .env("TABVERSE_RUNTIME_ID", &context.runtime.runtime_id)
            .env("TABVERSE_TAB_ID", &context.runtime.tab_id)
            .env(
                "TABVERSE_RUNTIME_GENERATION",
                context.runtime.generation.to_string(),
            )
            .env(
                "TABVERSE_RESIDENT_SUPERVISOR_PID",
                std::process::id().to_string(),
            )
            .env("TABVERSE_RESIDENT_ROOT", &context.resident_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(debug_assertions)]
        if self.allow_in_process_test_parent {
            command.env("TABVERSE_RESIDENT_IN_PROCESS_TEST_PARENT", "1");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|_| anyhow!("resident-worker-spawn-failed"))?;
        if let Some(stdin) = child.stdin.as_mut() {
            write_worker_input(
                stdin,
                &serde_json::to_vec(&serde_json::json!({
                    "type": "initialize",
                    "checkpoint": context.initial_checkpoint,
                }))?,
            )?;
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("resident-worker-stdout-unavailable"))?;
        let (output_tx, output_rx) = mpsc::channel();
        thread::Builder::new()
            .name(format!(
                "tabverse-resident-worker-output-{}",
                context.runtime.runtime_id
            ))
            .spawn(move || read_worker_output(stdout, output_tx))?;
        Ok(SpawnedWorker {
            worker: Arc::new(ProcessWorker {
                child: Mutex::new(child),
            }),
            output: output_rx,
        })
    }
}

fn read_worker_output(mut stdout: impl Read, output: mpsc::Sender<WorkerOutput>) {
    loop {
        let mut length = [0u8; 4];
        if stdout.read_exact(&mut length).is_err() {
            break;
        }
        let length = u32::from_be_bytes(length) as usize;
        if length > MAX_WORKER_OUTPUT_BYTES {
            break;
        }
        let mut bytes = vec![0; length];
        if stdout.read_exact(&mut bytes).is_err() {
            break;
        }
        let Ok(message) = serde_json::from_slice(&bytes) else {
            break;
        };
        if output.send(message).is_err() {
            return;
        }
    }
    let _ = output.send(WorkerOutput::Exited);
}

struct ProcessWorker {
    child: Mutex<Child>,
}

impl RunningWorker for ProcessWorker {
    fn send(&self, payload: &[u8]) -> Result<()> {
        let mut child = self.child.lock().unwrap();
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("resident-worker-stdin-closed"))?;
        write_worker_input(stdin, payload)
    }

    fn terminate(&self) -> Result<()> {
        let mut child = self.child.lock().unwrap();
        if child.try_wait()?.is_none() {
            child.kill()?;
            let _ = child.wait();
        }
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.child
            .lock()
            .unwrap()
            .try_wait()
            .is_ok_and(|status| status.is_none())
    }
}

fn write_worker_input(writer: &mut impl Write, payload: &[u8]) -> Result<()> {
    if payload.len() > u32::MAX as usize {
        bail!("resident-intent-too-large")
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

impl Drop for ProcessWorker {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn frame(message: &WorkerOutput) -> Vec<u8> {
        let bytes = serde_json::to_vec(message).unwrap();
        let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
        frame.extend(bytes);
        frame
    }

    #[test]
    fn worker_stdout_frames_preserve_event_checkpoint_order_and_finish_with_exit() {
        let mut bytes = frame(&WorkerOutput::Event {
            payload: json!({"n": 1}),
        });
        bytes.extend(frame(&WorkerOutput::Checkpoint {
            seq: 1,
            checkpoint: json!({"n": 1}),
        }));
        let (sender, receiver) = mpsc::channel();
        read_worker_output(Cursor::new(bytes), sender);
        assert!(matches!(
            receiver.recv().unwrap(),
            WorkerOutput::Event { payload } if payload == json!({"n": 1})
        ));
        assert!(matches!(
            receiver.recv().unwrap(),
            WorkerOutput::Checkpoint { seq: 1, checkpoint } if checkpoint == json!({"n": 1})
        ));
        assert!(matches!(receiver.recv().unwrap(), WorkerOutput::Exited));
    }

    #[test]
    fn oversized_worker_frame_is_never_allocated_or_forwarded() {
        let (sender, receiver) = mpsc::channel();
        read_worker_output(
            Cursor::new(((MAX_WORKER_OUTPUT_BYTES + 1) as u32).to_be_bytes()),
            sender,
        );
        assert!(matches!(receiver.recv().unwrap(), WorkerOutput::Exited));
        assert!(receiver.try_recv().is_err());
    }
}
