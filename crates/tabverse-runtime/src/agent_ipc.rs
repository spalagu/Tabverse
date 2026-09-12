//! Authenticated, versioned local IPC for supervisor-owned Agent sessions.
//!
//! Agent traffic is semantic JSON, unlike Terminal's raw PTY byte stream. The
//! shared executable will use this protocol in its windowless runtime mode;
//! Tauri remains only the GUI-side adapter.

use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    sync::{Arc, Mutex},
    time::Duration,
};

use hmac::{Hmac, Mac};
use interprocess::local_socket::{
    prelude::*, ConnectOptions, GenericNamespaced, ListenerNonblockingMode, ListenerOptions,
};
use interprocess::{ConnectWaitMode, TryClone};
use sha2::Sha256;

const VERSION: u8 = 1;
const TOKEN_BYTES: usize = 32;
const NONCE_BYTES: usize = 32;
const PROOF_BYTES: usize = 32;
const FIXED_BODY: usize = 2;
const MAX_FRAME_BODY: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Hello = 1,
    Welcome = 2,
    Start = 3,
    Prompt = 4,
    Cancel = 5,
    Answer = 6,
    Close = 7,
    Event = 8,
    Ack = 9,
    Error = 10,
    Detach = 11,
}

impl TryFrom<u8> for Kind {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::Hello),
            2 => Ok(Self::Welcome),
            3 => Ok(Self::Start),
            4 => Ok(Self::Prompt),
            5 => Ok(Self::Cancel),
            6 => Ok(Self::Answer),
            7 => Ok(Self::Close),
            8 => Ok(Self::Event),
            9 => Ok(Self::Ack),
            10 => Ok(Self::Error),
            11 => Ok(Self::Detach),
            other => Err(ProtocolError::UnknownKind(other)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub kind: Kind,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(kind: Kind, payload: Vec<u8>) -> Self {
        Self { kind, payload }
    }

    pub fn json(kind: Kind, value: &impl serde::Serialize) -> Result<Self, serde_json::Error> {
        Ok(Self::new(kind, serde_json::to_vec(value)?))
    }

    pub fn decode_json<T: serde::de::DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_slice(&self.payload)
    }

    fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let body_len = FIXED_BODY
            .checked_add(self.payload.len())
            .ok_or(ProtocolError::FrameTooLarge(usize::MAX))?;
        if body_len > MAX_FRAME_BODY {
            return Err(ProtocolError::FrameTooLarge(body_len));
        }
        let mut encoded = Vec::with_capacity(4 + body_len);
        encoded.extend_from_slice(&(body_len as u32).to_be_bytes());
        encoded.push(VERSION);
        encoded.push(self.kind as u8);
        encoded.extend_from_slice(&self.payload);
        Ok(encoded)
    }
}

#[derive(Debug)]
pub enum ProtocolError {
    FrameTooLarge(usize),
    FrameTooShort(usize),
    UnknownVersion(u8),
    UnknownKind(u8),
    Unauthorized,
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FrameTooLarge(size) => write!(f, "agent IPC frame is too large: {size}"),
            Self::FrameTooShort(size) => write!(f, "agent IPC frame is too short: {size}"),
            Self::UnknownVersion(version) => {
                write!(f, "unsupported agent IPC version: {version}")
            }
            Self::UnknownKind(kind) => write!(f, "unknown agent IPC kind: {kind}"),
            Self::Unauthorized => f.write_str("unauthorized agent IPC connection"),
        }
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Clone, Copy)]
pub struct AuthToken([u8; TOKEN_BYTES]);

impl AuthToken {
    pub const fn new(bytes: [u8; TOKEN_BYTES]) -> Self {
        Self(bytes)
    }

    fn hello(self, nonce: [u8; NONCE_BYTES]) -> Vec<u8> {
        let mut payload = Vec::with_capacity(NONCE_BYTES + PROOF_BYTES);
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&self.proof(&[b"client", &nonce]));
        payload
    }

    fn welcome(self, client_nonce: &[u8], server_nonce: [u8; NONCE_BYTES]) -> Vec<u8> {
        let mut payload = Vec::with_capacity(NONCE_BYTES + PROOF_BYTES);
        payload.extend_from_slice(&server_nonce);
        payload.extend_from_slice(&self.proof(&[b"server", client_nonce, &server_nonce]));
        payload
    }

    fn verify(self, parts: &[&[u8]], candidate: &[u8]) -> bool {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).expect("HMAC accepts any key size");
        for part in parts {
            mac.update(part);
        }
        mac.verify_slice(candidate).is_ok()
    }

    fn proof(self, parts: &[&[u8]]) -> [u8; PROOF_BYTES] {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).expect("HMAC accepts any key size");
        for part in parts {
            mac.update(part);
        }
        mac.finalize().into_bytes().into()
    }
}

impl std::fmt::Debug for AuthToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AuthToken([REDACTED])")
    }
}

pub struct AgentIpcStream {
    stream: LocalSocketStream,
    buffered: Vec<u8>,
    pending: VecDeque<Frame>,
}

