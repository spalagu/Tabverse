use std::{
    fs,
    io::Write,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tabverse_runtime::agent_ipc::{
    AgentIpcStream, AuthToken as AgentToken, Frame as AgentFrame, Kind as AgentKind,
};
use tabverse_term::{
    client::HelperClient,
    protocol::{AuthToken, Frame, Kind, SessionId},
};

const TOKEN_BYTES: [u8; 32] = [0x57; 32];

#[derive(Deserialize)]
struct EndpointRecord {
    pid: u32,
    name: String,
    agent_name: String,
}

struct HelperProcess {
    child: Child,
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_helper(
    runtime_store: &std::path::Path,
    endpoint: &std::path::Path,
    content: &std::path::Path,
) -> (HelperProcess, EndpointRecord) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tabverse"))
        .arg("--helper")
        .arg(runtime_store)
        .arg(endpoint)
        .arg(content)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(&TOKEN_BYTES).unwrap();
    drop(input);

    let endpoint_path = endpoint.join("terminal-helper.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !endpoint_path.exists() && Instant::now() < deadline {
        assert!(
            child.try_wait().unwrap().is_none(),
            "Supervisor exited before publishing its endpoint"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let record = serde_json::from_slice(&fs::read(endpoint_path).unwrap()).unwrap();
    (HelperProcess { child }, record)
}

fn terminal_client(endpoint: &str) -> (HelperClient, mpsc::Receiver<Frame>) {
    let (tx, rx) = mpsc::channel();
    let (client, _, _) = HelperClient::connect(
        endpoint,
        AuthToken::new(TOKEN_BYTES),
        rand::random(),
        Arc::new(move |frame| {
            let _ = tx.send(frame);
        }),
    )
    .unwrap();
    (client, rx)
}

fn wait_for_terminal_output(rx: &mpsc::Receiver<Frame>, marker: &[u8]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut output = Vec::new();
    while Instant::now() < deadline {
        if let Ok(frame) = rx.recv_timeout(Duration::from_millis(100)) {
            if frame.kind == Kind::Output {
                output.extend_from_slice(&frame.payload);
                if output.windows(marker.len()).any(|window| window == marker) {
                    return;
                }
            }
        }
    }
    panic!(
        "terminal output did not contain {}",
        String::from_utf8_lossy(marker)
    );
}

fn receive_agent_until(stream: &mut AgentIpcStream, wanted: AgentKind) -> AgentFrame {
    loop {
        let frame = stream.recv().unwrap();
        if frame.kind == AgentKind::Error {
            panic!(
                "agent supervisor returned an error while waiting for {wanted:?}: {}",
                String::from_utf8_lossy(&frame.payload)
            );
        }
        if frame.kind == wanted {
            return frame;
        }
    }
}

#[test]
fn terminal_and_agent_survive_a_real_gui_process_boundary() {
    let root = tempfile::tempdir().unwrap();
    let runtime_store = root.path().join("data");
    let endpoint_dir = root.path().join("cache/runtime");
    let content = root.path().join("content");
    let (mut helper, endpoint) = start_helper(&runtime_store, &endpoint_dir, &content);
    assert_eq!(endpoint.pid, helper.child.id());

    let (first_terminal, first_events) = terminal_client(&endpoint.name);
    let shell = if cfg!(windows) {
        "powershell.exe"
    } else {
        "/bin/sh"
    };
    let spawn = serde_json::json!({
        "shell": shell,
        "cols": 80,
        "rows": 24,
        "shell_integration": false
    });
    let spawned = first_terminal
        .request(
            &Frame::new(
                Kind::Spawn,
                SessionId::default(),
                0,
                serde_json::to_vec(&spawn).unwrap(),
            ),
            Kind::Spawn,
            None,
            Duration::from_secs(5),
        )
        .unwrap();
    let before = if cfg!(windows) {
        b"Write-Output BEFORE-GUI-EXIT\r\n".as_slice()
    } else {
        b"printf 'BEFORE-GUI-EXIT\n'\n".as_slice()
    };
    first_terminal
        .send(&Frame::new(
            Kind::Input,
            spawned.session_id,
            spawned.generation,
            before.to_vec(),
        ))
        .unwrap();
    wait_for_terminal_output(&first_events, b"BEFORE-GUI-EXIT");
    let detached = first_terminal
        .request(
            &Frame::new(Kind::Detach, spawned.session_id, spawned.generation, vec![]),
            Kind::Detach,
            Some(spawned.session_id),
            Duration::from_secs(5),
        )
        .unwrap();
    drop(first_terminal);

    let agent_token = AgentToken::new(TOKEN_BYTES);
    let mut first_agent =
        AgentIpcStream::connect(&endpoint.agent_name, Duration::from_secs(5)).unwrap();
    first_agent
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    first_agent
        .authenticate_client(agent_token, rand::random())
        .unwrap();
    first_agent
        .send(
            &AgentFrame::json(
                AgentKind::Start,
                &serde_json::json!({
                    "request_id": 1,
                    "session_id": "agent-process-boundary",
                    "cwd": root.path(),
                }),
            )
            .unwrap(),
        )
        .unwrap();
    let first_ack = receive_agent_until(&mut first_agent, AgentKind::Ack);
    let first_reply: serde_json::Value = first_ack.decode_json().unwrap();
    let agent_handle = first_reply["handle"].as_str().unwrap().to_string();
    first_agent
        .send(&AgentFrame::json(
            AgentKind::Prompt,
            &serde_json::json!({"request_id": 2, "handle": agent_handle, "text": "persist-agent"}),
        ).unwrap())
        .unwrap();
    receive_agent_until(&mut first_agent, AgentKind::Ack);
    first_agent
        .send(
            &AgentFrame::json(
                AgentKind::Detach,
                &serde_json::json!({"request_id": 3, "handle": agent_handle}),
            )
            .unwrap(),
        )
        .unwrap();
    receive_agent_until(&mut first_agent, AgentKind::Ack);
    drop(first_agent);

    assert!(helper.child.try_wait().unwrap().is_none());
    let published_again: EndpointRecord =
        serde_json::from_slice(&fs::read(endpoint_dir.join("terminal-helper.json")).unwrap())
            .unwrap();
    assert_eq!(published_again.pid, endpoint.pid);

    let (second_terminal, second_events) = terminal_client(&endpoint.name);
    let snapshot = second_terminal
        .request(
            &Frame::new(Kind::Attach, spawned.session_id, 0, vec![]),
            Kind::Snapshot,
            Some(spawned.session_id),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(snapshot
        .payload
        .windows(b"BEFORE-GUI-EXIT".len())
        .any(|window| window == b"BEFORE-GUI-EXIT"));
    let after = if cfg!(windows) {
        b"Write-Output AFTER-GUI-START\r\n".as_slice()
    } else {
        b"printf 'AFTER-GUI-START\n'\n".as_slice()
    };
    second_terminal
        .send(&Frame::new(
            Kind::Input,
            spawned.session_id,
            snapshot.generation,
            after.to_vec(),
        ))
        .unwrap();
    wait_for_terminal_output(&second_events, b"AFTER-GUI-START");

    let mut second_agent =
        AgentIpcStream::connect(&endpoint.agent_name, Duration::from_secs(5)).unwrap();
    second_agent
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    second_agent
        .authenticate_client(agent_token, rand::random())
        .unwrap();
    second_agent
        .send(
            &AgentFrame::json(
                AgentKind::Start,
                &serde_json::json!({
                    "request_id": 4,
                    "session_id": "agent-process-boundary",
                    "cwd": root.path(),
                }),
            )
            .unwrap(),
        )
        .unwrap();
    let second_handle = loop {
        let frame = second_agent.recv().unwrap();
        if frame.kind == AgentKind::Ack {
            let reply: serde_json::Value = frame.decode_json().unwrap();
            break reply["handle"].as_str().unwrap().to_string();
        }
    };
    assert_eq!(second_handle, agent_handle);

    second_agent
        .send(
            &AgentFrame::json(
                AgentKind::Close,
                &serde_json::json!({"request_id": 5, "handle": second_handle}),
            )
            .unwrap(),
        )
        .unwrap();
    receive_agent_until(&mut second_agent, AgentKind::Ack);
    second_terminal
        .request(
            &Frame::new(
                Kind::Terminate,
                spawned.session_id,
                snapshot.generation,
                vec![],
            ),
            Kind::Terminate,
            Some(spawned.session_id),
            Duration::from_secs(5),
        )
        .unwrap();
    assert!(detached.generation < snapshot.generation);
}
