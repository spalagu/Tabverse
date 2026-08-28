//! Versioned framing and authentication for the resident terminal helper.
//!
//! The hot path is binary on purpose: terminal input, output, and snapshots
//! remain raw bytes. Control payloads may contain UTF-8 JSON, but the frame
//! layer never turns a byte stream into a JSON number array.

use std::{error::Error, fmt};

pub const VERSION: u8 = 1;
pub const MAX_FRAME_BODY: usize = 8 * 1024 * 1024;
const FIXED_BODY: usize = 1 + 1 + 16 + 8;
const TOKEN_BYTES: usize = 32;
const NONCE_BYTES: usize = 32;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct SessionId(pub [u8; 16]);

impl SessionId {
    pub fn to_hex(self) -> String {
        let mut out = String::with_capacity(32);
        for byte in self.0 {
            use std::fmt::Write as _;
            let _ = write!(out, "{byte:02x}");
        }
        out
    }

    pub fn from_hex(value: &str) -> Result<Self, ProtocolError> {
        if value.len() != 32 {
            return Err(ProtocolError::InvalidSessionId);
        }
        let mut bytes = [0u8; 16];
        for (index, slot) in bytes.iter_mut().enumerate() {
            *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(|_| ProtocolError::InvalidSessionId)?;
        }
        Ok(Self(bytes))
    }
}

impl fmt::Debug for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SessionId(")?;
        for byte in self.0 {
            write!(f, "{byte:02x}")?;
        }
        write!(f, ")")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct AuthToken([u8; TOKEN_BYTES]);

impl AuthToken {
    pub const fn new(bytes: [u8; TOKEN_BYTES]) -> Self {
        Self(bytes)
    }

    pub fn hello_payload(&self, client_nonce: [u8; NONCE_BYTES]) -> Vec<u8> {
        let mut payload = Vec::with_capacity(TOKEN_BYTES + NONCE_BYTES);
        payload.extend_from_slice(&self.0);
        payload.extend_from_slice(&client_nonce);
        payload
    }

    fn matches(&self, candidate: &[u8]) -> bool {
        if candidate.len() != TOKEN_BYTES {
            return false;
        }
        let mut different = 0u8;
        for (expected, actual) in self.0.iter().zip(candidate) {
            different |= expected ^ actual;
        }
        different == 0
    }
}

impl fmt::Debug for AuthToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AuthToken([REDACTED])")
    }
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Hello = 1,
    Welcome = 2,
    Spawn = 3,
    Input = 4,
    Output = 5,
    Resize = 6,
    Attach = 7,
    Detach = 8,
    Snapshot = 9,
    Exit = 10,
    List = 11,
    Terminate = 12,
    KillAll = 13,
    Error = 14,
}