impl AgentIpcStream {
    pub fn new(stream: LocalSocketStream) -> Self {
        Self {
            stream,
            buffered: Vec::new(),
            pending: VecDeque::new(),
        }
    }

    pub fn connect(endpoint: &str, timeout: Duration) -> io::Result<Self> {
        let name = endpoint.to_ns_name::<GenericNamespaced>()?;
        let stream = ConnectOptions::new()
            .name(name)
            .wait_mode(ConnectWaitMode::Timeout(timeout))
            .connect_sync()?;
        Ok(Self::new(stream))
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.stream.set_recv_timeout(timeout)
    }

    pub fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        self.stream.set_nonblocking(nonblocking)
    }

    pub fn sender(&self) -> io::Result<AgentIpcSender> {
        Ok(AgentIpcSender {
            stream: Arc::new(Mutex::new(self.stream.try_clone()?)),
        })
    }

    pub fn send(&mut self, frame: &Frame) -> Result<(), TransportError> {
        self.stream.write_all(&frame.encode()?)?;
        self.stream.flush()?;
        Ok(())
    }

    pub fn recv(&mut self) -> Result<Frame, TransportError> {
        if let Some(frame) = self.pending.pop_front() {
            return Ok(frame);
        }
        let mut chunk = [0u8; 8192];
        loop {
            let count = self.stream.read(&mut chunk)?;
            if count == 0 {
                return Err(TransportError::Closed);
            }
            self.buffered.extend_from_slice(&chunk[..count]);
            self.decode_available()?;
            if let Some(frame) = self.pending.pop_front() {
                return Ok(frame);
            }
        }
    }

    fn decode_available(&mut self) -> Result<(), ProtocolError> {
        loop {
            if self.buffered.len() < 4 {
                return Ok(());
            }
            let body_len = u32::from_be_bytes(self.buffered[..4].try_into().unwrap()) as usize;
            if body_len < FIXED_BODY {
                return Err(ProtocolError::FrameTooShort(body_len));
            }
            if body_len > MAX_FRAME_BODY {
                return Err(ProtocolError::FrameTooLarge(body_len));
            }
            if self.buffered.len() < 4 + body_len {
                return Ok(());
            }
            let version = self.buffered[4];
            if version != VERSION {
                return Err(ProtocolError::UnknownVersion(version));
            }
            let kind = Kind::try_from(self.buffered[5])?;
            let payload = self.buffered[6..4 + body_len].to_vec();
            self.buffered.drain(..4 + body_len);
            self.pending.push_back(Frame::new(kind, payload));
        }
    }

    pub fn authenticate_client(
        &mut self,
        token: AuthToken,
        nonce: [u8; NONCE_BYTES],
    ) -> Result<(), TransportError> {
        self.send(&Frame::new(Kind::Hello, token.hello(nonce)))?;
        let response = self.recv()?;
        let authorized = response.kind == Kind::Welcome
            && response.payload.len() == NONCE_BYTES + PROOF_BYTES
            && token.verify(
                &[b"server", &nonce, &response.payload[..NONCE_BYTES]],
                &response.payload[NONCE_BYTES..],
            );
        if !authorized {
            return Err(ProtocolError::Unauthorized.into());
        }
        Ok(())
    }

    pub fn authenticate_server(
        &mut self,
        token: AuthToken,
        nonce: [u8; NONCE_BYTES],
    ) -> Result<(), TransportError> {
        let first = self.recv();
        let authorized = first.as_ref().is_ok_and(|frame| {
            frame.kind == Kind::Hello
                && frame.payload.len() == NONCE_BYTES + PROOF_BYTES
                && token.verify(
                    &[b"client", &frame.payload[..NONCE_BYTES]],
                    &frame.payload[NONCE_BYTES..],
                )
        });
        if !authorized {
            let _ = self.send(&Frame::new(Kind::Error, b"unauthorized".to_vec()));
            return Err(ProtocolError::Unauthorized.into());
        }
        let client_nonce = &first.expect("authorized frame exists").payload[..NONCE_BYTES];
        self.send(&Frame::new(
            Kind::Welcome,
            token.welcome(client_nonce, nonce),
        ))
    }
}

#[derive(Clone)]
pub struct AgentIpcSender {
    stream: Arc<Mutex<LocalSocketStream>>,
}

impl AgentIpcSender {
    pub fn send(&self, frame: &Frame) -> Result<(), TransportError> {
        let encoded = frame.encode()?;
        let mut stream = self.stream.lock().unwrap();
        stream.write_all(&encoded)?;
        stream.flush()?;
        Ok(())
    }
}

/// Cross-platform Agent Supervisor listener: Unix domain socket on macOS and
/// Linux, named pipe on Windows.
pub struct AgentIpcListener {
    listener: LocalSocketListener,
}

impl AgentIpcListener {
    pub fn bind(endpoint: &str) -> io::Result<Self> {
        let name = endpoint.to_ns_name::<GenericNamespaced>()?;
        let listener = ListenerOptions::new()
            .name(name)
            .nonblocking(ListenerNonblockingMode::Both)
            .create_sync()?;
        Ok(Self { listener })
    }

