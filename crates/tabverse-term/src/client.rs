//! Reconnecting GUI-side client for the resident terminal helper.

use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

use crate::{
    protocol::{AuthToken, Frame, Kind, SessionId},
    transport::{FrameSender, FramedStream, TransportError},
};

pub type HelperEventCallback = Arc<dyn Fn(Frame) + Send + Sync + 'static>;

struct Pending {
    expected: Kind,
    session: Option<SessionId>,
    answer: mpsc::Sender<Frame>,
}

pub struct HelperClient {
    sender: FrameSender,
    pending: Arc<Mutex<Option<Pending>>>,
    request_lock: Mutex<()>,
    alive: Arc<AtomicBool>,
    reader: Mutex<Option<thread::JoinHandle<()>>>,
}

impl HelperClient {
    pub fn connect(
        endpoint: SocketAddr,
        token: AuthToken,
        client_nonce: [u8; 32],
        on_event: HelperEventCallback,
    ) -> Result<(Self, u64, [u8; 32]), TransportError> {
        let mut framed = FramedStream::connect(endpoint, Duration::from_secs(3))?;
        framed.set_read_timeout(Some(Duration::from_secs(5)))?;
        let (capabilities, helper_nonce) = framed.authenticate_client(token, client_nonce)?;
        framed.set_read_timeout(None)?;
        let sender = framed.sender()?;
        let pending = Arc::new(Mutex::new(None::<Pending>));
        let reader_pending = Arc::clone(&pending);
        let alive = Arc::new(AtomicBool::new(true));
        let reader_alive = Arc::clone(&alive);
        let reader = thread::Builder::new()
            .name("tabverse-helper-reader".into())
            .spawn(move || {
                while let Ok(frame) = framed.recv() {
                    let delivered = {
                        let mut pending = reader_pending.lock().unwrap();
                        let matches = pending.as_ref().is_some_and(|waiting| {
                            frame.kind == Kind::Error
                                || (frame.kind == waiting.expected
                                    && waiting
                                        .session
                                        .is_none_or(|session| frame.session_id == session))
                        });
                        if matches {
                            let waiting = pending.take().unwrap();
                            let _ = waiting.answer.send(frame.clone());
                            true
                        } else {
                            false
                        }
                    };
                    if !delivered {
                        on_event(frame);
                    }
                }
                reader_alive.store(false, Ordering::Release);
                // Wake a request immediately rather than making it spend its
                // whole timeout after the socket has already gone.
                if let Some(waiting) = reader_pending.lock().unwrap().take() {
                    let _ = waiting.answer.send(Frame::new(
                        Kind::Error,
                        SessionId::default(),
                        0,
                        b"disconnected".to_vec(),
                    ));
                }
            })?;

        Ok((
            Self {
                sender,
                pending,
                request_lock: Mutex::new(()),
                alive,
                reader: Mutex::new(Some(reader)),
            },
            capabilities,
            helper_nonce,
        ))
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn send(&self, frame: &Frame) -> Result<(), TransportError> {
        if !self.is_alive() {
            return Err(TransportError::Closed);
        }
        self.sender.send(frame)
    }

    pub fn request(
        &self,
        frame: &Frame,
        expected: Kind,
        session: Option<SessionId>,
        timeout: Duration,
    ) -> Result<Frame, TransportError> {
        let _one_request = self.request_lock.lock().unwrap();
        if !self.is_alive() {
            return Err(TransportError::Closed);
        }
        let (tx, rx) = mpsc::channel();
        *self.pending.lock().unwrap() = Some(Pending {
            expected,
            session,
            answer: tx,
        });
        if let Err(error) = self.sender.send(frame) {
            self.pending.lock().unwrap().take();
            return Err(error);
        }
        match rx.recv_timeout(timeout) {
            Ok(answer) if answer.kind == Kind::Error => Err(TransportError::Remote(
                String::from_utf8_lossy(&answer.payload).into_owned(),
            )),
            Ok(answer) => Ok(answer),
            Err(_) => {
                self.pending.lock().unwrap().take();
                Err(TransportError::Io(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "helper request timed out",
                )))
            }
        }
    }

    pub fn close(&self) {
        self.sender.shutdown();
        self.alive.store(false, Ordering::Release);
    }
}

impl Drop for HelperClient {
    fn drop(&mut self) {
        self.close();
        if let Some(reader) = self.reader.lock().unwrap().take() {
            let _ = reader.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::helper::HelperServer;
    use crate::protocol::ProtocolError;

    const TOKEN: AuthToken = AuthToken::new([0x61; 32]);

    #[test]
    fn request_answers_are_not_confused_with_async_events() {
        let mut server = HelperServer::start(TOKEN, [7; 32], 11, Duration::from_secs(5)).unwrap();
        let (event_tx, event_rx) = mpsc::channel();
        let (client, capabilities, nonce) = HelperClient::connect(
            server.endpoint(),
            TOKEN,
            [8; 32],
            Arc::new(move |frame| {
                let _ = event_tx.send(frame);
            }),
        )
        .unwrap();
        assert_eq!(capabilities, 11);
        assert_eq!(nonce, [7; 32]);

        let spawn = serde_json::json!({
            "shell": if cfg!(windows) { "powershell.exe" } else { "/bin/sh" },
            "cols": 80,
            "rows": 24,
            "shell_integration": false
        });
        let spawned = client
            .request(
                &Frame::new(
                    Kind::Spawn,
                    SessionId::default(),
                    0,
                    serde_json::to_vec(&spawn).unwrap(),
                ),
                Kind::Spawn,
                None,
                Duration::from_secs(3),
            )
            .unwrap();
        assert_ne!(spawned.session_id, SessionId::default());

        client
            .send(&Frame::new(
                Kind::Input,
                spawned.session_id,
                spawned.generation,
                if cfg!(windows) {
                    b"Write-Output CLIENT-EVENT\r\n".to_vec()
                } else {
                    b"printf 'CLIENT-EVENT\\n'\n".to_vec()
                },
            ))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut seen = Vec::new();
        while std::time::Instant::now() < deadline {
            if let Ok(frame) = event_rx.recv_timeout(Duration::from_millis(100)) {
                if frame.kind == Kind::Output {
                    seen.extend_from_slice(&frame.payload);
                    if seen.windows(12).any(|w| w == b"CLIENT-EVENT") {
                        break;
                    }
                }
            }
        }
        assert!(seen.windows(12).any(|w| w == b"CLIENT-EVENT"));

        let listed = client
            .request(
                &Frame::new(Kind::List, SessionId::default(), 0, vec![]),
                Kind::List,
                None,
                Duration::from_secs(2),
            )
            .unwrap();
        assert!(String::from_utf8_lossy(&listed.payload).contains("generation"));
        client
            .request(
                &Frame::new(
                    Kind::Terminate,
                    spawned.session_id,
                    spawned.generation,
                    vec![],
                ),
                Kind::Terminate,
                Some(spawned.session_id),
                Duration::from_secs(2),
            )
            .unwrap();
        client.close();
        server.stop();
    }

    #[test]
    fn a_wrong_token_never_starts_the_reader() {
        let mut server = HelperServer::start(TOKEN, [9; 32], 0, Duration::from_secs(5)).unwrap();
        let result = HelperClient::connect(
            server.endpoint(),
            AuthToken::new([0x62; 32]),
            [1; 32],
            Arc::new(|_| {}),
        );
        assert!(matches!(
            result,
            Err(TransportError::Protocol(ProtocolError::Unauthorized))
        ));
        server.stop();
    }
}