impl TryFrom<u8> for Kind {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::Hello),
            2 => Ok(Self::Welcome),
            3 => Ok(Self::Spawn),
            4 => Ok(Self::Input),
            5 => Ok(Self::Output),
            6 => Ok(Self::Resize),
            7 => Ok(Self::Attach),
            8 => Ok(Self::Detach),
            9 => Ok(Self::Snapshot),
            10 => Ok(Self::Exit),
            11 => Ok(Self::List),
            12 => Ok(Self::Terminate),
            13 => Ok(Self::KillAll),
            14 => Ok(Self::Error),
            other => Err(ProtocolError::UnknownKind(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: Kind,
    pub session_id: SessionId,
    pub generation: u64,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(kind: Kind, session_id: SessionId, generation: u64, payload: Vec<u8>) -> Self {
        Self {
            kind,
            session_id,
            generation,
            payload,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let body_len = FIXED_BODY
            .checked_add(self.payload.len())
            .ok_or(ProtocolError::FrameTooLarge(usize::MAX))?;
        if body_len > MAX_FRAME_BODY {
            return Err(ProtocolError::FrameTooLarge(body_len));
        }
        let mut out = Vec::with_capacity(4 + body_len);
        out.extend_from_slice(&(body_len as u32).to_be_bytes());
        out.push(VERSION);
        out.push(self.kind as u8);
        out.extend_from_slice(&self.session_id.0);
        out.extend_from_slice(&self.generation.to_be_bytes());
        out.extend_from_slice(&self.payload);
        Ok(out)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    FrameTooLarge(usize),
    FrameTooShort(usize),
    UnknownVersion(u8),
    UnknownKind(u8),
    Unauthorized,
    StaleGeneration { expected: u64, received: u64 },
    InvalidSessionId,
    Poisoned,
    AttachInProgress,
    NoAttachInProgress,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FrameTooLarge(n) => write!(f, "frame body is too large: {n}"),
            Self::FrameTooShort(n) => write!(f, "frame body is too short: {n}"),
            Self::UnknownVersion(v) => write!(f, "unsupported protocol version: {v}"),
            Self::UnknownKind(k) => write!(f, "unknown frame kind: {k}"),
            Self::Unauthorized => f.write_str("unauthorized helper connection"),
            Self::StaleGeneration { expected, received } => {
                write!(
                    f,
                    "stale generation: expected {expected}, received {received}"
                )
            }
            Self::InvalidSessionId => f.write_str("invalid helper session id"),
            Self::Poisoned => f.write_str("decoder rejected an earlier frame"),
            Self::AttachInProgress => f.write_str("an attach is already in progress"),
            Self::NoAttachInProgress => f.write_str("no attach is in progress"),
        }
    }
}

impl Error for ProtocolError {}

#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
    poisoned: bool,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, ProtocolError> {
        if self.poisoned {
            return Err(ProtocolError::Poisoned);
        }
        self.buffer.extend_from_slice(bytes);
        let decoded = self.decode_available();
        if decoded.is_err() {
            self.poisoned = true;
        }
        decoded
    }

    fn decode_available(&mut self) -> Result<Vec<Frame>, ProtocolError> {
        let mut frames = Vec::new();
        loop {
            if self.buffer.len() < 4 {
                break;
            }
            let body_len = u32::from_be_bytes(self.buffer[..4].try_into().unwrap()) as usize;
            if body_len < FIXED_BODY {
                return Err(ProtocolError::FrameTooShort(body_len));
            }
            if body_len > MAX_FRAME_BODY {
                return Err(ProtocolError::FrameTooLarge(body_len));
            }
            if self.buffer.len() < 4 + body_len {
                break;
            }
            let body = &self.buffer[4..4 + body_len];
            if body[0] != VERSION {
                return Err(ProtocolError::UnknownVersion(body[0]));
            }
            let kind = Kind::try_from(body[1])?;
            let mut session_id = [0u8; 16];
            session_id.copy_from_slice(&body[2..18]);
            let generation = u64::from_be_bytes(body[18..26].try_into().unwrap());
            frames.push(Frame {
                kind,
                session_id: SessionId(session_id),
                generation,
                payload: body[26..].to_vec(),
            });
            self.buffer.drain(..4 + body_len);
        }
        Ok(frames)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HandshakeState {
    Awaiting,
    Established,
    Rejected,
}

pub struct ServerHandshake {
    token: AuthToken,
    helper_nonce: [u8; NONCE_BYTES],
    capabilities: u64,
    state: HandshakeState,
}

impl ServerHandshake {
    pub fn new(token: AuthToken, helper_nonce: [u8; NONCE_BYTES], capabilities: u64) -> Self {
        Self {
            token,
            helper_nonce,
            capabilities,
            state: HandshakeState::Awaiting,
        }
    }

    /// Hello payload: 32-byte token followed by a 32-byte client nonce.
    /// Welcome payload: 32-byte helper nonce followed by u64 capabilities.
    pub fn accept(&mut self, frame: &Frame) -> Result<Frame, ProtocolError> {
        let authorized = self.state == HandshakeState::Awaiting
            && frame.kind == Kind::Hello
            && frame.payload.len() == TOKEN_BYTES + NONCE_BYTES
            && self.token.matches(&frame.payload[..TOKEN_BYTES]);
        if !authorized {
            self.state = HandshakeState::Rejected;
            return Err(ProtocolError::Unauthorized);
        }
        self.state = HandshakeState::Established;
        let mut payload = Vec::with_capacity(NONCE_BYTES + 8);
        payload.extend_from_slice(&self.helper_nonce);
        payload.extend_from_slice(&self.capabilities.to_be_bytes());
        Ok(Frame::new(Kind::Welcome, SessionId::default(), 0, payload))
    }
}

pub struct HandshakeDecoder {
    decoder: Decoder,
    handshake: ServerHandshake,
    rejected: bool,
}

impl HandshakeDecoder {
    pub fn new(token: AuthToken, helper_nonce: [u8; NONCE_BYTES], capabilities: u64) -> Self {
        Self {
            decoder: Decoder::new(),
            handshake: ServerHandshake::new(token, helper_nonce, capabilities),
            rejected: false,
        }
    }

    /// Decode the unauthenticated first frame without exposing why it was
    /// refused. Version, kind, framing, token, and ordering errors all have
    /// one outside shape: Unauthorized. A partial frame is not an error yet.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Option<Frame>, ProtocolError> {
        if self.rejected {
            return Err(ProtocolError::Unauthorized);
        }
        let frames = match self.decoder.push(bytes) {
            Ok(frames) => frames,
            Err(_) => {
                self.rejected = true;
                return Err(ProtocolError::Unauthorized);
            }
        };
        if frames.is_empty() {
            return Ok(None);
        }
        if frames.len() != 1 {
            self.rejected = true;
            return Err(ProtocolError::Unauthorized);
        }
        match self.handshake.accept(&frames[0]) {
            Ok(welcome) => Ok(Some(welcome)),
            Err(_) => {
                self.rejected = true;
                Err(ProtocolError::Unauthorized)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenerationGate {
    current: u64,
}

impl GenerationGate {
    pub fn new(current: u64) -> Self {
        Self { current }
    }

    pub fn advance(&mut self) -> u64 {
        self.current = self.current.saturating_add(1);
        self.current
    }

    pub fn check(&self, frame: &Frame) -> Result<(), ProtocolError> {
        if matches!(frame.kind, Kind::Input | Kind::Resize | Kind::Detach)
            && frame.generation != self.current
        {
            return Err(ProtocolError::StaleGeneration {
                expected: self.current,
                received: frame.generation,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(kind: Kind) -> Frame {
        Frame::new(kind, SessionId([7; 16]), 42, vec![0, 1, 0xff, b'\n'])
    }

    #[test]
    fn every_kind_round_trips_without_touching_payload_bytes() {
        let kinds = [
            Kind::Hello,
            Kind::Welcome,
            Kind::Spawn,
            Kind::Input,
            Kind::Output,
            Kind::Resize,
            Kind::Attach,
            Kind::Detach,
            Kind::Snapshot,
            Kind::Exit,
            Kind::List,
            Kind::Terminate,
            Kind::KillAll,
            Kind::Error,
        ];
        for kind in kinds {
            let expected = frame(kind);
            let encoded = expected.encode().unwrap();
            let got = Decoder::new().push(&encoded).unwrap();
            assert_eq!(got, vec![expected], "{kind:?} must round-trip");
        }
    }

    #[test]
    fn every_fragment_boundary_and_one_byte_chunks_decode_once() {
        let expected = frame(Kind::Output);
        let encoded = expected.encode().unwrap();
        for split in 0..=encoded.len() {
            let mut decoder = Decoder::new();
            let mut got = decoder.push(&encoded[..split]).unwrap();
            got.extend(decoder.push(&encoded[split..]).unwrap());
            assert_eq!(got, vec![expected.clone()], "split {split}");
        }
        let mut decoder = Decoder::new();
        let mut got = Vec::new();
        for byte in &encoded {
            got.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(got, vec![expected]);
    }

    #[test]
    fn glued_frames_decode_in_order() {
        let a = frame(Kind::Input);
        let b = frame(Kind::Output);
        let mut bytes = a.encode().unwrap();
        bytes.extend(b.encode().unwrap());
        assert_eq!(Decoder::new().push(&bytes).unwrap(), vec![a, b]);
    }

    #[test]
    fn malformed_frame_poisons_the_decoder() {
        let mut too_large = Decoder::new();
        let prefix = ((MAX_FRAME_BODY + 1) as u32).to_be_bytes();
        assert_eq!(
            too_large.push(&prefix),
            Err(ProtocolError::FrameTooLarge(MAX_FRAME_BODY + 1))
        );
        assert_eq!(too_large.push(&[]), Err(ProtocolError::Poisoned));

        let mut too_short = Decoder::new();
        assert_eq!(
            too_short.push(&(25u32).to_be_bytes()),
            Err(ProtocolError::FrameTooShort(25))
        );

        let encoded = frame(Kind::List).encode().unwrap();
        let mut bad_version = encoded.clone();
        bad_version[4] = VERSION + 1;
        assert!(matches!(
            Decoder::new().push(&bad_version),
            Err(ProtocolError::UnknownVersion(_))
        ));
        let mut bad_kind = encoded;
        bad_kind[5] = 0xff;
        assert_eq!(
            Decoder::new().push(&bad_kind),
            Err(ProtocolError::UnknownKind(0xff))
        );
    }

    #[test]
    fn oversized_payload_is_refused_before_allocation() {
        let oversized = Frame::new(
            Kind::Output,
            SessionId::default(),
            0,
            vec![0; MAX_FRAME_BODY - FIXED_BODY + 1],
        );
        assert!(matches!(
            oversized.encode(),
            Err(ProtocolError::FrameTooLarge(_))
        ));
    }

    #[test]
    fn handshake_reveals_nothing_on_any_bad_first_frame() {
        let token = AuthToken::new([0x5a; 32]);
        let hello = Frame::new(
            Kind::Hello,
            SessionId::default(),
            0,
            [vec![0x5a; 32], vec![0x11; 32]].concat(),
        );
        let mut ok = ServerHandshake::new(token, [0x22; 32], 0x1234);
        let welcome = ok.accept(&hello).unwrap();
        assert_eq!(welcome.kind, Kind::Welcome);
        assert_eq!(&welcome.payload[..32], &[0x22; 32]);
        assert_eq!(
            u64::from_be_bytes(welcome.payload[32..].try_into().unwrap()),
            0x1234
        );
        assert_eq!(ok.accept(&hello), Err(ProtocolError::Unauthorized));

        for bad in [
            Frame::new(Kind::List, SessionId::default(), 0, Vec::new()),
            Frame::new(Kind::Hello, SessionId::default(), 0, vec![0; 64]),
            Frame::new(Kind::Hello, SessionId::default(), 0, vec![0x5a; 31]),
        ] {
            let mut server = ServerHandshake::new(token, [3; 32], 0);
            assert_eq!(server.accept(&bad), Err(ProtocolError::Unauthorized));
        }
        let debug = format!("{token:?}");
        assert_eq!(debug, "AuthToken([REDACTED])");
        assert!(!debug.contains("5a"));
    }

    #[test]
    fn unauthenticated_wire_errors_have_one_outside_shape() {
        let token = AuthToken::new([0x5a; 32]);
        let hello = Frame::new(
            Kind::Hello,
            SessionId::default(),
            0,
            [vec![0x5a; 32], vec![0x11; 32]].concat(),
        )
        .encode()
        .unwrap();

        let mut partial = HandshakeDecoder::new(token, [2; 32], 0);
        assert_eq!(partial.push(&hello[..3]), Ok(None));
        assert!(partial.push(&hello[3..]).unwrap().is_some());

        let mut wrong_version = hello.clone();
        wrong_version[4] = VERSION + 1;
        let mut server = HandshakeDecoder::new(token, [2; 32], 0);
        assert_eq!(
            server.push(&wrong_version),
            Err(ProtocolError::Unauthorized)
        );
        assert_eq!(server.push(&hello), Err(ProtocolError::Unauthorized));

        let mut wrong_kind = hello.clone();
        wrong_kind[5] = 0xff;
        let mut server = HandshakeDecoder::new(token, [2; 32], 0);
        assert_eq!(server.push(&wrong_kind), Err(ProtocolError::Unauthorized));

        let mut two = hello.clone();
        two.extend_from_slice(&hello);
        let mut server = HandshakeDecoder::new(token, [2; 32], 0);
        assert_eq!(server.push(&two), Err(ProtocolError::Unauthorized));
    }

    #[test]
    fn generation_gate_rejects_stale_mutating_frames() {
        let gate = GenerationGate::new(9);
        for kind in [Kind::Input, Kind::Resize, Kind::Detach] {
            let current = Frame::new(kind, SessionId::default(), 9, vec![]);
            assert_eq!(gate.check(&current), Ok(()));
            let stale = Frame::new(kind, SessionId::default(), 8, vec![]);
            assert!(matches!(
                gate.check(&stale),
                Err(ProtocolError::StaleGeneration {
                    expected: 9,
                    received: 8
                })
            ));
        }
        let old_output = Frame::new(Kind::Output, SessionId::default(), 1, vec![]);
        assert_eq!(gate.check(&old_output), Ok(()));
    }
}