    pub fn accept(&self) -> io::Result<AgentIpcStream> {
        self.listener.accept().map(AgentIpcStream::new)
    }
}

#[derive(Debug)]
pub enum TransportError {
    Io(io::Error),
    Protocol(ProtocolError),
    Closed,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "agent IPC I/O failed: {error}"),
            Self::Protocol(error) => write!(f, "agent IPC protocol failed: {error}"),
            Self::Closed => f.write_str("agent IPC connection closed"),
        }
    }
}

impl std::error::Error for TransportError {}

impl From<io::Error> for TransportError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<ProtocolError> for TransportError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use interprocess::local_socket::{GenericNamespaced, ListenerOptions};

    fn endpoint() -> String {
        format!(
            "tabverse-agent-ipc-test-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        )
    }

    #[test]
    fn authenticated_semantic_frames_cross_the_platform_local_transport() {
        let endpoint = endpoint();
        let name = endpoint.as_str().to_ns_name::<GenericNamespaced>().unwrap();
        let listener = ListenerOptions::new().name(name).create_sync().unwrap();
        let token = AuthToken::new(rand::random());
        let server = std::thread::spawn(move || {
            let mut stream = AgentIpcStream::new(listener.accept().unwrap());
            stream.authenticate_server(token, rand::random()).unwrap();
            let request = stream.recv().unwrap();
            assert_eq!(
                request,
                Frame::new(Kind::Prompt, r#"{"text":"hello"}"#.as_bytes().to_vec())
            );
            stream
                .send(&Frame::new(Kind::Event, br#"{"type":"done"}"#.to_vec()))
                .unwrap();
        });

        let mut client = AgentIpcStream::connect(&endpoint, Duration::from_secs(2)).unwrap();
        client.authenticate_client(token, rand::random()).unwrap();
        client
            .send(&Frame::new(
                Kind::Prompt,
                r#"{"text":"hello"}"#.as_bytes().to_vec(),
            ))
            .unwrap();
        assert_eq!(
            client.recv().unwrap(),
            Frame::new(Kind::Event, br#"{"type":"done"}"#.to_vec())
        );
        server.join().unwrap();
    }

    #[test]
    fn a_callback_sender_can_emit_while_the_request_reader_is_blocked() {
        let endpoint = endpoint();
        let listener = AgentIpcListener::bind(&endpoint).unwrap();
        let token = AuthToken::new(rand::random());
        let server = std::thread::spawn(move || {
            let mut stream = loop {
                match listener.accept() {
                    Ok(stream) => break stream,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::yield_now();
                    }
                    Err(error) => panic!("accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream.authenticate_server(token, rand::random()).unwrap();
            let sender = stream.sender().unwrap();
            std::thread::spawn(move || {
                sender
                    .send(&Frame::new(Kind::Event, b"async".to_vec()))
                    .unwrap();
            })
            .join()
            .unwrap();
            assert_eq!(stream.recv().unwrap().kind, Kind::Ack);
        });

        let mut client = AgentIpcStream::connect(&endpoint, Duration::from_secs(2)).unwrap();
        client.authenticate_client(token, rand::random()).unwrap();
        assert_eq!(client.recv().unwrap().payload, b"async");
        client.send(&Frame::new(Kind::Ack, Vec::new())).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn a_wrong_token_gets_one_unauthorized_shape_and_no_session_access() {
        let endpoint = endpoint();
        let name = endpoint.as_str().to_ns_name::<GenericNamespaced>().unwrap();
        let listener = ListenerOptions::new().name(name).create_sync().unwrap();
        let server_token = AuthToken::new(rand::random());
        let client_token = loop {
            let candidate = AuthToken::new(rand::random());
            if candidate.0 != server_token.0 {
                break candidate;
            }
        };
        let server = std::thread::spawn(move || {
            let mut stream = AgentIpcStream::new(listener.accept().unwrap());
            assert!(matches!(
                stream.authenticate_server(server_token, rand::random()),
                Err(TransportError::Protocol(ProtocolError::Unauthorized))
            ));
        });

        let mut client = AgentIpcStream::connect(&endpoint, Duration::from_secs(2)).unwrap();
        assert!(matches!(
            client.authenticate_client(client_token, rand::random()),
            Err(TransportError::Protocol(ProtocolError::Unauthorized))
        ));
        server.join().unwrap();
    }

    #[test]
    fn oversized_frames_are_rejected_before_write_or_allocation() {
        let frame = Frame::new(Kind::Event, vec![0; MAX_FRAME_BODY]);
        assert!(matches!(
            frame.encode(),
            Err(ProtocolError::FrameTooLarge(_))
        ));
    }

    #[test]
    fn the_authentication_token_never_appears_on_the_wire() {
        let bytes = rand::random();
        let hello = AuthToken::new(bytes).hello(rand::random());
        assert!(!hello.windows(TOKEN_BYTES).any(|window| window == bytes));
    }
}
