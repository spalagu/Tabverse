//! Blocking loopback transport for the resident terminal helper.
//!
//! Authentication, not an OS-specific pathname, is the trust boundary. The
//! listener binds only 127.0.0.1 and uses the same framed stream on Unix and
//! Windows, so both platforms exercise one black-box transport contract.

use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::protocol::{AuthToken, Decoder, Frame, Kind, ProtocolError, ServerHandshake, SessionId};

pub struct FramedStream {
    stream: TcpStream,
    decoder: Decoder,
    pending: VecDeque<Frame>,
}

impl FramedStream {
    pub fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            decoder: Decoder::new(),
            pending: VecDeque::new(),
        }
    }

    pub fn connect(endpoint: SocketAddr, timeout: Duration) -> io::Result<Self> {
        let stream = TcpStream::connect_timeout(&endpoint, timeout)?;
        stream.set_nodelay(true)?;
        Ok(Self::new(stream))
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.stream.set_read_timeout(timeout)
    }

    pub fn authenticate_client(
        &mut self,
        token: AuthToken,
        client_nonce: [u8; 32],
    ) -> Result<(u64, [u8; 32]), TransportError> {
        self.send(&Frame::new(
            Kind::Hello,
            SessionId::default(),
            0,
            token.hello_payload(client_nonce),
        ))?;
        let answer = self.recv()?;
        if answer.kind != Kind::Welcome || answer.payload.len() != 40 {
            return Err(ProtocolError::Unauthorized.into());
        }
        let mut helper_nonce = [0u8; 32];
        helper_nonce.copy_from_slice(&answer.payload[..32]);
        let capabilities = u64::from_be_bytes(answer.payload[32..].try_into().unwrap());
        Ok((capabilities, helper_nonce))
    }

    pub fn authenticate_server(
        &mut self,
        token: AuthToken,
        helper_nonce: [u8; 32],
        capabilities: u64,
    ) -> Result<(), TransportError> {
        let first = self.recv();
        let welcome = first.and_then(|frame| {
            ServerHandshake::new(token, helper_nonce, capabilities)
                .accept(&frame)
                .map_err(TransportError::from)
        });
        match welcome {
            Ok(welcome) => self.send(&welcome),
            Err(_) => {
                // Every unauthenticated failure has one observable shape.
                // The server's decoder may know whether framing, version,
                // kind, or token was wrong; the peer learns none of it.
                let _ = self.send(&Frame::new(
                    Kind::Error,
                    SessionId::default(),
                    0,
                    b"unauthorized".to_vec(),
                ));
                Err(ProtocolError::Unauthorized.into())
            }
        }
    }

    pub fn sender(&self) -> io::Result<FrameSender> {
        Ok(FrameSender {
            stream: Arc::new(Mutex::new(self.stream.try_clone()?)),
        })
    }

    pub fn send(&mut self, frame: &Frame) -> Result<(), TransportError> {
        let encoded = frame.encode()?;
        self.stream.write_all(&encoded)?;
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
            let frames = self.decoder.push(&chunk[..count])?;
            self.pending.extend(frames);
            if let Some(frame) = self.pending.pop_front() {
                return Ok(frame);
            }
        }
    }

    pub fn into_inner(self) -> TcpStream {
        self.stream
    }
}

#[derive(Clone)]
pub struct FrameSender {
    stream: Arc<Mutex<TcpStream>>,
}

impl FrameSender {
    pub fn shutdown(&self) {
        if let Ok(stream) = self.stream.lock() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    pub fn send(&self, frame: &Frame) -> Result<(), TransportError> {
        let encoded = frame.encode()?;
        let mut stream = self.stream.lock().unwrap();
        stream.write_all(&encoded)?;
        stream.flush()?;
        Ok(())
    }
}

#[derive(Debug)]
pub enum TransportError {
    Io(io::Error),
    Protocol(ProtocolError),
    Remote(String),
    Closed,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "helper transport I/O failed: {error}"),
            Self::Protocol(error) => write!(f, "helper protocol failed: {error}"),
            Self::Remote(error) => write!(f, "helper refused the request: {error}"),
            Self::Closed => f.write_str("helper transport closed"),
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
    use crate::protocol::{Kind, SessionId};
    use std::net::TcpListener;

    #[test]
    fn framed_stream_crosses_a_real_loopback_socket_in_both_directions() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, peer) = listener.accept().unwrap();
            assert!(peer.ip().is_loopback());
            let mut framed = FramedStream::new(stream);
            let input = framed.recv().unwrap();
            assert_eq!(input.kind, Kind::Input);
            assert_eq!(input.payload, vec![0, 0xff, b'\n']);
            framed
                .send(&Frame::new(
                    Kind::Output,
                    input.session_id,
                    input.generation,
                    input.payload,
                ))
                .unwrap();
        });

        let mut client = FramedStream::connect(endpoint, Duration::from_secs(2)).unwrap();
        let session = SessionId([9; 16]);
        client
            .send(&Frame::new(Kind::Input, session, 4, vec![0, 0xff, b'\n']))
            .unwrap();
        let output = client.recv().unwrap();
        assert_eq!(
            output,
            Frame::new(Kind::Output, session, 4, vec![0, 0xff, b'\n'])
        );
        server.join().unwrap();
    }
}
